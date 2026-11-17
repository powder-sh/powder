// The stored first-run admin is only a bridge until
// POWDER_ADMIN_USER_IDS is persisted. Once it is set at a boot, the stored id is
// deleted, so an admin the operator later removes from the env (or an env emptied
// to lock everyone out) is never brought back from powder_meta.
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
	process.env.POWDER_ADMIN_USER_IDS = 'usr_env'
	return { meta: new Map<string, string>([['first_run_admin', 'usr_owner']]) }
})

vi.mock('../db', () => ({
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		text: strings.join('?'),
		values,
	}),
	asc: () => 0,
	eq: (_c: unknown, v: string) => v,
	user: { id: 'id' },
	db: {
		select: () => {
			throw new Error('no user lookup expected with POWDER_ADMIN_USER_IDS set')
		},
		execute: async (q: { text: string; values: string[] }) => {
			if (q.text.startsWith('DELETE FROM powder_meta')) {
				h.meta.delete(q.values[0] as string)
				return []
			}
			throw new Error(`unexpected query ${q.text}`)
		},
	},
}))

import { isAdminUserId } from '../admin-ids'
import { announceSetupTokenIfFirstRun, restoreFirstRunAdmin } from '../first-run'

describe('POWDER_ADMIN_USER_IDS set at boot', () => {
	it('the boot hook (web) deletes the stored first-run admin and does not register it', async () => {
		await announceSetupTokenIfFirstRun()
		expect(h.meta.has('first_run_admin')).toBe(false)
		expect(isAdminUserId('usr_owner')).toBe(false)
	})
	it('restore (worker) deletes it too and returns null', async () => {
		h.meta.set('first_run_admin', 'usr_owner')
		expect(await restoreFirstRunAdmin()).toBe(null)
		expect(h.meta.has('first_run_admin')).toBe(false)
		expect(isAdminUserId('usr_owner')).toBe(false)
	})
})
