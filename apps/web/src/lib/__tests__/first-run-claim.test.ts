// a first-run claim whose user create failed is released on a
// later attempt while the user table is still empty; a concurrent second login
// inside the in-flight window is still refused.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
	process.env.POWDER_ADMIN_USER_IDS = ''
	return { count: 0 }
})

vi.mock('../db', () => ({
	sql: () => 0,
	asc: () => 0,
	user: {},
	db: {
		select: () => ({ from: () => Promise.resolve([{ n: h.count }]) }),
		// a granted first-run claim clears a stale stored first-run admin.
		execute: async () => [],
	},
}))

import {
	FIRST_RUN_CLAIM_WINDOW_MS,
	SETUP_COOKIE,
	allowUserCreate,
	resetFirstRunClaim,
	resetSetupToken,
	setupToken,
} from '../first-run'

beforeEach(() => {
	resetFirstRunClaim()
	resetSetupToken()
	h.count = 0
	vi.spyOn(console, 'warn').mockImplementation(() => {})
	vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('first-run claim', () => {
	it('a failed create does not shut first run for good', async () => {
		const cookie = `${SETUP_COOKIE}=${setupToken()}`
		const t0 = 1_000_000
		expect(await allowUserCreate(cookie, t0)).toBe(true)
		// The create failed: no row. A concurrent login inside the window is refused.
		expect(await allowUserCreate(cookie, t0 + 1000)).toBe(false)
		// Next attempt after the window, table still empty: released, allowed again.
		expect(await allowUserCreate(cookie, t0 + FIRST_RUN_CLAIM_WINDOW_MS + 1)).toBe(true)
	})
	it('after a successful first user the next attempt stays refused', async () => {
		const cookie = `${SETUP_COOKIE}=${setupToken()}`
		const t0 = 2_000_000
		expect(await allowUserCreate(cookie, t0)).toBe(true)
		h.count = 1
		expect(await allowUserCreate(cookie, t0 + FIRST_RUN_CLAIM_WINDOW_MS + 1)).toBe(false)
		expect(await allowUserCreate(cookie, t0 + 2 * FIRST_RUN_CLAIM_WINDOW_MS + 2)).toBe(false)
	})
	it('no setup cookie is refused even when the claim is stale', async () => {
		const cookie = `${SETUP_COOKIE}=${setupToken()}`
		expect(await allowUserCreate(cookie, 0)).toBe(true)
		expect(await allowUserCreate(null, FIRST_RUN_CLAIM_WINDOW_MS + 1)).toBe(false)
	})
})
