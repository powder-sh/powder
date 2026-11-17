import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({}))
vi.mock('../db', () => ({}))
vi.mock('../ssh', () => ({}))
vi.mock('../servers', () => ({}))
vi.mock('../powder-config', () => ({}))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => false }))

import { verifyTxtChallenge } from '../app-domains'

describe('verifyTxtChallenge', () => {
	it('fails with no record', async () => {
		const r = await verifyTxtChallenge('a.com', 'tok', async () => {
			throw new Error('ENODATA')
		})
		expect(r.ok).toBe(false)
	})
	it('fails on a different token', async () => {
		expect((await verifyTxtChallenge('a.com', 'tok', async () => [['nope']])).ok).toBe(false)
	})
	it('queries _powder-verify.<host> and accepts split strings', async () => {
		let asked = ''
		const r = await verifyTxtChallenge('A.com', 'tok123', async (n) => {
			asked = n
			return [['tok', '123']]
		})
		expect(asked).toBe('_powder-verify.a.com')
		expect(r.ok).toBe(true)
	})
	it('fails without a token', async () => {
		expect((await verifyTxtChallenge('a.com', null, async () => [['x']])).ok).toBe(false)
	})
})
