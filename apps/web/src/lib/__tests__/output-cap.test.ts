import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { CappedOutput, OUTPUT_TRUNCATED_MARKER } from '../capped-output'

describe('CappedOutput', () => {
	it('keeps small output verbatim', () => {
		const c = new CappedOutput(10, 20)
		c.push('abc')
		c.push('def')
		expect(c.toString()).toBe('abcdef')
		expect(c.truncated).toBe(false)
	})
	it('keeps head + tail and a marker when over the cap', () => {
		const c = new CappedOutput(10, 20)
		c.push('H'.repeat(10))
		for (let i = 0; i < 100; i++) c.push('mid')
		c.push('T'.repeat(20))
		const s = c.toString()
		expect(c.truncated).toBe(true)
		expect(s.startsWith('H'.repeat(10))).toBe(true)
		expect(s.endsWith('T'.repeat(20))).toBe(true)
		expect(s).toContain(OUTPUT_TRUNCATED_MARKER)
		expect(s.length).toBeLessThan(10 + 20 + OUTPUT_TRUNCATED_MARKER.length + 4)
	})
	it('bounds memory under a flood with the default caps', () => {
		const c = new CappedOutput()
		const chunk = 'x'.repeat(64 * 1024)
		for (let i = 0; i < 200; i++) c.push(chunk) // ~12.8 MB
		expect(c.toString().length).toBeLessThan(256 * 1024 + 1024 * 1024 + 100)
		expect(c.toString()).toContain(OUTPUT_TRUNCATED_MARKER)
	})
	it('prepend adds a banner in front', () => {
		const c = new CappedOutput()
		c.push('body')
		c.prepend('BANNER\n')
		expect(c.toString()).toBe('BANNER\nbody')
	})
})

describe('head -c pipe keeps the exit status', () => {
	const gate = (cmd: string) =>
		spawnSync('bash', ['-c', `( set -o pipefail; ${cmd} 2>&1 | { head -c 2000000; cat >/dev/null; } ) || { echo FAILED; exit 1; }; echo OK`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
	it('failing command still fails', () => {
		const r = gate('echo out; exit 3')
		expect(r.status).toBe(1)
		expect(r.stdout).toContain('FAILED')
	})
	it('passing command passes and flood is capped', () => {
		const r = gate("head -c 3000000 /dev/zero | tr '\\0' x")
		expect(r.stdout.length).toBeLessThan(2000100)
		expect(r.stdout).toContain('OK')
	})
})
