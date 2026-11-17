import { beforeEach, describe, expect, it, vi } from 'vitest'

// Existing installs (POWDER_ADMIN_USER_IDS set): the setup token changes nothing.
// No user is ever created through the auth layer, no token is generated or logged.
const h = vi.hoisted(() => {
	process.env.POWDER_ADMIN_USER_IDS = 'admin1'
	return { count: 0, queried: 0 }
})

vi.mock('../db', () => ({
	sql: () => 0,
	asc: () => 0,
	user: {},
	db: {
		select: () => ({
			from: () => {
				h.queried++
				return Promise.resolve([{ n: h.count }])
			},
		}),
	},
}))

import {
	SETUP_COOKIE,
	allowUserCreate,
	announceSetupTokenIfFirstRun,
	firstRunOpen,
	resetFirstRunClaim,
	resetSetupToken,
	setupToken,
} from '../first-run'

beforeEach(() => {
	resetFirstRunClaim()
	resetSetupToken()
	h.queried = 0
})

describe('first run with POWDER_ADMIN_USER_IDS set', () => {
	it('never allows creating a user, with or without a setup cookie', async () => {
		h.count = 0
		expect(await allowUserCreate()).toBe(false)
		expect(await allowUserCreate(`${SETUP_COOKIE}=${setupToken()}`)).toBe(false)
		expect(h.queried).toBe(0)
	})

	it('boot prints no setup token and first-run is closed', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		await announceSetupTokenIfFirstRun()
		expect(log).not.toHaveBeenCalled()
		expect(await firstRunOpen()).toBe(false)
		log.mockRestore()
	})
})
