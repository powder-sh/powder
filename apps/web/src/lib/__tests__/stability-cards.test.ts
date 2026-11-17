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
import { type DeployWarnings, healthUrlState, reportDeployWarningsToHq, stabilityCardPlan } from '../hq'

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
		await reportDeployWarningsToHq({ ...base, composeDrift: 'drift' })
		expect(cards()).toHaveLength(1)
		expect(cards()[0]).toMatchObject({ severity: 'warn', project: 'demo', source: 'powder-deploy-warn' })
		expect(String(cards()[0]?.body)).toContain('Apply the change to the server file too')
		await reportDeployWarningsToHq({ ...base, composeDrift: null })
		await reportDeployWarningsToHq({ ...base })
		expect(cards()).toHaveLength(1)
		await reportDeployWarningsToHq({ ...base, composeDrift: 'ok' })
		expect(cards()[1]?.resolve).toBe(true)
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
		await reportDeployWarningsToHq({ ...base, composeDrift: 'drift' })
		await reportDeployWarningsToHq({ ...base, composeDrift: 'ok' })
		expect(bodies.filter((b) => String(b.source_ref).startsWith('compose-drift:'))).toEqual([])
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
