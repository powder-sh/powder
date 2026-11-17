import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../crypto', () => ({ encryptSecret: (v: string) => v, decryptSecret: (v: string) => v }))
import { makePreview } from '../env-vars-db'

describe('makePreview', () => {
	it('stores length only, never a plaintext prefix', () => {
		const p = makePreview('sk_' + 'live_abcdefghijklmnopqrstuvwxyz123456')
		expect(p).toBe('•••• (40 chars)')
		expect(p).not.toContain('sk_l')
	})
	it('short values do not return an empty hint, but still no content', () => {
		expect(makePreview('abc')).toBe('•••• (3 chars)')
		expect(makePreview('')).toBe('')
	})
})
