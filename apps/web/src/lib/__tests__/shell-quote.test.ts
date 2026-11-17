import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { assertSafeName, shellQuote, shq } from '../shell'

describe('shq', () => {
	const cases: [string, string, string][] = [
		['empty', '', `''`],
		['plain', 'abc', `'abc'`],
		['space', 'a b', `'a b'`],
		['single quote', `it's`, `'it'\\''s'`],
		['only a quote', `'`, `''\\'''`],
		['dollar', '$HOME', `'$HOME'`],
		['command subst', '$(id)`id`', "'$(id)`id`'"],
		['double quote', 'a"b', `'a"b'`],
		['newline', 'a\nb', `'a\nb'`],
		['backslash', 'a\\b', `'a\\b'`],
		['semicolon', 'a; echo pwned', `'a; echo pwned'`],
	]
	for (const [name, input, want] of cases) {
		it(`quotes ${name}`, () => {
			expect(shq(input)).toBe(want)
			expect(shellQuote(input)).toBe(want)
		})
		it(`round-trips ${name} through sh`, () => {
			expect(execFileSync('sh', ['-c', `printf %s ${shq(input)}`]).toString()).toBe(input)
		})
	}
})

describe('assertSafeName', () => {
	it('accepts container-style names and returns them', () => {
		expect(assertSafeName('my-app_1.web')).toBe('my-app_1.web')
	})
	it.each(['', 'a b', 'a;b', '$x', 'a/b'])('rejects %j', (n) => {
		expect(() => assertSafeName(n)).toThrow(/unsafe container name/)
	})
})
