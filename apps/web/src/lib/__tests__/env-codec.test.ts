import { describe, expect, it } from 'vitest'
import { encodeEnvValue, parseRawEnv, serializeEnv } from '../env-parse'

// One codec: whatever encodeEnvValue / serializeEnv writes, parseRawEnv reads back exactly.
const VALUES = [
	'plain',
	'p$ss',
	'say "hi"',
	'back\\slash',
	'tick`tick',
	'a # not a comment',
	'  leading and trailing  ',
	'two\nlines',
	'crlf\r\nline',
	'-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----\n',
	'export K=sneaky',
	'line\nexport K=sneaky\nK2=1',
	"it's",
	'',
	'$(whoami) ${HOME} \\$x \\"q\\"',
]

describe('env text codec', () => {
	it('render -> parseRawEnv returns exactly the keys and values', () => {
		const entries = VALUES.map((value, i) => ({ key: `K${i}`, value }))
		const text = serializeEnv(entries)
		expect(parseRawEnv(text)).toEqual(entries)
		// one physical line per entry: a value can never create a junk key
		expect(text.split('\n').filter(Boolean)).toHaveLength(entries.length)
	})
	it('encodeEnvValue is what serializeEnv writes (one encoder)', () => {
		for (const v of VALUES) expect(serializeEnv([{ key: 'A', value: v }])).toBe(`A=${encodeEnvValue(v)}\n`)
	})
	it('env-vars-db uses the shared encoder and bulk import uses parseRawEnv', async () => {
		const { readFileSync } = await import('node:fs')
		const src = readFileSync(new URL('../env-vars-db.ts', import.meta.url), 'utf8')
		expect(src).not.toMatch(/function escapeEnvValue/)
		expect(src).toMatch(/encodeEnvValue\(v\)/)
		const bulk = src.slice(src.indexOf('export async function bulkImportFromText'))
		expect(bulk.slice(0, 1500)).toMatch(/parseRawEnv\(text\)/)
	})
	it('imports a pasted .env with escapes, export and inline comments intact', () => {
		const pasted = 'export A=1\nK="p\\$ss" # note\nB=v # comment\n'
		expect(parseRawEnv(pasted)).toEqual([
			{ key: 'A', value: '1' },
			{ key: 'K', value: 'p$ss' },
			{ key: 'B', value: 'v' },
		])
	})
})
