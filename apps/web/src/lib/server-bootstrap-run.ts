// Runs the server bootstrap (lib/server-bootstrap.ts) over SSH. `check` is
// read-only; `apply` re-checks first and runs only the planned steps the
// caller confirmed. The last result per server is cached in-process so the
// first-run checklist never opens SSH on a page load.
import { randomBytes } from 'node:crypto'
import {
	TRAEFIK_DYNAMIC_DIR,
	checkFileProviderFromInspect,
	fileProviderFromYml,
} from './domain-redirects'
import {
	type BootstrapFacts,
	type BootstrapPlan,
	type BootstrapProxy,
	type CheckItem,
	type StepId,
	checkItems,
	isCheckGreen,
	parseCheckOutput,
	planApply,
	renderCheckScript,
} from './server-bootstrap'
import { HELPER_BIN_DIR, PER_SERVER_HELPERS } from './server-bootstrap'
import { shippedHelper, shippedHelperShas } from './server-helpers'
import { type ServerConfig, type ServerRecord, saveServerCheck } from './servers'
import { shq } from './shell'
import { runCommand, writeFileViaSftp } from './ssh'

export interface BootstrapCheckResult {
	serverId: string
	// servers.proxy at check time: items and plan depend on it.
	proxy: BootstrapProxy
	at: string
	facts: BootstrapFacts
	items: CheckItem[]
	green: boolean
	plan: BootstrapPlan
}

export interface BootstrapStepResult {
	id: StepId
	title: string
	ok: boolean
	output: string
}

const g = globalThis as { __powderBootstrapCache?: Map<string, BootstrapCheckResult> }
function cache(): Map<string, BootstrapCheckResult> {
	if (!g.__powderBootstrapCache) g.__powderBootstrapCache = new Map()
	return g.__powderBootstrapCache
}

/** Green/red of the last check for the server's current proxy: the in-process
 *  result, else the persisted one (survives restarts). null = never checked. */
export function lastCheckGreen(
	server: Pick<ServerRecord, 'id' | 'proxy' | 'lastCheck'>,
): boolean | null {
	const proxy: BootstrapProxy = server.proxy ?? 'nginx'
	const hit = cachedBootstrapCheck(server.id, proxy)
	if (hit) return hit.green
	return server.lastCheck && server.lastCheck.proxy === proxy ? server.lastCheck.green : null
}

/** Re-check when the last check is older than this (background, on sync). */
export const CHECK_STALE_MS = 24 * 60 * 60 * 1000

export function checkIsStale(
	server: Pick<ServerRecord, 'id' | 'proxy' | 'lastCheck'>,
	now = Date.now(),
): boolean {
	const proxy: BootstrapProxy = server.proxy ?? 'nginx'
	if (cachedBootstrapCheck(server.id, proxy)) return false
	const last = server.lastCheck
	return !last || last.proxy !== proxy || now - last.at.getTime() > CHECK_STALE_MS
}

/** Cached result, dropped when the server's proxy changed since. */
export function cachedBootstrapCheck(
	serverId: string,
	proxy: BootstrapProxy,
): BootstrapCheckResult | null {
	const hit = cache().get(serverId)
	return hit && hit.proxy === proxy ? hit : null
}

type InspectArg = Parameters<typeof checkFileProviderFromInspect>[0]

async function fileProviderState(
	server: ServerConfig,
	inspectJson: string,
): Promise<BootstrapFacts['traefikFileProvider']> {
	let inspect: InspectArg
	try {
		inspect = (JSON.parse(inspectJson) as InspectArg[])[0] ?? {}
	} catch {
		return 'missing'
	}
	const check = checkFileProviderFromInspect(inspect)
	if (check.state === 'ok') return 'ok'
	if (check.state === 'need-config') {
		const cat = await runCommand(server, `cat ${shq(check.configHostPath)}`, 10_000)
		if (cat.code === 0 && fileProviderFromYml(cat.stdout, inspect)) return 'ok'
	}
	return 'missing'
}

const inflight = globalThis as {
	__powderBootstrapInflight?: Map<string, Promise<BootstrapCheckResult>>
	__powderBootstrapAttempts?: Map<string, number>
}
function inflightMap(): Map<string, Promise<BootstrapCheckResult>> {
	if (!inflight.__powderBootstrapInflight) inflight.__powderBootstrapInflight = new Map()
	return inflight.__powderBootstrapInflight
}
function attempts(): Map<string, number> {
	if (!inflight.__powderBootstrapAttempts) inflight.__powderBootstrapAttempts = new Map()
	return inflight.__powderBootstrapAttempts
}

/** After a background attempt (failed or not), wait this long before the next one. */
export const BACKGROUND_RETRY_MS = 10 * 60 * 1000

/** Runs the read-only check. Concurrent calls for one server share one SSH run.
 *  `fresh`: the caller just changed the server (apply) or needs the current proxy, so
 *  wait out a running check and start a new one instead of reusing it. */
export async function runBootstrapCheck(
	server: ServerConfig,
	opts: { fresh?: boolean } = {},
): Promise<BootstrapCheckResult> {
	if (opts.fresh) {
		await inflightMap()
			.get(server.id)
			?.catch(() => null)
		return runBootstrapCheck(server)
	}
	const running = inflightMap().get(server.id)
	if (running) return running
	attempts().set(server.id, Date.now())
	const p = runBootstrapCheckNow(server).finally(() => inflightMap().delete(server.id))
	inflightMap().set(server.id, p)
	return p
}

/** Sync path: re-check in the background only when the result is stale, no check
 *  is running, and the last attempt (a failed one too) is not recent. */
export function maybeBackgroundCheck(
	server: ServerConfig & Pick<ServerRecord, 'lastCheck'>,
	now = Date.now(),
): Promise<BootstrapCheckResult> | null {
	if (!checkIsStale(server, now)) return null
	if (inflightMap().has(server.id)) return null
	const last = attempts().get(server.id)
	if (last !== undefined && now - last < BACKGROUND_RETRY_MS) return null
	return runBootstrapCheck(server)
}

async function runBootstrapCheckNow(server: ServerConfig): Promise<BootstrapCheckResult> {
	const res = await runCommand(server, renderCheckScript(shq(TRAEFIK_DYNAMIC_DIR)), 30_000)
	if (res.code !== 0 && !res.stdout.includes('uid=')) {
		throw new Error(res.stderr.trim() || `check failed (exit ${res.code})`)
	}
	const { facts: partial, inspectJson } = parseCheckOutput(res.stdout)
	const facts: BootstrapFacts = {
		...partial,
		traefikFileProvider:
			partial.traefik === 'absent' ? 'n/a' : await fileProviderState(server, inspectJson),
	}
	// No column value on a hand-built config = the DB default, nginx.
	const proxy: BootstrapProxy = server.proxy ?? 'nginx'
	const shipped = shippedHelperShas()
	const items = checkItems(facts, TRAEFIK_DYNAMIC_DIR, proxy, shipped)
	const result: BootstrapCheckResult = {
		serverId: server.id,
		proxy,
		at: new Date().toISOString(),
		facts,
		items,
		green: isCheckGreen(items),
		plan: planApply(facts, shq(TRAEFIK_DYNAMIC_DIR), proxy, shipped),
	}
	cache().set(server.id, result)
	// Best effort: a failed write only means the next restart shows it unchecked.
	await saveServerCheck(server.id, { green: result.green, proxy, at: new Date(result.at) }).catch(
		(err) => console.warn(`[server-check] could not save result for ${server.id}`, err),
	)
	return result
}

// Docker's apt install can take minutes on a slow mirror.
const STEP_TIMEOUT_MS: Partial<Record<StepId, number>> = { 'install-docker': 600_000 }

/**
 * Re-checks, then runs the planned steps whose id the operator confirmed, in
 * plan order. Stops at the first failure. A step that is no longer planned
 * (fixed meanwhile, or now unsafe) is not run even if confirmed.
 */
export async function runBootstrapApply(
	server: ServerConfig,
	confirmed: StepId[],
): Promise<{ steps: BootstrapStepResult[]; after: BootstrapCheckResult }> {
	const before = await runBootstrapCheck(server, { fresh: true })
	const want = new Set(confirmed)
	const results: BootstrapStepResult[] = []
	for (const step of before.plan.steps) {
		if (!want.has(step.id)) continue
		let ok = false
		let output = ''
		try {
			const r = step.helper
				? await installHelper(server, step.helper, step.command)
				: await runCommand(server, step.command, STEP_TIMEOUT_MS[step.id] ?? 60_000)
			ok = r.code === 0
			output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim().slice(-4000)
		} catch (err) {
			output = err instanceof Error ? err.message : 'unknown error'
		}
		results.push({ id: step.id, title: step.title, ok, output })
		if (!ok) break
	}
	const after = await runBootstrapCheck(server, { fresh: true })
	return { steps: results, after }
}

/** A helper step: write the image's copy to a fresh temp file next to the
 *  destination over SFTP (exclusive create, 0700), then run the step's command
 *  with T set; that command checks the sha256 and moves it into place. The plan's
 *  sha must still be the shipped one (the image cannot change under a running
 *  process, but the plan text is what the operator confirmed). */
export async function installHelper(
	server: ServerConfig,
	key: NonNullable<BootstrapPlan['steps'][number]['helper']>,
	command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const h = PER_SERVER_HELPERS.find((x) => x.key === key)
	const shipped = shippedHelper(key)
	if (!h || !shipped)
		return { stdout: '', stderr: 'this powder has no copy of the helper', code: 1 }
	if (!command.startsWith(`S=${shipped.sha256}\n`)) {
		return {
			stdout: '',
			stderr: 'the helper changed since the check; run check server again',
			code: 1,
		}
	}
	const rand = randomBytes(8).toString('hex')
	const tmp = `${HELPER_BIN_DIR}/.${h.bin}.${rand}`
	const mk = await runCommand(server, `mkdir -p ${shq(HELPER_BIN_DIR)}`, 10_000)
	if (mk.code !== 0) return mk
	try {
		await writeFileViaSftp(server, tmp, shipped.content, 0o700, 30_000, true, true)
	} catch (err) {
		await runCommand(server, `rm -f ${shq(tmp)}`, 5_000).catch(() => {})
		throw err
	}
	return runCommand(server, `T=${shq(tmp)}\n${command}`, 30_000)
}
