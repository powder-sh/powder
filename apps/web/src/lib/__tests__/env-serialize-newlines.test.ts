import { describe, expect, it } from 'vitest'
import { ENV_KEY_RE, envVarInputError, parseRawEnv, serializeEnv } from '../env-parse'

describe('serializeEnv / parseRawEnv newline consistency', () => {
	it('round-trips a multi-line value (PEM-style) without breaking the file into extra lines', () => {
		const value = 'line1\nline2\r\nline3 "q" $x \\n literal'
		const text = serializeEnv([{ key: 'K', value }, { key: 'NEXT', value: 'v' }])
		expect(text.split('\n').filter(Boolean)).toHaveLength(2)
		expect(parseRawEnv(text)).toEqual([
			{ key: 'K', value },
			{ key: 'NEXT', value: 'v' },
		])
	})
	it('a newline in a value can never smuggle a second variable', () => {
		const text = serializeEnv([{ key: 'A', value: 'x\nEVIL=1' }])
		expect(parseRawEnv(text).map((e) => e.key)).toEqual(['A'])
	})
	it('refuses keys with newline or "="', () => {
		expect(() => serializeEnv([{ key: 'A\nB', value: '1' }])).toThrow()
		expect(() => serializeEnv([{ key: 'A=B', value: '1' }])).toThrow()
	})
	it('ENV_KEY_RE matches the DB key rule', () => {
		expect(ENV_KEY_RE.test('GOOD_1')).toBe(true)
		expect(ENV_KEY_RE.test('BAD\nKEY')).toBe(false)
		expect(ENV_KEY_RE.test('1BAD')).toBe(false)
	})
	it('envVarInputError (used by POST /api/apps) rejects bad keys and newline values', () => {
		expect(envVarInputError({ key: 'OK', value: 'v' })).toBeNull()
		expect(envVarInputError({ key: 'A\nPRIVILEGED', value: 'v' })).not.toBeNull()
		expect(envVarInputError({ key: 'OK', value: 'a\nB=1' })).not.toBeNull()
		expect(envVarInputError({ key: 'OK', value: 'a\rB' })).not.toBeNull()
		expect(envVarInputError({ key: 'a b', value: '' })).not.toBeNull()
		expect(envVarInputError({ key: 'OK' })).not.toBeNull()
	})
})
