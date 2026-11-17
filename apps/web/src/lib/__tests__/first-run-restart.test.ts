// the first-run admin lived only in memory, so a restart before the owner
// set POWDER_ADMIN_USER_IDS locked them out (and a plain `restart` does not re-read
// the env file anyway). It is now stored in powder_meta and restored at boot while
// POWDER_ADMIN_USER_IDS is empty, with a WARN to set the env.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
	process.env.POWDER_ADMIN_USER_IDS = ''
	return { meta: new Map<string, string>(), users: ['usr_owner'] }
})

vi.mock('../db', () => {
	const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
		text: strings.join('?'),
		values,
	})
	const chain = (rows: () => unknown[]) => {
		const c: Record<string, unknown> = {}
		for (const k of ['from', 'orderBy', 'where']) c[k] = () => c
		c.limit = () => Promise.resolve(rows())
		// userTableIsEmpty awaits select({ n }).from(user) directly.
		c.then = (res: (v: unknown) => void) => res([{ n: h.users.length }])
		return c
	}
	return {
		sql,
		asc: () => 0,
		eq: (_c: unknown, v: string) => v,
		user: { id: 'id', createdAt: 'created_at' },
		db: {
			// onFirstUserCreated: the oldest user; restore: does the stored user exist.
			select: () => chain(() => h.users.slice(0, 1).map((id) => ({ id }))),
			execute: async (q: { text: string; values: string[] }) => {
				if (q.text.startsWith('INSERT INTO powder_meta')) {
					if (!h.meta.has(q.values[0] ?? '')) h.meta.set(q.values[0] ?? '', q.values[1] ?? '')
					return []
				}
				if (q.text.startsWith('DELETE FROM powder_meta')) {
					h.meta.delete(q.values[0] ?? '')
					return []
				}
				if (q.text.startsWith('SELECT value FROM powder_meta')) {
					const v = h.meta.get(q.values[0] ?? '')
					return v ? [{ value: v }] : []
				}
				throw new Error(`unexpected query ${q.text}`)
			},
		},
	}
})

import { isAdminUserId } from '../admin-ids'
import {
	FIRST_RUN_ADMIN_META_KEY,
	SETUP_COOKIE,
	allowUserCreate,
	onFirstUserCreated,
	resetFirstRunClaim,
	restoreFirstRunAdmin,
	setupToken,
} from '../first-run'

const restart = () => {
	;(globalThis as { __powderBootstrapAdmins?: Set<string> }).__powderBootstrapAdmins = undefined
}

beforeEach(() => {
	h.meta.clear()
	h.users = ['usr_owner']
	restart()
	vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('first-run admin survives a restart', () => {
	it('stores the claimed admin and restores it at boot with a WARN', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		await onFirstUserCreated('usr_owner', 'o@example.com')
		expect(isAdminUserId('usr_owner')).toBe(true)
		expect(h.meta.get(FIRST_RUN_ADMIN_META_KEY)).toBe('usr_owner')
		expect(log.mock.calls.flat().join('\n')).toContain(
			'docker compose --env-file /opt/apps/powder.env up -d --force-recreate powder worker',
		)
		expect(log.mock.calls.flat().join('\n')).toContain('sudo bin/install.sh --set-admin usr_owner')
		restart()
		expect(isAdminUserId('usr_owner')).toBe(false)
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		expect(await restoreFirstRunAdmin()).toBe('usr_owner')
		expect(isAdminUserId('usr_owner')).toBe(true)
		expect(warn.mock.calls.flat().join('\n')).toContain(
			'POWDER_ADMIN_USER_IDS is empty; the admin is the first-run user usr_owner',
		)
		expect(warn.mock.calls.flat().join('\n')).toContain('bin/install.sh --set-admin usr_owner')
	})
	it('names the env file from POWDER_ENV_FILE when set', async () => {
		const saved = process.env.POWDER_ENV_FILE
		process.env.POWDER_ENV_FILE = '/etc/powder/powder.env'
		try {
			const log = vi.spyOn(console, 'log').mockImplementation(() => {})
			await onFirstUserCreated('usr_owner', 'o@example.com')
			expect(log.mock.calls.flat().join('\n')).toContain('POWDER_ADMIN_USER_IDS=usr_owner in /etc/powder/powder.env, then')
			restart()
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			await restoreFirstRunAdmin()
			expect(warn.mock.calls.flat().join('\n')).toContain('POWDER_ADMIN_USER_IDS=usr_owner in /etc/powder/powder.env, then')
		} finally {
			if (saved === undefined) delete process.env.POWDER_ENV_FILE
			else process.env.POWDER_ENV_FILE = saved
		}
	})
	it('a stored id whose user row is gone is not restored', async () => {
		h.meta.set(FIRST_RUN_ADMIN_META_KEY, 'usr_gone')
		h.users = []
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		expect(await restoreFirstRunAdmin()).toBe(null)
		expect(isAdminUserId('usr_gone')).toBe(false)
		expect(h.meta.has(FIRST_RUN_ADMIN_META_KEY)).toBe(false)
	})
	it('a fresh first run (user table empty again) clears a stale stored id before the claim', async () => {
		h.meta.set(FIRST_RUN_ADMIN_META_KEY, 'usr_old')
		h.users = []
		resetFirstRunClaim()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		expect(await allowUserCreate(`${SETUP_COOKIE}=${setupToken()}`)).toBe(true)
		expect(h.meta.has(FIRST_RUN_ADMIN_META_KEY)).toBe(false)
	})
	it('the first stored admin is never replaced', async () => {
		await onFirstUserCreated('usr_owner', 'o@example.com')
		h.users = ['usr_other']
		await onFirstUserCreated('usr_other', 'x@example.com')
		expect(h.meta.get(FIRST_RUN_ADMIN_META_KEY)).toBe('usr_owner')
	})
})
