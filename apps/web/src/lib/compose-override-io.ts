import { gitCmd, gitHardenShellFunctions } from './git-harden'
import { atomicWriteShell } from './repo-symlinks'
import { checkComposeSafe } from './compose-guard'
import {
	composeVersionOk,
	labelLinesFromBlock,
	inProjectOverridePathFor,
	overrideDirFor,
	overridePathFor,
	parseOverrideLabels,
	planPorts,
	renderOverride,
} from './compose-override'
import { composeFileArgs, readComposeConfig } from './deploy/fragments'
import type { ServerConfig } from './servers'
import { shq } from './shell'
import { ALL_PROFILES } from './deploy/compose-hash'
import { runCommand, writeFileViaSftp } from './ssh'
import { randomTempPath } from './temp-path'

/** The override broke the compose safety check the user's own file passed; the previous
 *  override was put back. The only failure that must stop a deploy. */
export class UnsafeOverrideError extends Error {}

/** the user's compose parses on its own but not with powder's override merged in
 *  (the previous override was restored). Deploys refuse on this one: going on would run
 *  the app without the protections the override carries (loopback ports, NET_RAW drop). */
export class OverrideMergeError extends Error {}

export interface OverrideFacts {
	workingDir: string
	configFile: string
	composeFiles?: string[]
	service: string
}

export interface OverrideResult {
	/** The override file content changed (or was removed/created). */
	changed: boolean
	/** Deploy-output lines: `[ports] ...`, `left public: ...`. */
	log: string
}

/**
 * THE writer of `<workdir>/docker-compose.powder.yml`. Idempotent: the same inputs
 * produce the same bytes and no write. `labels`:
 *   - string[]  the app service's labels (from renderLabelsBlock)
 *   - null      no labels (drop any previous ones)
 *   - undefined keep the labels already in the override (port-only callers)
 * Ports are always recomputed from the RESOLVED user config. Never touches the user's file.
 */
export async function applyComposeOverride(
	server: ServerConfig,
	facts: OverrideFacts,
	opts: { labels?: string[] | null; appName: string; requireConfig?: boolean },
): Promise<OverrideResult> {
	const userArgs = composeFileArgs(facts.configFile, facts.composeFiles, { override: false })
	const allArgs = composeFileArgs(facts.configFile, facts.composeFiles)
	const dest = overridePathFor(facts.configFile, facts.composeFiles)

	const config = await readComposeConfig(server, userArgs)
	if (config === null) {
		if (opts.requireConfig) throw new Error('compose config does not parse (docker compose config failed)')
		return { changed: false, log: '[ports] compose config unreadable, override skipped\n' }
	}

	const ver = await runCommand(server, 'docker compose version --short 2>/dev/null', 10_000).catch(() => null)
	const allowOverride = ver ? composeVersionOk(ver.stdout) : false

	// powder never writes the override INSIDE the project dir (in the workdir layout that
	// is the checkout). Drop an untracked copy there; a tracked one is the repo's and the
	// deploy refuses it.
	const inProject = inProjectOverridePathFor(facts.configFile, facts.composeFiles)
	await runCommand(
		server,
		`${gitHardenShellFunctions()}if [ -e ${shq(inProject)} ] || [ -L ${shq(inProject)} ]; then if [ -z "$(${gitCmd(shq('*'), shq(facts.workingDir))} ls-files -- docker-compose.powder.yml 2>/dev/null)" ]; then rm -f ${shq(inProject)}; fi; fi`,
		10_000,
	).catch(() => {})
	const prev = await runCommand(server, `cat ${shq(dest)} 2>/dev/null`, 10_000)
	const prevText = prev.code === 0 && prev.stdout.length > 0 ? prev.stdout : null

	const labels = opts.labels === undefined ? parseOverrideLabels(prevText, facts.service) : opts.labels
	const plan = planPorts(config, facts.service, { allowOverride })
	// every service of the user's compose gets cap_drop NET_RAW.
	const services = Object.keys(
		((config as { services?: Record<string, unknown> }).services ?? {}) as Record<string, unknown>,
	).filter((n) => /^[A-Za-z0-9._-]+$/.test(n))
	// every service with a build section is pinned pull_policy: never, except one
	// whose own policy is `build` (rebuilt on every deploy, never pulled) or already `never`.
	const svcDefs = ((config as { services?: Record<string, unknown> }).services ?? {}) as Record<string, unknown>
	const buildServices = services.filter((n) => {
		const d = svcDefs[n] as { build?: unknown; pull_policy?: unknown } | undefined
		if (!d || typeof d !== 'object' || d.build === undefined || d.build === null) return false
		const pp = typeof d.pull_policy === 'string' ? d.pull_policy.trim() : ''
		return pp !== 'build' && pp !== 'never'
	})
	const next = renderOverride({ service: facts.service, labels, ports: plan.overrides, services, buildServices })
	const log = plan.notes.join('\n') + '\n'

	if (next === prevText || (next === null && prevText === null)) return { changed: false, log }

	if (next === null) {
		await runCommand(server, `rm -f ${shq(dest)}`, 10_000)
		return { changed: true, log }
	}

	const mk = await runCommand(server, `[ ! -L ${shq(overrideDirFor(facts.configFile, facts.composeFiles))} ] && install -d -m 0755 ${shq(overrideDirFor(facts.configFile, facts.composeFiles))}`, 10_000)
	if (mk.code !== 0) throw new Error(mk.stderr || 'could not create the compose override dir')
	const tmp = randomTempPath(dest)
	const restore = async () => {
		if (prevText === null) {
			await runCommand(server, `rm -f ${shq(dest)} ${shq(tmp)}`, 10_000).catch(() => {})
			return
		}
		const back = `${tmp}.back`
		await writeFileViaSftp(server, back, prevText, 0o644, 30_000, true, true)
		await runCommand(server, `${atomicWriteShell(dest, back)} && chmod 644 ${shq(dest)}`, 10_000).catch(() => {})
	}
	await writeFileViaSftp(server, tmp, next, 0o644, 30_000, true, true)
	const wrote = await runCommand(server, `${atomicWriteShell(dest, tmp)} && chmod 644 ${shq(dest)}`, 10_000)
	if (wrote.code !== 0) {
		await runCommand(server, `rm -f ${shq(tmp)}`, 10_000).catch(() => {})
		throw new Error(wrote.stderr || wrote.stdout || 'could not write the compose override')
	}

	// The merged config must still parse, and must not be less safe than the user's own file.
	const merged = await runCommand(server, `docker compose ${allArgs} ${ALL_PROFILES} config 2>&1`, 30_000)
	if (merged.code !== 0) {
		await restore()
		throw new OverrideMergeError(`compose override produced an INVALID compose config - restored the previous one: ${merged.stdout.slice(0, 300)}`)
	}
	const base = await runCommand(server, `docker compose ${userArgs} ${ALL_PROFILES} config 2>/dev/null`, 30_000)
	if (base.code === 0) {
		const reason = checkComposeSafe(merged.stdout, opts.appName) && !checkComposeSafe(base.stdout, opts.appName)
			? checkComposeSafe(merged.stdout, opts.appName)
			: null
		if (reason) {
			await restore()
			throw new UnsafeOverrideError(`compose override is unsafe (${reason}); restored the previous one`)
		}
	}
	return { changed: true, log }
}

/** Labels (without the list dash) from a renderLabelsBlock() block. */
export const labelsFromBlock = labelLinesFromBlock
