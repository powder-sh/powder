// ReDoS guard: adversarial 1 MB inputs through every regex path that runs on
// deploy output (the deploy worker runs these on every failed deploy). The
// budget is generous for slow CI servers; a backtracking pattern (deploy-failure
// `.*` patterns) takes far longer on the same inputs, so a regression is unmistakable.
import { describe, expect, it } from 'vitest'
import { classifyBuilderFailure } from '../builder-failure'
import { parseDeployFailure } from '../deploy-failure'
import { SecretStreamRedactor, redactSecrets } from '../secret-text'

// 5 s: the full suite runs files in parallel, which slowed the 4 KB-line PEM
// cases to ~2 s once; the broken paths this guards against take 25-60 s.
const BUDGET_MS = 5000
const SIZE = 1_000_000
const UNITS = [
	'key.',
	'a.',
	'a://',
	'Container ',
	'manifest for ',
	'column "a" of relation ',
	'container name "',
	'auth check: /',
	'__POWDER_FAIL__ step=',
	'-----BEGIN RSA PRIVATE KEY-----',
	'Bearer ',
	'x_',
	'@',
]

// One 1 MB line, and 1 MB of lines just under the line cap (the cap cuts
// longer lines before any rule runs, so these are the real worst case).
const oneLine = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length))
const capLines = (unit: string) => {
	const line = unit.repeat(Math.floor(4000 / unit.length))
	return Array.from({ length: Math.ceil(SIZE / (line.length + 1)) }, () => line).join('\n')
}
// lines up to 64 KB are masked whole before the cut.
const fullMaskLines = (unit: string) => {
	const line = unit.repeat(Math.floor(65_000 / unit.length))
	return Array.from({ length: Math.ceil(SIZE / (line.length + 1)) }, () => line).join('\n')
}
const SHAPES = { 'one line': oneLine, '4 KB lines': capLines, '64 KB lines': fullMaskLines }

function time(fn: () => void): number {
	const t = performance.now()
	fn()
	return performance.now() - t
}

describe('regex cost on 1 MB adversarial input stays bounded', () => {
	for (const [shape, make] of Object.entries(SHAPES))
		for (const unit of UNITS) {
			const s = make(unit)
			const name = `${JSON.stringify(unit)}, ${shape}`
			it(`redactSecrets: ${name}`, () => {
				expect(time(() => redactSecrets(s))).toBeLessThan(BUDGET_MS)
			}, 60_000)
			it(`SecretStreamRedactor: ${name}`, () => {
				const ms = time(() => {
					const r = new SecretStreamRedactor()
					for (let i = 0; i < s.length; i += 4096) r.push(s.slice(i, i + 4096))
					r.flush()
				})
				expect(ms).toBeLessThan(BUDGET_MS)
			}, 60_000)
			it(`parseDeployFailure: ${name}`, () => {
				expect(time(() => parseDeployFailure(s))).toBeLessThan(BUDGET_MS)
				// Also as the failing step's region, the path the worker takes.
				const step = `── build ──\n${s}\n__POWDER_FAIL__ step=build code=1\n`
				expect(time(() => parseDeployFailure(step))).toBeLessThan(BUDGET_MS)
			}, 120_000)
		}
})

// A failed RUN step whose only failure-looking line is a package manager's trailer,
// followed by many short lines: the reader walks up from the last trailer once
// (buildkit-log.ts failingLines). A scan per line over the lines after it was
// quadratic in a commit's own build output.
describe('a package-manager trailer followed by many lines stays linear', () => {
	const run = (n: number) =>
		[
			'#7 [b 2/3] RUN npm test',
			'#7 1.0 npm error Lifecycle script `test` failed',
			...Array.from({ length: n }, () => '#7 1.1 ok'),
			'#7 ERROR: process "/bin/sh -c npm test" did not complete successfully: exit code: 1',
		].join('\n')
	it('the local build summary grows linearly with the lines after the trailer', () => {
		// The summary reads at most the last 64 KB of the step's region, so a fixed budget
		// cannot tell the per-line scan from the walk-up on a fast machine. The growth can:
		// four times the lines take a linear reader about 4x as long and a quadratic one about
		// 16x. A 4x step (not 2x) keeps the two apart even when a loaded machine's noise
		// nearly doubles one measurement.
		const log = (n: number) => {
			const lines = [
				'#7 [b 2/3] RUN npm test',
				'#7 1.0 npm error Lifecycle script `test` failed',
				...Array.from({ length: n }, () => '#7 k'),
				'#7 ERROR: process "/bin/sh -c npm test" did not complete successfully: exit code: 1',
			].join('\n')
			return `── docker compose build (local build) ──\n${lines}\n__POWDER_FAIL__ step=docker compose build (local build) code=1\n`
		}
		const full = log(13_000)
		const quarter = log(3_250)
		expect(full.length).toBeLessThan(64 * 1024)
		// the fastest of 9 interleaved runs per size: other work on a loaded machine only
		// ever adds time, so the minimum is the reader's own cost
		parseDeployFailure(quarter) // warm up
		let tQuarter = Number.POSITIVE_INFINITY
		let tFull = Number.POSITIVE_INFINITY
		for (let i = 0; i < 9; i++) {
			tQuarter = Math.min(tQuarter, time(() => parseDeployFailure(quarter)))
			tFull = Math.min(tFull, time(() => parseDeployFailure(full)))
		}
		// linear: about 4x; quadratic: about 16x. 10 ms absorbs timer jitter at this size.
		expect(tFull).toBeLessThan(9 * tQuarter + 10)
	}, 120_000)
	it("the builder's verdict: 50,000 lines after the trailer", () => {
		const out = run(50_000)
		expect(time(() => classifyBuilderFailure(out, 1))).toBeLessThan(BUDGET_MS)
	}, 60_000)
})

// The nginx reader (servers list, app context, Domains page) parses SSH output of host
// files and proxy containers synchronously in the request path. Valid `nginx -T`
// output never has these shapes, but the fallback file read and unmanaged proxy
// containers are not validated. The regex versions took 56-100 s on these inputs.
describe('nginx parser cost on 1 MB adversarial input stays bounded', () => {
	// tighter than BUDGET_MS: the linear scans take well under 0.5 s here even under
	// suite load, the regex versions 4-110 s, so the gap stays unmistakable
	const NGINX_BUDGET_MS = 2000
	const NGINX_UNITS: Record<string, string> = {
		'unclosed upstream blocks': 'upstream a { ',
		'unclosed map blocks': 'map $host $a { ',
		'server_name without ;': 'server_name a ',
		'server_name glued to a word': 'server_namex ',
		'set with a scheme, no proxy_pass': 'set $a "http://h:1"; ',
		'set without a scheme, no proxy_pass': 'set $a "h:1"; ',
		'set and proxy_pass of another variable': 'set $a "h:1"; proxy_pass http://$b; ',
		'short sets between proxy_pass lines': 'set $a h:1;proxy_pass x;',
		'map-variable proxy_pass without $': 'proxy_pass http://aaaa:',
		'unclosed server blocks': 'server { ',
		'nested braces': '{ ',
		'upstream keywords': 'upstream ',
	}
	for (const [name, unit] of Object.entries(NGINX_UNITS)) {
		const body = unit.repeat(Math.ceil(SIZE / unit.length))
		const placements = {
			alone: body,
			// a server block whose first server_name is valid: the later scans run on the body
			'inside a server block': `server { server_name a.example.com; ${body}`,
			// a server block with no valid server_name before the body: the server_name scan
			// itself runs over the whole body
			'in an open server block': `server { ${body}`,
		}
		for (const [where, s] of Object.entries(placements)) {
			it(`${name}, ${where}`, async () => {
				const { parseNginxRoutes, parseUpstreamBlocks, parseHostMaps } = await import('../ssh/discovery')
				expect(time(() => parseNginxRoutes(s))).toBeLessThan(NGINX_BUDGET_MS)
				expect(time(() => parseUpstreamBlocks(s))).toBeLessThan(NGINX_BUDGET_MS)
				expect(time(() => parseHostMaps(s))).toBeLessThan(NGINX_BUDGET_MS)
			}, 60_000)
		}
	}
	it('text past MAX_NGINX_PARSE_CHARS is not parsed', async () => {
		const { MAX_NGINX_PARSE_CHARS, parseNginxRoutes } = await import('../ssh/discovery')
		const late = 'server { listen 80; server_name late.example.com; location / { proxy_pass http://127.0.0.1:3001; } }'
		const early = late.replace('late', 'early').replace('3001', '3002')
		const pad = '#'.repeat(MAX_NGINX_PARSE_CHARS)
		expect(parseNginxRoutes(`${early}\n${pad}\n${late}`)).toEqual([
			{ host: '127.0.0.1', port: 3002, urls: ['http://early.example.com'] },
		])
	})
})
