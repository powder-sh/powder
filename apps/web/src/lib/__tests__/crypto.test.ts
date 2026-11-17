import { createCipheriv, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from '../crypto'

const KEY = 'a'.repeat(64)
const saved = process.env.POWDER_ENCRYPTION_KEY
beforeEach(() => {
	process.env.POWDER_ENCRYPTION_KEY = KEY
})
afterEach(() => {
	if (saved === undefined) delete process.env.POWDER_ENCRYPTION_KEY
	else process.env.POWDER_ENCRYPTION_KEY = saved
})

// What encryptSecret wrote before the v1 prefix existed.
function unprefixed(pt: string, key = KEY): string {
	const iv = randomBytes(12)
	const c = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv)
	const ct = Buffer.concat([c.update(pt, 'utf8'), c.final()])
	return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${ct.toString('hex')}`
}

describe('crypto', () => {
	it('writes the v1 format and round-trips', () => {
		const e = encryptSecret('hello')
		expect(e).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/)
		expect(decryptSecret(e)).toBe('hello')
	})
	it('decrypts the unprefixed iv:tag:ct format', () => {
		expect(decryptSecret(unprefixed('old secret'))).toBe('old secret')
	})
	it('rejects a truncated auth tag (both formats)', () => {
		const [iv, tag, ct] = unprefixed('x').split(':') as [string, string, string]
		expect(() => decryptSecret(`${iv}:${tag.slice(0, 8)}:${ct}`)).toThrow(/auth tag length/)
		expect(() => decryptSecret(`v1:${iv}:${tag.slice(0, 8)}:${ct}`)).toThrow(/auth tag length/)
	})
	it('rejects a wrong-size IV and non-hex parts', () => {
		const [iv, tag, ct] = unprefixed('x').split(':') as [string, string, string]
		expect(() => decryptSecret(`${iv.slice(0, 16)}:${tag}:${ct}`)).toThrow(/IV length/)
		expect(() => decryptSecret(`${iv}:${tag}zz:${ct}`)).toThrow(/malformed/)
		expect(() => decryptSecret(`${'g'.repeat(24)}:${tag}:${ct}`)).toThrow(/malformed/)
	})
	it('rejects unknown versions and malformed shapes', () => {
		const [iv, tag, ct] = unprefixed('x').split(':') as [string, string, string]
		expect(() => decryptSecret(`v2:${iv}:${tag}:${ct}`)).toThrow(/version/)
		expect(() => decryptSecret('a:b')).toThrow(/malformed/)
	})
	it('fails closed with the wrong key and on a tampered ciphertext', () => {
		const e = encryptSecret('hello')
		process.env.POWDER_ENCRYPTION_KEY = 'b'.repeat(64)
		expect(() => decryptSecret(e)).toThrow()
		process.env.POWDER_ENCRYPTION_KEY = KEY
		const parts = e.split(':')
		parts[3] = (parts[3] as string).replace(/.$/, (c) => (c === '0' ? '1' : '0'))
		expect(() => decryptSecret(parts.join(':'))).toThrow()
	})
	it('rejects a non-hex 64-char key', () => {
		process.env.POWDER_ENCRYPTION_KEY = 'z'.repeat(64)
		expect(() => encryptSecret('x')).toThrow(/POWDER_ENCRYPTION_KEY/)
	})
})
