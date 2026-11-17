import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redactSecrets as S } from '../secret-text'

// ── mocks for notify() ───────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
	targets: [] as Array<Record<string, unknown>>,
	appId: null as string | null,
	mails: [] as Array<{ to: string; subject: string }>,
	getServer: vi.fn(async () => null),
}))

vi.mock('../db', () => {
	const notificationTargets = { __t: 'targets', enabled: 'enabled' }
	const appRepos = { __t: 'apps', id: 'id', serverId: 'server_id', containerName: 'container_name' }
	const select = () => ({
		from: (t: { __t: string }) => ({
			where: () => {
				if (t.__t === 'targets') {
					const rows = state.targets.filter((r) => r.enabled)
					return Object.assign(Promise.resolve(rows), { limit: async () => rows })
				}
				const rows = state.appId ? [{ id: state.appId }] : []
				return Object.assign(Promise.resolve(rows), { limit: async () => rows })
			},
		}),
	})
	return {
		db: { select },
		notificationTargets,
		appRepos,
		and: () => null,
		eq: () => null,
		account: {},
	}
})
vi.mock('../crypto', () => ({ decryptSecret: (s: string) => s.replace(/^enc:/, '') }))
vi.mock('../notify-url-guard', () => ({
	checkWebhookUrl: async (u: string) => ({ ok: true, url: new URL(u) }),
	// Passthrough to the stubbed fetch so the tests can inspect what was sent;
	// redirect: 'manual' mirrors guardedPost (node:http never follows).
	guardedPost: async (u: string, o: { headers: Record<string, string>; body: string }) =>
		(await fetch(u, { method: 'POST', headers: o.headers, body: o.body, redirect: 'manual' })).status,
}))
vi.mock('../mailer', () => ({
	sendMail: async (m: { to: string; subject: string }) => {
		state.mails.push(m)
		return true
	},
}))
vi.mock('../hosts', () => ({ dashboardUrl: () => 'https://powder.test' }))
vi.mock('../github', () => ({}))
vi.mock('../ssh', () => ({}))
vi.mock('../servers', () => ({ getServer: state.getServer }))
vi.mock('../oauth-token', () => ({}))

import { notify, notifyDeployFailed, notifyDeploySucceeded } from '../notifications'
import {
	DEFAULT_DEDUPE_MS,
	ENV_WEBHOOK_EVENTS,
	NotifyDedupe,
	dedupeWindowMs,
	envWebhookTarget,
	routeTargets,
	targetWants,
} from '../notify-routing'
import { syncDeploymentMd } from '../sync-deployment-md'

function target(
	over: Partial<{
		id: string
		kind: string
		events: string[]
		appRepoId: string | null
		enabled: boolean
		urlEncrypted: string | null
		email: string | null
	}>,
) {
	return {
		id: 'ntf_1',
		kind: 'webhook',
		events: ['deploy_failed'],
		appRepoId: null,
		enabled: true,
		urlEncrypted: 'enc:https://hook.test/a',
		email: null,
		createdAt: new Date(),
		...over,
	}
}

let fetchMock: ReturnType<typeof vi.fn>
let n = 0
// Unique app per test so the module-level dedupe never leaks between tests.
const app = () => `app${++n}`

beforeEach(() => {
	state.targets = []
	state.appId = null
	state.mails = []
	fetchMock = vi.fn(async (_u: string, _i: RequestInit) => new Response('ok'))
	vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
	vi.unstubAllGlobals()
	process.env.POWDER_NOTIFY_WEBHOOK_URL = ''
})

describe('routing', () => {
	it('matches enabled, subscribed targets with no or a matching app filter', () => {
		expect(targetWants(target({}), 'deploy_failed', null)).toBe(true)
		expect(targetWants(target({ enabled: false }), 'deploy_failed', null)).toBe(false)
		expect(targetWants(target({}), 'app_down', null)).toBe(false)
		expect(targetWants(target({ appRepoId: 'rep_a' }), 'deploy_failed', 'rep_a')).toBe(true)
		expect(targetWants(target({ appRepoId: 'rep_a' }), 'deploy_failed', 'rep_b')).toBe(false)
		// Unknown app: only all-app targets hear it.
		expect(targetWants(target({ appRepoId: 'rep_a' }), 'deploy_failed', null)).toBe(false)
		const ts = [
			target({ id: 'a' }),
			target({ id: 'b', events: ['cron_failed'] }),
			target({ id: 'c', appRepoId: 'x' }),
		]
		expect(routeTargets(ts, 'deploy_failed', 'y').map((t) => t.id)).toEqual(['a'])
	})

	it('notify fans out to matching webhook and email targets only', async () => {
		state.appId = 'rep_a'
		state.targets = [
			target({ id: 'w1', urlEncrypted: 'enc:https://hook.test/w1', events: ['backup_failed'] }),
			target({
				id: 'w2',
				urlEncrypted: 'enc:https://hook.test/w2',
				events: ['backup_failed'],
				appRepoId: 'rep_other',
			}),
			target({
				id: 'e1',
				kind: 'email',
				urlEncrypted: null,
				email: 'ops@example.test',
				events: ['backup_failed'],
				appRepoId: 'rep_a',
			}),
			target({ id: 'w3', urlEncrypted: 'enc:https://hook.test/w3', events: ['deploy_failed'] }),
			target({
				id: 'w4',
				urlEncrypted: 'enc:https://hook.test/w4',
				events: ['backup_failed'],
				enabled: false,
			}),
		]
		const r = await notify('backup_failed', { app: app(), server: 's1', message: S('boom') })
		expect(r).toEqual({ delivered: 2, deduped: false })
		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['https://hook.test/w1'])
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit
		expect(init.redirect).toBe('manual')
		const body = JSON.parse(String(init.body))
		expect(body).toMatchObject({ event: 'backup_failed', server: 's1', message: S('boom') })
		expect(state.mails.map((m) => m.to)).toEqual(['ops@example.test'])
	})
})

describe('dedupe', () => {
	it('drops a repeat inside the window and allows it after', () => {
		let t = 0
		const d = new NotifyDedupe(() => t)
		const k = NotifyDedupe.key('app_down', 's', 'a')
		expect(d.claim(k, 1000)).toBe(true)
		t = 999
		expect(d.claim(k, 1000)).toBe(false)
		expect(d.claim(NotifyDedupe.key('app_down', 's', 'b'), 1000)).toBe(true)
		t = 1000
		expect(d.claim(k, 1000)).toBe(true)
		d.release(k)
		expect(d.claim(k, 1000)).toBe(true)
	})

	it('per-event windows', () => {
		expect(dedupeWindowMs('deploy_failed')).toBe(DEFAULT_DEDUPE_MS)
		expect(dedupeWindowMs('backup_stale')).toBeGreaterThan(60 * 60 * 1000)
		expect(dedupeWindowMs('cron_failed', 10)).toBe(10)
	})

	it('fail, success, fail of one app inside the window sends every deploy event', async () => {
		process.env.POWDER_NOTIFY_WEBHOOK_URL = 'https://env.test/hook'
		state.targets = [target({ events: ['deploy_failed', 'deploy_succeeded'] })]
		const repo = { id: 'rep_1', containerName: app(), serverId: 's1', branch: 'main' } as never
		const fail = (deployId: string) =>
			notifyDeployFailed(repo, { deployId, errorMessage: S('boom'), gitSha: null, gitBranch: null })
		await fail('dep_1')
		await notifyDeploySucceeded(repo, 'dep_2', 'abc1234')
		await fail('dep_3')
		const sent = fetchMock.mock.calls.map((c) => {
			const b = JSON.parse(String((c[1] as RequestInit).body))
			return `${c[0]} ${b.event}`
		})
		// env webhook: both failures (it never gets deploy_succeeded); stored target: all three.
		expect(sent.filter((s) => s.startsWith('https://env.test/hook'))).toEqual([
			'https://env.test/hook deploy_failed',
			'https://env.test/hook deploy_failed',
		])
		expect(sent.filter((s) => s.startsWith('https://hook.test/a'))).toEqual([
			'https://hook.test/a deploy_failed',
			'https://hook.test/a deploy_succeeded',
			'https://hook.test/a deploy_failed',
		])
		// A true repeat of one deploy's failure is still dropped.
		fetchMock.mockClear()
		await fail('dep_3')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('notify sends the same event for the same app once per window', async () => {
		state.targets = [target({ events: ['deploy_failed'] })]
		const a = app()
		expect(
			(await notify('deploy_failed', { app: a, server: 's', message: S('x') })).delivered,
		).toBe(1)
		expect(await notify('deploy_failed', { app: a, server: 's', message: S('x') })).toEqual({
			delivered: 0,
			deduped: true,
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('a fully failed send does not hold the dedupe slot', async () => {
		state.targets = [target({ events: ['deploy_failed'] })]
		fetchMock.mockResolvedValueOnce(new Response('no', { status: 500 }))
		const a = app()
		expect(
			(await notify('deploy_failed', { app: a, server: 's', message: S('x') })).delivered,
		).toBe(0)
		expect(
			(await notify('deploy_failed', { app: a, server: 's', message: S('x') })).delivered,
		).toBe(1)
	})

	it('never throws when the target table cannot be read', async () => {
		state.targets = null as never
		await expect(
			notify('app_down', { app: app(), server: 's', message: S('x') }),
		).resolves.toMatchObject({ delivered: 0 })
	})
})

describe('env webhook back-compat', () => {
	it('is an implicit target for deploy_failed, app_down and app_up only', () => {
		expect(envWebhookTarget({})).toBeNull()
		expect(envWebhookTarget({ POWDER_NOTIFY_WEBHOOK_URL: ' https://h.test/x ' })).toEqual({
			url: 'https://h.test/x',
			events: ENV_WEBHOOK_EVENTS,
		})
		expect([...ENV_WEBHOOK_EVENTS].sort()).toEqual(['app_down', 'app_up', 'cron_failed', 'deploy_failed'])
	})

	it('gets deploy_failed with no rows, and not deploy_succeeded', async () => {
		process.env.POWDER_NOTIFY_WEBHOOK_URL = 'https://env.test/hook'
		await notifyDeployFailed(
			{ id: 'rep_1', containerName: app(), serverId: 's1', branch: 'main' } as never,
			{
				deployId: 'd',
				errorMessage: S('boom'),
				gitSha: 'abcdef123',
				gitBranch: null,
			},
		)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://env.test/hook')
		const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))
		expect(Object.keys(body)).toEqual(
			expect.arrayContaining(['event', 'app', 'server', 'message', 'url', 'at']),
		)
		expect(body.event).toBe('deploy_failed')
		fetchMock.mockClear()
		await notify('deploy_succeeded', { app: app(), server: 's1', message: S('ok') })
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('DEPLOYMENT.md sync opt-in', () => {
	it('skips everything when sync_deployment_md is false', async () => {
		const res = await syncDeploymentMd(
			{ serverId: 's', containerName: 'web', syncDeploymentMd: false } as never,
			null,
		)
		expect(res.ok).toBe(true)
		expect(res.reason).toMatch(/disabled/)
		expect(state.getServer).not.toHaveBeenCalled()
	})
	it('runs when enabled', async () => {
		const res = await syncDeploymentMd(
			{ serverId: 's', containerName: 'web', syncDeploymentMd: true } as never,
			null,
		)
		expect(state.getServer).toHaveBeenCalledWith('s')
		expect(res).toEqual({ ok: false, reason: 'server s not found' })
	})
})

describe('migrations 0051 / 0052', () => {
	const dir = resolve(__dirname, '../../../../../packages/db/drizzle')
	for (const f of ['0051_app_repos_sync_deployment_md.sql', '0052_notification_targets.sql']) {
		it(`${f} carries -- idempotent and only guarded DDL`, () => {
			const sql = readFileSync(join(dir, f), 'utf8')
			expect(sql.split('\n')).toContain('-- idempotent')
			for (const stmt of sql.match(/^(CREATE|ALTER)[^;]*/gm) ?? []) {
				expect(stmt).toMatch(/IF NOT EXISTS/)
			}
		})
	}
	it('0051 adds sync_deployment_md default false', () => {
		const sql = readFileSync(join(dir, '0051_app_repos_sync_deployment_md.sql'), 'utf8')
		expect(sql).toMatch(
			/ADD COLUMN IF NOT EXISTS "sync_deployment_md" boolean NOT NULL DEFAULT false/,
		)
		const code = sql
			.split('\n')
			.filter((l) => !l.startsWith('--'))
			.join('\n')
		expect(code).not.toMatch(/UPDATE/i)
	})
})
