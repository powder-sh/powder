// ReDoS guard: adversarial 1 MB inputs through every regex path that runs on
// deploy output (the deploy worker runs these on every failed deploy). The
// budget is generous for slow CI servers; a backtracking pattern (deploy-failure
// `.*` patterns) takes far longer on the same inputs, so a regression is unmistakable.
import { describe, expect, it } from 'vitest'
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
