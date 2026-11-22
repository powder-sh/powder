import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	parseStabilityMarkers,
	stabilityMarkShell,
	stabilityMarkerFor,
	stabilityMarkerFilter,
	stripStabilityMarkers,
	testGatePresenceShell,
} from '../deploy/stability'
import { type DeployWarnings, healthUrlState, postComposeDriftInventory, reportDeployWarningsToHq, stabilityCardPlan } from '../hq'
import type { ComposeDriftStore } from '../deploy/compose-drift-inventory'

/** In-memory compose-drift state (the server keeps it in powder_meta). `known` = the apps
 *  powder has: list() drops the rows of any other app, as the powder_meta store does. */
function memStore(
	seed: Record<string, 'drift' | 'standing'> = {},
	known: (ref: string) => boolean = () => true,
): ComposeDriftStore & { rows: Map<string, 'drift' | 'standing'> } {
	const rows = new Map<string, 'drift' | 'standing'>(Object.entries(seed))
	return {
		rows,
		get: async (r) => rows.get(r) ?? null,
		set: async (r, v) => void rows.set(r, v),
		del: async (r) => void rows.delete(r),
		list: async () => {
			for (const r of [...rows.keys()]) if (!known(r)) rows.delete(r)
			return [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ref, value]) => ({ ref, value }))
		},
	}
}

// Deploy-setup markers and their warning cards. A marker is only trusted with the
// run's nonce, a malformed or missing one is "unknown" (no card raised or
// resolved), and nothing here may throw into a deploy.

const NONCE = 'n0nce42'
const M = stabilityMarkerFor(NONCE)
const base: DeployWarnings = { app: 'demo', server: 'web1', envRefusedKeys: null, builderFallback: null }

describe('parseStabilityMarkers', () => {
	it('reads the last valid line per kind', () => {
		expect(parseStabilityMarkers(`${M} compose-drift drift\n${M} compose-drift ok\n`, NONCE).composeDrift).toBe('ok')
		expect(parseStabilityMarkers(`${M} compose-drift drift\n${M} compose-drift bogus\n`, NONCE).composeDrift).toBe('drift')
	})
	it('malformed, foreign or missing markers are unknown and never throw', () => {
		const unknown = parseStabilityMarkers('', NONCE)
		for (const out of [
			'',
			'[compose-drift] WARNING: the repo docker-compose.yml differs',
			`build: ${M} compose-drift drift`,
			`${M} compose-drift`,
			`${M} compose-drift drift extra`,
			`${M}compose-drift drift`,
			`${M} compose-drift DRIFT`,
			'__POWDER_STAB_other__ compose-drift drift',
			'\u0000￿'.repeat(1000),
		]) {
			expect(parseStabilityMarkers(out, NONCE)).toEqual(unknown)
		}
		expect(Object.values(unknown).every((v) => v === null)).toBe(true)
		expect(parseStabilityMarkers(`${M} compose-drift drift`, '')).toEqual(unknown)
		expect(() => parseStabilityMarkers(undefined as unknown as string, NONCE)).not.toThrow()
		expect(() => parseStabilityMarkers(null as unknown as string, NONCE)).not.toThrow()
	})
	it('no nonce: no marker is printed; only fixed words are', () => {
		expect(stabilityMarkShell('', 'compose-drift', 'drift')).toBe('')
		expect(stabilityMarkShell(NONCE, 'compose-drift', "x'; rm -rf /")).toBe('')
		expect(stabilityMarkShell(NONCE, 'compose-drift', 'drift')).toBe(`echo '${M} compose-drift drift'; `)
	})
})

describe('stripStabilityMarkers', () => {
	it("drops this run's marker lines and keeps every other line", () => {
		const out = `── build ──\n${M} compose-drift drift\nstep 1\n${M} test-gate absent\nbuild: ${M} compose-drift ok\n__POWDER_STAB_other__ test-gate present\ndone\n`
		const kept = stripStabilityMarkers(out, NONCE)
		expect(kept).toBe(
			`── build ──\nstep 1\nbuild: ${M} compose-drift ok\n__POWDER_STAB_other__ test-gate present\ndone\n`,
		)
		// parsed first, from the unstripped text
		expect(parseStabilityMarkers(out, NONCE).composeDrift).toBe('drift')
		expect(parseStabilityMarkers(kept, NONCE).composeDrift).toBeNull()
		expect(stripStabilityMarkers(out, '')).toBe(out)
	})
	it('the deploy run stores the output without them, after parsing', () => {
		const src = readFileSync(join(__dirname, '../deploy/run.ts'), 'utf8')
		expect(src).toContain('output: stripStabilityMarkers(builderLog + stdout, shaNonce)')
		expect(src).toContain('stability: parseStabilityMarkers(stdout, shaNonce)')
	})
	it('a failed deploy drops them too: the live log is filtered and every error after the script is stripped', () => {
		const src = readFileSync(join(__dirname, '../deploy/run.ts'), 'utf8')
		const after = src.slice(src.indexOf('const live = stabilityMarkerFilter(shaNonce, onChunk)'))
		expect(after.length).toBeLessThan(src.length)
		// both script runs stream through the filter, never the raw sink
		expect(after.match(/runDeployScript\(/g)?.length).toBe(1)
		expect(after).toContain('return await runDeployScript(server, script, deployId, live.push, budget)')
		expect(after.match(/await runLive\(/g)?.length).toBe(2)
		// every DeployStepError built from the script output is stripped
		const errs = after.match(/new DeployStepError\((.*)\)/g) ?? []
		expect(errs.length).toBeGreaterThanOrEqual(3)
		for (const e of errs) expect(e).toMatch(/^new DeployStepError\(strip\(/)
	})
})

describe('stabilityMarkerFilter (live log)', () => {
	const out = `── build ──\n${M} compose-drift drift\nstep 1\n${M} test-gate absent\nbuild: ${M} compose-drift ok\n__POWDER_STAB_other__ x\n__POWDER_STAB_\ndone`
	const run = (chunks: string[]) => {
		const got: string[] = []
		const f = stabilityMarkerFilter(NONCE, (c) => got.push(c))
		for (const c of chunks) f.push(c)
		f.flush()
		return got.join('')
	}
	it('drops the marker lines whatever the chunk boundaries, and keeps every other byte', () => {
		const want = stripStabilityMarkers(out, NONCE)
		expect(run([out])).toBe(want)
		for (let i = 0; i <= out.length; i++) expect(run([out.slice(0, i), out.slice(i)]), `split at ${i}`).toBe(want)
		expect(run(out.split(''))).toBe(want)
	})
	it('passes text through at once unless it could still start a marker line', () => {
		const got: string[] = []
		const f = stabilityMarkerFilter(NONCE, (c) => got.push(c))
		f.push('progress 10%')
		expect(got).toEqual(['progress 10%'])
		f.push('\n__POWDER_ST')
		expect(got).toEqual(['progress 10%', '\n'])
		f.push('ALE\n')
		expect(got.join('')).toBe('progress 10%\n__POWDER_STALE\n')
	})
	it('stdout and stderr keep their own line state: a stderr line without its newline does not let a stdout marker through', () => {
		const got: string[] = []
		const f = stabilityMarkerFilter(NONCE, (c) => got.push(c))
		f.push('warning: partial', 'stderr')
		f.push(`${M} compose-drift drift\nstep 1\n`, 'stdout')
		f.push(' line\n', 'stderr')
		f.flush()
		expect(got.join('')).toBe('warning: partialstep 1\n line\n')
		expect(got.join('')).not.toContain(M)
	})
	it('flush() ends a run: the next run starts at a line start', () => {
		const got: string[] = []
		const f = stabilityMarkerFilter(NONCE, (c) => got.push(c))
		f.push('first run ends without a newline', 'stdout')
		f.flush()
		f.push(`${M} test-gate absent\nsecond run\n`, 'stdout')
		f.flush()
		expect(got.join('')).toBe('first run ends without a newlinesecond run\n')
	})
	it('no nonce: unchanged', () => {
		const got: string[] = []
		const f = stabilityMarkerFilter('', (c) => got.push(c))
		f.push(`${M} compose-drift drift\n`)
		expect(got).toEqual([`${M} compose-drift drift\n`])
	})
})

describe('deploy-setup cards', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		delete process.env.POWDER_HQ_INGEST_TOKEN
		delete process.env.POWDER_HQ_GENERIC_URL
		delete process.env.POWDER_STABILITY_CARDS
	})
	function capture() {
		process.env.POWDER_HQ_INGEST_TOKEN = 't'
		process.env.POWDER_HQ_GENERIC_URL = 'http://hq/generic'
		const bodies: Record<string, unknown>[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_u: string, i: { body: string }) => {
				bodies.push(JSON.parse(i.body))
				return new Response('ok')
			}),
		)
		return bodies
	}

	it('compose-drift: drift raises, ok resolves, unknown posts nothing (switch on)', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		const cards = () => bodies.filter((b) => b.source_ref === 'compose-drift:web1/demo')
		const store = memStore()
		await reportDeployWarningsToHq({ ...base, composeDrift: 'drift' }, store)
		expect(cards()).toHaveLength(1)
		expect(cards()[0]).toMatchObject({ severity: 'warn', project: 'demo', source: 'powder-deploy-warn' })
		expect(String(cards()[0]?.body)).toContain('Apply the change to the server file too')
		await reportDeployWarningsToHq({ ...base, composeDrift: null }, store)
		await reportDeployWarningsToHq({ ...base }, store)
		expect(cards()).toHaveLength(1)
		// a later deploy that leaves the compose alone neither raises nor resolves it
		await reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, store)
		await reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, store)
		expect(cards()).toHaveLength(1)
		expect(store.rows.get('web1/demo')).toBe('drift')
		await reportDeployWarningsToHq({ ...base, composeDrift: 'ok' }, store)
		expect(cards()[1]?.resolve).toBe(true)
		expect(store.rows.has('web1/demo')).toBe(false)
	})

	it('compose-drift standing: the first one retires an old-rule card once, then never resolves', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		const cards = () => bodies.filter((b) => b.source_ref === 'compose-drift:web1/demo')
		const store = memStore()
		await reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, store)
		expect(cards()).toHaveLength(1)
		expect(cards()[0]?.resolve).toBe(true)
		expect(store.rows.get('web1/demo')).toBe('standing')
		await reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, store)
		expect(cards()).toHaveLength(1)
		// a real change after that raises, and standing does not clear it
		await reportDeployWarningsToHq({ ...base, composeDrift: 'drift' }, store)
		await reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, store)
		expect(cards()).toHaveLength(2)
		expect(cards()[1]?.resolve).toBeUndefined()
		expect(stabilityCardPlan({ ...base, composeDrift: 'standing' }).filter((c) => c.key.startsWith('compose-drift:'))).toEqual([])
	})

	it('compose-drift: a real change raises once with the plain text, its standing redeploys never re-raise', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		const raises = () => bodies.filter((b) => b.source_ref === 'compose-drift:web1/demo' && !b.resolve)
		const store = memStore({ 'web1/demo': 'standing' })
		for (let i = 0; i < 5; i++) await reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, store)
		expect(raises()).toHaveLength(0)
		await reportDeployWarningsToHq({ ...base, composeDrift: 'drift' }, store)
		for (let i = 0; i < 5; i++) await reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, store)
		expect(raises()).toHaveLength(1)
		expect(raises()[0]).toMatchObject({ severity: 'warn', channel: 'general', project: 'demo', title: 'demo: committed compose changes are not deployed' })
		expect(String(raises()[0]?.body)).toContain("powder runs the server's compose file")
		expect(bodies.filter((b) => b.source_ref === 'compose-drift:web1/demo' && b.resolve)).toHaveLength(0)
	})

	it('compose-drift inventory: one HQ-only task lists the standing apps, resolved when empty', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		const inv = () => bodies.filter((b) => b.source_ref === 'compose-drift-standing:fleet')
		const store = memStore({ 'web2/other': 'standing' })
		await reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, store)
		expect(inv()).toHaveLength(1)
		expect(inv()[0]).toMatchObject({ source: 'powder-deploy-warn', severity: 'info', refresh_text: true })
		expect(inv()[0]?.channel).toBeUndefined()
		expect(inv()[0]?.project).toBeUndefined()
		expect(String(inv()[0]?.title)).toContain('on 2 apps')
		expect(String(inv()[0]?.body)).toContain('- web1/demo\n- web2/other')
		// a real change moves the app to its own card: it leaves the standing list
		await reportDeployWarningsToHq({ ...base, composeDrift: 'drift' }, store)
		expect(String(inv()[1]?.title)).toContain('on 1 app')
		expect(String(inv()[1]?.body)).not.toContain('web1/demo')
		await reportDeployWarningsToHq({ ...base, composeDrift: 'ok' }, store)
		await reportDeployWarningsToHq({ ...base, app: 'other', server: 'web2', composeDrift: 'ok' }, store)
		expect(inv()[3]?.resolve).toBe(true)
		// unknown posts nothing and touches no state
		await reportDeployWarningsToHq({ ...base, composeDrift: null }, store)
		expect(inv()).toHaveLength(4)
	})

	// With reopen:false a closed inventory would never open again, so an app joining the
	// standing set later would be invisible. It reopens on a join, and only then.
	it('compose-drift inventory: reopens when an app joins the standing set, not on other deploys', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		const inv = () => bodies.filter((b) => b.source_ref === 'compose-drift-standing:fleet')
		const store = memStore()
		await reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, store)
		expect(inv()[0]?.reopen).toBe(true)
		// the same app again, a drift, an ok of another app: no join, a closed inventory stays closed
		await reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, store)
		await reportDeployWarningsToHq({ ...base, app: 'blog', composeDrift: 'drift' }, store)
		await reportDeployWarningsToHq({ ...base, app: 'shop', composeDrift: 'ok' }, store)
		expect(inv().slice(1).map((b) => b.reopen)).toEqual([false, false, false])
		// a new app joins: this post reopens it
		await reportDeployWarningsToHq({ ...base, app: 'wiki', composeDrift: 'standing' }, store)
		expect(inv()[4]).toMatchObject({ reopen: true })
		expect(String(inv()[4]?.body)).toContain('- web1/wiki')
		// an app that went ok and comes back standing joins again
		await reportDeployWarningsToHq({ ...base, composeDrift: 'ok' }, store)
		await reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, store)
		expect(inv()[6]).toMatchObject({ reopen: true })
		// an app powder does not have never joins (and never retires a card)
		const ghost = memStore({}, (r) => r !== 'web1/ghost')
		for (let i = 0; i < 3; i++) await reportDeployWarningsToHq({ ...base, app: 'ghost', composeDrift: 'standing' }, ghost)
		expect(inv().slice(7).every((b) => b.reopen === false || b.resolve === true)).toBe(true)
		expect(bodies.filter((b) => b.source_ref === 'compose-drift:web1/ghost')).toEqual([])
	})

	// The drift row is written before the card is raised: otherwise a failed write would let
	// the next standing deploy take the new card for an old-rule one and close it.
	it('compose-drift: the drift row is written before the card; a failed write raises nothing', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		const order: string[] = []
		const store = memStore()
		const tracked: ComposeDriftStore = {
			...store,
			set: async (r, v) => {
				order.push(`set ${v}`)
				await store.set(r, v)
			},
		}
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_u: string, i: { body: string }) => {
				const b = JSON.parse(i.body)
				if (b.source_ref === 'compose-drift:web1/demo') order.push(b.resolve ? 'resolve' : 'raise')
				bodies.push(b)
				return new Response('ok')
			}),
		)
		await reportDeployWarningsToHq({ ...base, composeDrift: 'drift' }, tracked)
		expect(order).toEqual(['set drift', 'raise'])

		const err = vi.spyOn(console, 'error').mockImplementation(() => {})
		const failing = memStore()
		const broken: ComposeDriftStore = {
			...failing,
			set: async () => {
				throw new Error('db down')
			},
		}
		const before = bodies.length
		await expect(reportDeployWarningsToHq({ ...base, app: 'shop', composeDrift: 'drift' }, broken)).resolves.toBeUndefined()
		expect(bodies.slice(before).filter((b) => String(b.source_ref).startsWith('compose-drift'))).toEqual([])
		expect(String(err.mock.calls[0]?.[0])).toContain('compose-drift state write failed for web1/shop')
		// the store is back: the next standing deploy has no row, so it retires a card
		// that was never raised (no-op), never a new-rule one
		await reportDeployWarningsToHq({ ...base, app: 'shop', composeDrift: 'standing' }, failing)
		expect(bodies.filter((b) => b.source_ref === 'compose-drift:web1/shop' && !b.resolve)).toEqual([])
	})

	// Two deploys finishing together would each post the list they had read, so an older
	// list could land last. Posts run in order and read the list when sent.
	it('compose-drift inventory: concurrent posts land in order, the last one has the latest list', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		const inv = () => bodies.filter((b) => b.source_ref === 'compose-drift-standing:fleet')
		const store = memStore({ 'web1/a': 'standing' })
		let release: () => void = () => {}
		const gate = new Promise<void>((r) => {
			release = r
		})
		let calls = 0
		const slow: ComposeDriftStore = {
			...store,
			list: async () => {
				const snap = await store.list()
				if (++calls === 1) await gate
				return snap
			},
		}
		const first = postComposeDriftInventory('powder-deploy-warn', slow, false)
		// the first post has read its list and waits; another deploy changes the state
		await vi.waitFor(() => expect(calls).toBe(1))
		store.rows.set('web1/b', 'standing')
		const second = postComposeDriftInventory('powder-deploy-warn', slow, false)
		release()
		await Promise.all([first, second])
		expect(inv().map((b) => b.title)).toEqual([
			'Repo docker-compose.yml differs from the server compose on 1 app',
			'Repo docker-compose.yml differs from the server compose on 2 apps',
		])
		// a failed post does not stop the chain
		const err = vi.spyOn(console, 'error').mockImplementation(() => {})
		const broken: ComposeDriftStore = { ...store, list: async () => Promise.reject(new Error('db down')) }
		await postComposeDriftInventory('powder-deploy-warn', broken, false)
		await postComposeDriftInventory('powder-deploy-warn', store, false)
		expect(inv()).toHaveLength(3)
		expect(err).toHaveBeenCalled()
	})

	it('compose-drift: a store error resolves nothing and never throws', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		const err = vi.spyOn(console, 'error').mockImplementation(() => {})
		const broken: ComposeDriftStore = {
			get: async () => {
				throw new Error('db down')
			},
			set: async () => {},
			del: async () => {},
			list: async () => [],
		}
		await expect(reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, broken)).resolves.toBeUndefined()
		expect(bodies.filter((b) => String(b.source_ref).startsWith('compose-drift'))).toEqual([])
		expect(err).toHaveBeenCalled()
		expect(parseStabilityMarkers(`${M} compose-drift standing\n`, NONCE).composeDrift).toBe('standing')
	})

	it('migrate-path: names each case, [] resolves, malformed marker is unknown', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		const cards = () => bodies.filter((b) => b.source_ref === 'migrate-path:web1/demo')
		await reportDeployWarningsToHq({ ...base, migratePath: ['stray-sql', 'boot-cmd'] })
		expect(cards()).toHaveLength(1)
		expect(String(cards()[0]?.title)).toContain('(stray-sql, boot-cmd)')
		expect(String(cards()[0]?.body)).toContain('none in a folder powder-migrate reads')
		expect(String(cards()[0]?.body)).toContain('image command or entrypoint runs a schema tool')
		expect(String(cards()[0]?.body)).toContain('runs its own migrator from the powder.release.cmd label')
		await reportDeployWarningsToHq({ ...base, migratePath: null })
		expect(cards()).toHaveLength(1)
		await reportDeployWarningsToHq({ ...base, migratePath: [] })
		expect(cards()[1]?.resolve).toBe(true)
		await reportDeployWarningsToHq({ ...base, migratePath: ['release-cmd'] })
		expect(String(cards()[2]?.body)).toContain('the powder.release.cmd label runs a schema push (drizzle-kit push, prisma db push)')
		expect(parseStabilityMarkers(`${M} migrate-path stray-sql,bogus`, NONCE).migratePath).toBeNull()
		expect(parseStabilityMarkers(`${M} migrate-path ,`, NONCE).migratePath).toBeNull()
		expect(parseStabilityMarkers(`${M} migrate-path release-cmd,release-cmd`, NONCE).migratePath).toEqual(['release-cmd'])
		expect(parseStabilityMarkers(`${M} migrate-path ok`, NONCE).migratePath).toEqual([])
	})

	it('health-url: no health_url on an HTTP app raises, set or non-HTTP resolves, preview unknown', async () => {
		expect(healthUrlState({ healthUrl: null }, true)).toBe('unset')
		expect(healthUrlState({ healthUrl: '   ' }, true)).toBe('unset')
		expect(healthUrlState({ healthUrl: '/api/health' }, true)).toBe('set')
		expect(healthUrlState({ healthUrl: null }, 'skipped')).toBe('n/a')
		expect(healthUrlState(undefined, true)).toBeNull()
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		const cards = () => bodies.filter((b) => b.source_ref === 'health-url:web1/demo')
		await reportDeployWarningsToHq({ ...base, healthUrl: 'unset' })
		expect(cards()).toHaveLength(1)
		expect(String(cards()[0]?.title)).toBe('demo: the health gate only proves the app answers HTTP')
		expect(String(cards()[0]?.body)).toContain('passes on any 1xx-4xx answer from /')
		await reportDeployWarningsToHq({ ...base, healthUrl: null })
		expect(cards()).toHaveLength(1)
		await reportDeployWarningsToHq({ ...base, healthUrl: 'set' })
		await reportDeployWarningsToHq({ ...base, healthUrl: 'n/a' })
		expect(cards().slice(1).every((c) => c.resolve === true)).toBe(true)
	})

	it('test-gate: absent raises, present resolves; the prebuilt presence check reads PF_CTX', async () => {
		const d = mkdtempSync(join(tmpdir(), 'tg-'))
		const sh = (ctx: string) =>
			execFileSync('bash', ['-c', `set -e; PF_CTX=${ctx}; ${testGatePresenceShell(NONCE)}echo rc=$?`], { cwd: d }).toString()
		expect(parseStabilityMarkers(sh(d), NONCE).testGate).toBe('absent')
		mkdirSync(join(d, '.powder'))
		writeFileSync(join(d, '.powder', 'test.sh'), 'true\n')
		expect(parseStabilityMarkers(sh(d), NONCE).testGate).toBe('present')
		expect(sh(join(d, 'missing'))).toContain('rc=0')
		expect(testGatePresenceShell('')).toBe('')
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		const cards = () => bodies.filter((b) => b.source_ref === 'test-gate:web1/demo')
		await reportDeployWarningsToHq({ ...base, testGate: 'absent' })
		expect(cards()).toHaveLength(1)
		expect(String(cards()[0]?.body)).toContain('Commit a .powder/test.sh')
		await reportDeployWarningsToHq({ ...base, testGate: null })
		expect(cards()).toHaveLength(1)
		await reportDeployWarningsToHq({ ...base, testGate: 'present' })
		expect(cards()[1]?.resolve).toBe(true)
	})

	it('switch off: no card posted, the raise is logged as would warn', async () => {
		const bodies = capture()
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		const store = memStore()
		await reportDeployWarningsToHq({ ...base, composeDrift: 'drift' }, store)
		await reportDeployWarningsToHq({ ...base, composeDrift: 'ok' }, store)
		await reportDeployWarningsToHq({ ...base, composeDrift: 'standing' }, store)
		expect(bodies.filter((b) => String(b.source_ref).startsWith('compose-drift'))).toEqual([])
		expect(store.rows.size).toBe(0)
		const lines = log.mock.calls.map((c) => String(c[0]))
		expect(lines).toHaveLength(1)
		expect(lines[0]).toMatch(/^\[stability\] would warn: compose-drift:web1\/demo the repo's docker-compose\.yml differs/)
	})

	it('card text is fixed: nothing from the deploy log', () => {
		for (const c of stabilityCardPlan({ ...base, composeDrift: 'drift' })) {
			expect(c.raise?.body).not.toContain('WARNING')
		}
	})

	it('a broken input never throws out of the report', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		capture()
		const bad = { ...base, composeDrift: 'weird', bridge: 'nonsense' } as unknown as DeployWarnings
		await expect(reportDeployWarningsToHq(bad)).resolves.toBeUndefined()
	})
})
