// Guard for the secret-egress CLASS (root-cause-first step 4): one corpus of
// credential shapes pushed through the real deploy failure fan-out and every
// reader of the stored rows. db, fetch and ssh are stubbed; everything between
// them (deploy-runner, deploy-failure, deploys.finishDeploy, deploy-bus, hq,
// notifications, github-deployments, the rollback route, the REST routes, the
// MCP tools, the activity mapper, the agent prompt) is the real code.
//
// The invariant: no fixture secret appears in ANY captured DB write, SSE event,
// outbound HTTP body or read-sink response. Read sinks are fed the rows the
// write phase actually stored, so they are clean exactly when write-time
// masking is.
//
// KNOWN_LEAKS lists sinks that still leak; each runs as `it.fails`, so the
// suite stays green while the leak exists and turns red the moment the leak is
// fixed and the entry is not removed. The set may only shrink.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FX, SECRET_FIXTURES, corpusLog, leakedIn } from './fixtures/secret-corpus'

vi.mock('server-only', () => ({}))

// ── fake db: records every write, serves the rows those writes produced ─────
const H = vi.hoisted(() => {
	type Row = Record<string, unknown>
	const state = {
		writes: [] as { sink: string; table: string; value: Row }[],
		deploys: new Map<string, Row>(),
		repo: null as Row | null,
		sink: 'unset',
	}
	return { state }
})

vi.mock('../db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const { state } = H
	type Row = Record<string, unknown>
	type Cond = { op: string; col?: { name?: string }; val?: unknown; parts?: Cond[] }
	const eq = (col: unknown, val: unknown): Cond => ({ op: 'eq', col: col as Cond['col'], val })
	const and = (...parts: unknown[]): Cond => ({ op: 'and', parts: parts.filter(Boolean) as Cond[] })
	const flat = (c: Cond | undefined): Cond[] =>
		!c ? [] : c.op === 'and' ? (c.parts ?? []).flatMap(flat) : [c]
	const idOf = (c: Cond | undefined) =>
		flat(c).find((x) => x.op === 'eq' && x.col?.name === 'id')?.val as string | undefined
	const tableName = (t: unknown) => {
		for (const [k, v] of Object.entries(real)) if (v === t) return k
		return 'unknown'
	}
	const TEXT_FIELDS = ['output', 'error', 'errorSummary', 'githubDeploymentId', 'imageTag']

	function chain(kind: 'select' | 'update' | 'insert' | 'delete', table?: unknown, fields?: Row) {
		const q: {
			table?: unknown
			where?: Cond
			set?: Row
			values?: Row | Row[]
			returning: boolean
		} = {
			table,
			returning: false,
		}
		const resolve = (): unknown => {
			const name = tableName(q.table)
			if (kind === 'insert') {
				const vals = (Array.isArray(q.values) ? q.values : [q.values]).filter(Boolean) as Row[]
				for (const v of vals) {
					state.writes.push({ sink: state.sink, table: name, value: v })
					if (name === 'deploys') state.deploys.set(v.id as string, { ...v, startedAt: new Date() })
				}
				return q.returning ? vals.map((v) => ({ ...v, startedAt: new Date() })) : undefined
			}
			if (kind === 'update') {
				state.writes.push({ sink: state.sink, table: name, value: q.set ?? {} })
				const id = idOf(q.where)
				const row = name === 'deploys' && id ? state.deploys.get(id) : undefined
				if (row) {
					Object.assign(row, q.set)
				}
				return q.returning ? [{ id: id ?? 'x', startedAt: new Date() }] : undefined
			}
			if (kind === 'delete') return []
			// select
			if (name === 'appRepos') return state.repo ? [state.repo] : []
			if (name !== 'deploys') return []
			const conds = flat(q.where)
			if (conds.some((c) => c.op === 'eq' && c.col?.name === 'status' && c.val === 'queued'))
				return []
			if (fields && !Object.keys(fields).some((k) => TEXT_FIELDS.includes(k))) return []
			const id = idOf(q.where)
			const rows = [...state.deploys.values()]
			return id ? rows.filter((r) => r.id === id) : rows
		}
		const p: Record<string, unknown> = {}
		const self = new Proxy(p, {
			get(_t, prop) {
				if (prop === 'then') {
					return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
						try {
							return Promise.resolve(resolve()).then(ok, bad)
						} catch (e) {
							return Promise.reject(e).then(ok, bad)
						}
					}
				}
				if (prop === 'catch')
					return (bad: (e: unknown) => unknown) => Promise.resolve(resolve()).catch(bad)
				return (...args: unknown[]) => {
					if (prop === 'from') q.table = args[0]
					else if (prop === 'where') q.where = args[0] as Cond
					else if (prop === 'set') q.set = args[0] as Row
					else if (prop === 'values') q.values = args[0] as Row
					else if (prop === 'returning') q.returning = true
					return self
				}
			},
		})
		return self
	}
	const db = {
		select: (fields?: Row) => chain('select', undefined, fields),
		update: (t: unknown) => chain('update', t),
		insert: (t: unknown) => chain('insert', t),
		delete: (t: unknown) => chain('delete', t),
		// the log search runs in a transaction (SET LOCAL statement_timeout).
		transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
			fn({ ...db, execute: async () => [] }),
	}
	return { ...real, db, eq, and, or: and }
})

// ── everything below the sinks is stubbed ───────────────────────────────────
const SERVER = { id: 'srv1', name: 'srv1', host: '10.0.0.1', kind: 'compose' }
const S = vi.hoisted(() => ({
	rebuild: null as null | ((onChunk: (c: string) => void) => Promise<unknown>),
	rollbackToImage: null as null | ((chunk: (c: string) => void) => Promise<unknown>),
}))
vi.mock('../ssh', async (orig) => ({
	...((await orig()) as object),
	inspectContainer: async () => ({
		state: 'running',
		status: 'running',
		image: 'web:old',
		compose: {
			configFile: '/opt/apps/web/docker-compose.yml',
			service: 'web',
			workingDir: '/opt/apps/web',
			configFiles: [],
		},
	}),
	rebuildDeploy: (...a: unknown[]) => S.rebuild?.(a[5] as (c: string) => void),
	resolveSwapCheckPlan: () => ({ skip: 'test' }),
	runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
	envFileCandidatesFor: async () => ['/opt/apps/web.env'],
	restoreEnvSnapshot: async () => ({
		output: '[env] restored snapshot\n[fx19] STRIPE_SECRET=St41pe5ecretVal\n',
	}),
	rollbackToImage: (...a: unknown[]) => S.rollbackToImage?.(a[5] as (c: string) => void),
	getContainerHostNetInfo: async () => null,
	getNginxRoutes: async () => [],
}))
vi.mock('../ssh/files', async (orig) => ({
	...((await orig()) as object),
	backupEnvBeforeRender: async () => {},
	dropEnvPreRender: async () => {},
	recordEnvRender: async () => {},
	restoreEnvBeforeRender: async () => ({ output: '' }),
}))
vi.mock('../env-vars-db', () => ({ prepareEnvFileForDeploy: async () => ({ rendered: false }) }))
vi.mock('../deploy/run', () => ({ restoreSharedTagAfterAbort: async () => '' }))
vi.mock('../deploy-queue', () => ({ runOnServer: async (_s: string, f: () => unknown) => f() }))
vi.mock('../servers', () => ({
	getServer: async () => SERVER,
	listAllServers: async () => [SERVER],
}))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => false }))
vi.mock('../app-domains', () => ({
	applyDomainsToCompose: async () => {},
	listDomainsForRepo: async () => [],
	addDomain: async () => {},
	HostnameTakenError: class extends Error {},
}))
vi.mock('../sync-deployment-md', () => ({ syncDeploymentMd: async () => ({ ok: true }) }))
vi.mock('../integrations', () => ({
	getGithubIntegration: async () => ({ token: 'gh-integration-token' }),
	getAdminGithubIntegration: async () => ({ token: 'gh-integration-token' }),
}))
vi.mock('../deploy-days-db', () => ({ deployDaysFor: async () => new Map() }))
vi.mock('../access', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const user = {
		id: 'u1',
		email: 'a@b',
		name: 'a',
		isAdmin: true,
		viaToken: true,
		tokenId: 't',
		tokenScopes: null,
	}
	return {
		...real,
		getCurrentUser: async () => user,
		requireUser: async () => user,
		// the one project access check, on the fixture repo
		requireProjectAccess: async (id: string) =>
			H.state.repo && (H.state.repo as { id?: string }).id === id
				? { user, repo: H.state.repo }
				: Response.json({ error: 'not found' }, { status: 404 }),
		requireServerForUser: async () => SERVER,
		requireContainerAccess: async () => ({ user, server: SERVER }),
		visibleRepos: async () => (H.state.repo ? [H.state.repo] : []),
	}
})

// ── captured egress ─────────────────────────────────────────────────────────
const sse: { sink: string; data: string }[] = []
const http: { sink: string; url: string; body: string }[] = []

beforeAll(() => {
	process.env.POWDER_HQ_INGEST_TOKEN = 'hq-token'
	process.env.POWDER_HQ_INGEST_URL = 'https://hq.example/api/hq/ingest/deploy'
	process.env.POWDER_HQ_GENERIC_URL = 'https://hq.example/api/hq/ingest/generic'
	process.env.POWDER_NOTIFY_WEBHOOK_URL = 'https://hooks.example/notify'
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: unknown, init?: RequestInit) => {
			const url = String(input)
			http.push({ sink: H.state.sink, url, body: typeof init?.body === 'string' ? init.body : '' })
			return new Response(JSON.stringify({ id: 4242 }), {
				status: 201,
				headers: { 'content-type': 'application/json' },
			})
		}),
	)
})
afterAll(() => {
	vi.unstubAllGlobals()
})

const REPO = {
	id: 'rep_web',
	serverId: 'srv1',
	containerName: 'web',
	repoUrl: 'https://github.com/acme/web.git',
	branch: 'main',
	ownerUserId: 'u1',
	webhookToken: 'whk',
	buildMode: 'build',
	swapCheck: false,
}

// The corpus split into chunks at awkward places: mid-token and inside the PEM body.
function chunksOf(log: string): string[] {
	const cuts = [log.indexOf(FX.GHP) + 10, log.indexOf(FX.PEM_BODY) + 20, log.indexOf(FX.SK) + 30]
		.filter((n) => n > 0)
		.sort((a, b) => a - b)
	const out: string[] = []
	let at = 0
	for (const c of cuts) {
		out.push(log.slice(at, c))
		at = c
	}
	out.push(log.slice(at))
	return out
}

async function settle(ms = 30) {
	await new Promise((r) => setTimeout(r, ms))
}

// Rows the write phase stored, by scenario, for the read sinks.
const ids = { stepError: 'dep_steperr', plainError: 'dep_plainerr', target: 'dep_target' }
let rollbackDeployId = ''

beforeAll(async () => {
	const { subscribe } = await import('../deploy-bus')
	const { executeDeploy } = await import('../deploy-runner')
	const { DeployStepError } = await import('../deploy-failure')
	H.state.repo = REPO

	// A. A script step fails with the __POWDER_FAIL__ marker. The whole corpus is
	// streamed (split mid-token and mid-PEM) and the summary pattern captures a
	// DSN from the auth-check body. Waits past the 1.5 s partial flush.
	{
		H.state.sink = 'A'
		const id = ids.stepError
		H.state.deploys.set(id, {
			id,
			serverId: 'srv1',
			containerName: 'web',
			kind: 'git_deploy',
			status: 'running',
			githubDeploymentId: '77',
			startedAt: new Date(),
		})
		const unsub = subscribe(id, (e) => sse.push({ sink: 'A', data: e.data }))
		const log = `── build ──\n${corpusLog()}\n── swap-check ──\nauth check: /api/auth/ok returned 500 (better-auth schema mismatch? run the migration): DATABASE_URL=postgres://app:Pg5ecretPw77@app-db:5432/app\n__POWDER_FAIL__ step=swap-check code=1\n`
		S.rebuild = async (onChunk) => {
			for (const c of chunksOf(log)) onChunk(c)
			await settle(1700)
			throw new DeployStepError(log)
		}
		await executeDeploy(H.state.deploys.get(id) as never)
		await settle()
		unsub()
	}

	// B. A thrown error with no marker: the summary falls back to the last line,
	// a git error carrying the x-access-token URL.
	{
		H.state.sink = 'B'
		const id = ids.plainError
		H.state.deploys.set(id, {
			id,
			serverId: 'srv1',
			containerName: 'web',
			kind: 'git_deploy',
			status: 'running',
			githubDeploymentId: '78',
			startedAt: new Date(),
		})
		const unsub = subscribe(id, (e) => sse.push({ sink: 'B', data: e.data }))
		S.rebuild = async (onChunk) => {
			onChunk('── git sync ──\n')
			throw new Error(
				`ssh: clone failed\n[fx22] DB_PASSWORD=DbPa55wordVal\nfatal: unable to access 'https://x-access-token:${FX.GHS}@github.com/acme/web/': The requested URL returned error: 403`,
			)
		}
		await executeDeploy(H.state.deploys.get(id) as never)
		await settle()
		unsub()
	}

	// C. The rollback route: env restore output streams a secret, then the
	// rollback throws a message carrying a redis URL and a bearer token.
	{
		H.state.sink = 'C'
		H.state.deploys.set(ids.target, {
			id: ids.target,
			serverId: 'srv1',
			containerName: 'web',
			kind: 'git_deploy',
			status: 'success',
			imageTag: 'web:deploy-dep_target',
			gitSha: 'a'.repeat(40),
			startedAt: new Date(Date.now() - 60_000),
		})
		S.rollbackToImage = async () => {
			throw new Error(
				`rollback failed: compose up: [fx08] REDIS_URL=redis://:R3disPw99zz@cache:6379/0 [fx18] Authorization: Bearer ${FX.BEARER}`,
			)
		}
		const { POST } = await import('@/app/api/servers/[id]/containers/[name]/rollback/route')
		const before = new Set(H.state.deploys.keys())
		const { subscribe: sub } = await import('../deploy-bus')
		// The new deploy id is minted inside the route; subscribe as soon as it exists.
		const origSet = H.state.deploys.set.bind(H.state.deploys)
		let unsub = () => {}
		H.state.deploys.set = (k: string, v: Record<string, unknown>) => {
			if (!before.has(k) && !rollbackDeployId) {
				rollbackDeployId = k
				unsub = sub(k, (e) => sse.push({ sink: 'C', data: e.data }))
			}
			return origSet(k, v)
		}
		const res = await POST(
			new Request('https://dash.example/api/servers/srv1/containers/web/rollback', {
				method: 'POST',
				body: JSON.stringify({ targetDeployId: ids.target }),
			}),
			{ params: Promise.resolve({ id: 'srv1', name: 'web' }) },
		)
		expect(res.status).toBe(202)
		await settle(100)
		H.state.deploys.set = origSet
		unsub()
	}
	H.state.sink = 'read'
}, 20_000)

// ── read sinks over the stored rows ─────────────────────────────────────────
const params = <T>(p: T) => ({ params: Promise.resolve(p) })
const req = (path: string) => new Request(`https://dash.example${path}`) as never
const failedIds = () => [ids.stepError, ids.plainError, rollbackDeployId]

async function readSinks(): Promise<Record<string, string>> {
	const out: Record<string, string> = {}
	const deployRoute = await import('@/app/api/deploys/[deployId]/route')
	out['GET /api/deploys/[id]'] = (
		await Promise.all(
			failedIds().map(async (d) =>
				(await deployRoute.GET(req(`/api/deploys/${d}`), params({ deployId: d }))).text(),
			),
		)
	).join('\n')
	const project = await import('@/app/api/projects/[id]/route')
	out['GET /api/projects/[id]'] = await (
		await project.GET(req('/api/projects/rep_web'), params({ id: 'rep_web' }))
	).text()
	const list = await import('@/app/api/servers/[id]/containers/[name]/deploys/route')
	out['GET container deploys'] = await (
		await list.GET(
			req('/api/servers/srv1/containers/web/deploys'),
			params({ id: 'srv1', name: 'web' }),
		)
	).text()
	const search = await import('@/app/api/logs/search/route')
	const qs = SECRET_FIXTURES.map((f) => f.id)
	out['GET /api/logs/search'] = (
		await Promise.all(
			qs.map(async (q) =>
				(await search.GET(new Request(`https://dash.example/api/logs/search?q=${q}`))).text(),
			),
		)
	).join('\n')
	const internal = await import('@/app/api/internal/deploys/route')
	out['GET /api/internal/deploys'] = await (
		await internal.GET(new Request('https://dash.example/api/internal/deploys'))
	).text()

	const { callTool } = await import('../mcp/tools')
	const ctx = {
		user: {
			id: 'u1',
			email: 'a@b',
			name: 'a',
			isAdmin: true,
			viaToken: true,
			tokenId: 't',
			tokenScopes: null,
		},
		headers: new Headers(),
		origin: 'https://dash.example',
	} as never
	const tool = async (name: string, args: Record<string, unknown>) => {
		const r = await callTool(name, args, ctx)
		return r?.content.map((c) => c.text).join('\n') ?? ''
	}
	out['MCP get_deploy_log'] = (
		await Promise.all(failedIds().map((d) => tool('get_deploy_log', { deploy_id: d, tail: 2000 })))
	).join('\n')
	out['MCP list_deploys'] = await tool('list_deploys', { app: 'rep_web' })
	out['MCP get_app'] = await tool('get_app', { app: 'rep_web' })

	const { deployEvent } = await import('../activity-feed')
	out['activity deployEvent'] = failedIds()
		.map((d) =>
			JSON.stringify(
				deployEvent({
					triggeredBy: null,
					queuedAt: null,
					gitSha: null,
					...(H.state.deploys.get(d) as object),
				} as never),
			),
		)
		.join('\n')
	const { debugDeployPrompt } = await import('../agent-help-prompts')
	out['agent-help debugDeployPrompt'] = failedIds()
		.map((d) => {
			const r = H.state.deploys.get(d) as Record<string, string | null>
			return debugDeployPrompt({
				app: 'web',
				failedStep: r.failedStep,
				summary: r.errorSummary,
				log: `${r.output ?? ''}\n${r.error ?? ''}`,
			})
		})
		.join('\n')
	return out
}

// ── the sinks ───────────────────────────────────────────────────────────────
function writeText(table: string, fields: string[]): string {
	return H.state.writes
		.filter((w) => w.table === table)
		.map((w) =>
			fields.map((f) => (typeof w.value[f] === 'string' ? (w.value[f] as string) : '')).join('\n'),
		)
		.join('\n')
}
const httpTo = (re: RegExp) =>
	http
		.filter((h) => re.test(h.url))
		.map((h) => `${h.url}\n${h.body}`)
		.join('\n')

const WRITE_SINKS: Record<string, () => string> = {
	'db deploys.output': () => writeText('deploys', ['output']),
	'db deploys.error': () => writeText('deploys', ['error']),
	'db deploys.errorSummary': () => writeText('deploys', ['errorSummary']),
	// A client concatenates chunks, so a token split across two events still counts.
	'SSE publish': () => sse.map((e) => e.data).join(''),
	'HQ deploy ingest': () => httpTo(/hq\.example/),
	'notify webhook': () => httpTo(/hooks\.example/),
	'GitHub deployment status': () => httpTo(/api\.github\.com/),
	'rollback route (db + SSE + GitHub)': () =>
		[
			H.state.writes
				.filter((w) => w.sink === 'C')
				.map((w) => JSON.stringify(w.value))
				.join('\n'),
			sse
				.filter((e) => e.sink === 'C')
				.map((e) => e.data)
				.join('\n'),
			http
				.filter((h) => h.sink === 'C')
				.map((h) => h.body)
				.join('\n'),
		].join('\n'),
}

// Sinks that still leak. Shrink-only; empty since secret masking moved to
// write time (finishDeploy, the stream redactor, SafeText sinks). Adding an
// entry needs a reason in the commit.
const KNOWN_LEAKS = new Set<string>()

describe('secret egress class: no fixture secret leaves through any sink', () => {
	it('the scenarios really drove the fan-out (captures are not empty)', () => {
		expect(H.state.writes.some((w) => w.table === 'deploys' && 'errorSummary' in w.value)).toBe(
			true,
		)
		expect(sse.length).toBeGreaterThan(3)
		expect(http.some((h) => /hq\.example/.test(h.url))).toBe(true)
		expect(http.some((h) => /hooks\.example/.test(h.url))).toBe(true)
		expect(http.some((h) => /api\.github\.com\/.*statuses/.test(h.url))).toBe(true)
		expect(rollbackDeployId).not.toBe('')
	})

	for (const [name, text] of Object.entries(WRITE_SINKS)) {
		const run = KNOWN_LEAKS.has(name) ? it.fails : it
		run(`write sink: ${name}`, () => {
			expect(leakedIn(text()).join(' ')).toBe('')
		})
	}

	let reads: Record<string, string> = {}
	beforeAll(async () => {
		reads = await readSinks()
	}, 20_000)
	const READ_SINKS = [
		'GET /api/deploys/[id]',
		'GET /api/projects/[id]',
		'GET container deploys',
		'GET /api/logs/search',
		'GET /api/internal/deploys',
		'MCP get_deploy_log',
		'MCP list_deploys',
		'MCP get_app',
		'activity deployEvent',
		'agent-help debugDeployPrompt',
	]
	for (const name of READ_SINKS) {
		const run = KNOWN_LEAKS.has(name) ? it.fails : it
		run(`read sink: ${name}`, () => {
			expect(reads[name]).toBeTruthy()
			expect(leakedIn(reads[name] ?? '').join(' ')).toBe('')
		})
	}
})
