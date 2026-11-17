import {
	type ActivityEvent,
	DEFAULT_WINDOW_DAYS,
	PAGE_SIZE,
	activityHref,
	backupEvent,
	backupGroupEvent,
	deployEvent,
	envActorLabel,
	envEvent,
	legsFor,
	mergeFeed,
	parseActivityParams,
	restoreEvent,
	windowStart,
} from '@/lib/activity-feed'
import { describe, expect, it } from 'vitest'

const NOW = new Date('2026-11-04T12:00:00.000Z')

function ev(id: string, iso: string): ActivityEvent {
	return {
		id,
		source: 'deploy',
		at: new Date(iso),
		app: 'a',
		what: 'restart',
		status: 'success',
		detail: null,
		by: null,
		href: '/x',
		queuedAt: null,
	}
}

describe('parseActivityParams', () => {
	it('defaults to all, 7 days, no cursor', () => {
		expect(parseActivityParams({}, NOW)).toEqual({
			filter: 'all',
			days: DEFAULT_WINDOW_DAYS,
			before: null,
		})
		expect(DEFAULT_WINDOW_DAYS).toBe(7)
	})

	it('accepts known filters and windows', () => {
		const p = parseActivityParams({ filter: 'failures', days: '30' }, NOW)
		expect(p.filter).toBe('failures')
		expect(p.days).toBe(30)
	})

	it('rejects unknown filters and windows', () => {
		const p = parseActivityParams({ filter: 'crons', days: '365' }, NOW)
		expect(p.filter).toBe('all')
		expect(p.days).toBe(7)
		expect(parseActivityParams({ days: 'abc' }, NOW).days).toBe(7)
	})

	it('takes the first value of repeated params', () => {
		expect(parseActivityParams({ filter: ['env', 'backups'] }, NOW).filter).toBe('env')
	})

	it('parses an ISO cursor and drops bad or future ones', () => {
		expect(parseActivityParams({ before: '2026-11-03T10:00:00.000Z' }, NOW).before).toEqual(
			new Date('2026-11-03T10:00:00.000Z'),
		)
		expect(parseActivityParams({ before: 'yesterday' }, NOW).before).toBeNull()
		expect(parseActivityParams({ before: '2026-13-99T00:00:00Z' }, NOW).before).toBeNull()
		expect(parseActivityParams({ before: '2027-01-01T00:00:00Z' }, NOW).before).toBeNull()
		expect(parseActivityParams({ before: '1700000000' }, NOW).before).toBeNull()
	})

	it('computes the window start from now', () => {
		const p = parseActivityParams({ days: '1' }, NOW)
		expect(windowStart(p, NOW).toISOString()).toBe('2026-11-03T12:00:00.000Z')
	})
})

describe('activityHref', () => {
	const base = parseActivityParams({}, NOW)
	it('keeps the default URL canonical', () => {
		expect(activityHref(base)).toBe('/activity')
	})
	it('carries filter, window and cursor', () => {
		const href = activityHref(base, {
			filter: 'env',
			days: 30,
			before: new Date('2026-11-01T00:00:00.000Z'),
		})
		expect(href).toBe('/activity?filter=env&days=30&before=2026-11-01T00%3A00%3A00.000Z')
		expect(
			parseActivityParams(Object.fromEntries(new URL(href, 'http://x').searchParams), NOW),
		).toEqual({ filter: 'env', days: 30, before: new Date('2026-11-01T00:00:00.000Z') })
	})
})

describe('legsFor', () => {
	it('all: activity deploys, env, failed backups only, restores', () => {
		expect(legsFor('all')).toEqual({
			deploys: 'activity',
			envAudit: true,
			backups: 'failed',
			restores: 'all',
		})
	})
	it('backups: collapsed successes and restores, no deploys or env', () => {
		expect(legsFor('backups')).toEqual({
			deploys: null,
			envAudit: false,
			backups: 'all',
			restores: 'all',
		})
	})
	it('failures: only failed legs, no env (audit rows have no failure)', () => {
		expect(legsFor('failures')).toEqual({
			deploys: 'failed',
			envAudit: false,
			backups: 'failed',
			restores: 'failed',
		})
	})
	it('env: env_change deploys and the audit trail', () => {
		expect(legsFor('env')).toMatchObject({ deploys: 'env', envAudit: true, backups: null })
	})
})

describe('mappers', () => {
	it('deploy: failed git deploy links to the deploy and shows the summary', () => {
		const e = deployEvent({
			id: 'dep_1',
			containerName: 'shop',
			kind: 'git_deploy',
			status: 'failed',
			queuedAt: null,
			startedAt: NOW,
			triggeredBy: 'github',
			gitSha: 'abcdef1234567',
			errorSummary: 'health check failed; auto-rolled back to x',
		})
		expect(e).toMatchObject({
			what: 'deploy abcdef1',
			href: '/deploys/dep_1',
			detail: 'health check failed; auto-rolled back to x',
		})
	})

	it('deploy: no error detail on success, kind from the shared vocabulary', () => {
		const e = deployEvent({
			id: 'd',
			containerName: 'a',
			kind: 'manual_apply',
			status: 'success',
			queuedAt: null,
			startedAt: NOW,
			triggeredBy: null,
			gitSha: null,
			errorSummary: 'stale',
		})
		expect(e.what).toBe('apply')
		expect(e.detail).toBeNull()
	})

	it('env: key and action, never a value preview', () => {
		const e = envEvent({
			id: 'aud_1',
			createdAt: NOW,
			appRepoId: 'rep_1',
			appName: 'blog',
			action: 'update',
			key: 'DATABASE_URL',
			scope: 'production',
			actorKind: 'human_session',
			actorUserId: 'u1',
			actorEmail: 'admin@example.test',
			actorIp: '1.2.3.4',
		})
		expect(e).toMatchObject({
			what: 'env update',
			detail: 'DATABASE_URL',
			by: 'admin@example.test',
			href: '/projects/rep_1/env',
			status: null,
		})
		expect(JSON.stringify(e)).not.toMatch(/preview/i)
	})

	it('env: non-production scope is shown, actor labels', () => {
		const e = envEvent({
			id: 'a',
			createdAt: NOW,
			appRepoId: 'rep_2',
			appName: null,
			action: 'create',
			key: 'X',
			scope: 'preview',
			actorKind: 'system',
			actorUserId: null,
			actorEmail: null,
			actorIp: null,
		})
		expect(e.detail).toBe('X (preview)')
		expect(e.app).toBe('rep_2')
		expect(e.by).toBe('system')
		expect(
			envActorLabel({ actorKind: 'api_token', actorUserId: 'u1', actorEmail: null, actorIp: null }),
		).toBe('token (u1)')
		expect(
			envActorLabel({
				actorKind: 'human_session',
				actorUserId: null,
				actorEmail: null,
				actorIp: null,
			}),
		).toBe('unknown')
	})

	it('backup: failed row shows the first error line, links to the backups tab', () => {
		const e = backupEvent({
			id: 'bk_1',
			serverId: 's',
			containerName: 'bigdb',
			status: 'failed',
			startedAt: NOW,
			error: '\n s3_upload_http_400 \nmore',
			repoId: 'rep_9',
		})
		expect(e.detail).toBe('s3_upload_http_400')
		expect(e.href).toBe('/projects/rep_9/backups')
	})

	it('backup: no repo row falls back to the server container page', () => {
		const e = backupEvent({
			id: 'bk_2',
			serverId: 'server-1',
			containerName: 'orphan',
			status: 'running',
			startedAt: NOW,
			error: null,
			repoId: null,
		})
		expect(e.href).toBe('/servers/server-1/orphan')
		expect(e.detail).toBeNull()
	})

	it('backup group: one row per app per day, pluralised', () => {
		const many = backupGroupEvent({
			serverId: 's',
			containerName: 'a',
			day: '2026-11-04',
			count: 24,
			lastAt: NOW,
			repoId: 'r',
		})
		expect(many).toMatchObject({
			id: 'backups:s/a/2026-11-04',
			what: '24 backups ok',
			status: 'success',
			at: NOW,
		})
		const one = backupGroupEvent({
			serverId: 's',
			containerName: 'a',
			day: '2026-11-03',
			count: 1,
			lastAt: NOW,
			repoId: null,
		})
		expect(one.what).toBe('1 backup ok')
		expect(one.id).not.toBe(many.id)
	})

	it('restore: kind label, target db on success, error on failure', () => {
		const base = {
			id: 'rs',
			serverId: 's',
			containerName: 'a',
			kind: 'restore',
			startedAt: NOW,
			requestedBy: 'admin',
			targetDb: 'app_restore_20261104_1200',
			error: 'boom',
			repoId: 'r',
		}
		expect(restoreEvent({ ...base, status: 'success' })).toMatchObject({
			what: 'backup restore',
			detail: 'app_restore_20261104_1200',
		})
		expect(restoreEvent({ ...base, status: 'failed' }).detail).toBe('boom')
	})
})

describe('mergeFeed', () => {
	it('merges legs newest first', () => {
		const page = mergeFeed([
			[ev('deploy:1', '2026-11-04T10:00:00Z'), ev('deploy:2', '2026-11-01T10:00:00Z')],
			[ev('env:1', '2026-11-03T10:00:00Z')],
			[],
		])
		expect(page.events.map((e) => e.id)).toEqual(['deploy:1', 'env:1', 'deploy:2'])
		expect(page.nextBefore).toBeNull()
	})

	it('breaks timestamp ties by id so the order is stable', () => {
		const t = '2026-11-04T10:00:00Z'
		const a = mergeFeed([[ev('env:b', t)], [ev('deploy:a', t)]])
		const b = mergeFeed([[ev('deploy:a', t)], [ev('env:b', t)]])
		expect(a.events.map((e) => e.id)).toEqual(['deploy:a', 'env:b'])
		expect(b.events.map((e) => e.id)).toEqual(a.events.map((e) => e.id))
	})

	it('cuts at the page size and returns the oldest shown time as the cursor', () => {
		const leg1 = Array.from({ length: 3 }, (_, i) =>
			ev(`deploy:${i}`, new Date(NOW.getTime() - i * 2000).toISOString()),
		)
		const leg2 = Array.from({ length: 3 }, (_, i) =>
			ev(`env:${i}`, new Date(NOW.getTime() - i * 2000 - 1000).toISOString()),
		)
		const page = mergeFeed([leg1, leg2], 4)
		expect(page.events.map((e) => e.id)).toEqual(['deploy:0', 'env:0', 'deploy:1', 'env:1'])
		expect(page.nextBefore).toEqual(page.events[3]?.at)
	})

	it('no cursor when the total fits exactly in a page', () => {
		const leg = Array.from({ length: PAGE_SIZE }, (_, i) =>
			ev(`deploy:${i}`, new Date(NOW.getTime() - i * 1000).toISOString()),
		)
		const page = mergeFeed([leg])
		expect(page.events).toHaveLength(PAGE_SIZE)
		expect(page.nextBefore).toBeNull()
	})

	it('cursor when one leg alone overflows the page', () => {
		const leg = Array.from({ length: PAGE_SIZE + 1 }, (_, i) =>
			ev(`backup:${i}`, new Date(NOW.getTime() - i * 1000).toISOString()),
		)
		const page = mergeFeed([leg, []])
		expect(page.events).toHaveLength(PAGE_SIZE)
		expect(page.nextBefore).toEqual(leg[PAGE_SIZE - 1]?.at)
	})
})
