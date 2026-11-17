import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { backupKeyWarnings, estimatedEntropyBits } from '../startup-checks'

const env = (k: string | undefined) => ({ POWDER_BACKUP_KEY: k }) as unknown as NodeJS.ProcessEnv

describe('POWDER_BACKUP_KEY strength warning', () => {
	it('is silent for generated keys (openssl rand -hex 32 / -base64 32)', () => {
		expect(backupKeyWarnings(env(randomBytes(32).toString('hex')))).toEqual([])
		expect(backupKeyWarnings(env(randomBytes(32).toString('base64')))).toEqual([])
	})

	it('is silent when unset (backups are simply not configured)', () => {
		expect(backupKeyWarnings(env(undefined))).toEqual([])
	})

	it('warns on a short key', () => {
		const w = backupKeyWarnings(env('hunter2'))
		expect(w).toHaveLength(1)
		expect(w[0]).toMatch(/only 7 characters/)
		expect(w[0]).toMatch(/openssl rand -hex 32/)
		// Never echoes the key itself into the log.
		expect(w[0]).not.toContain('hunter2')
	})

	it('warns on a long but low-entropy key', () => {
		const k = 'ab'.repeat(30)
		const w = backupKeyWarnings(env(k))
		expect(w[0]).toMatch(/low-entropy/)
		expect(w[0]).not.toContain(k)
	})

	it('warns on a placeholder', () => {
		expect(backupKeyWarnings(env('CHANGE_ME_change_me_change_me_change_me'))[0]).toMatch(
			/placeholder/,
		)
	})

	it('entropy estimate: zero for one repeated char, high for random hex', () => {
		expect(estimatedEntropyBits('a'.repeat(64))).toBe(0)
		expect(estimatedEntropyBits(randomBytes(32).toString('hex'))).toBeGreaterThan(200)
	})
})
