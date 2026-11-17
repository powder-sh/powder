import { describe, expect, it } from 'vitest'
import { type DeployRow, staticBlockers } from '../auto-rollback'
import {
	DEPLOY_SETTLE_MAX_SECONDS,
	commitMessageIsUrgent,
	effectiveSettleSeconds,
	utcClock,
	heldSql,
	isSettleTrigger,
	parseSettleSeconds,
	pushIsUrgent,
	settleNote,
} from '../deploy-settle'

// Pure half of the settle window (lib/deploy-settle.ts). The DB behaviour is in
// deploy-settle.db.test.ts, the webhook mapping in webhook-settle-urgent.test.ts.

const now = new Date('2026-11-16T10:00:00Z')
const later = (s: number) => new Date(now.getTime() + s * 1000)

describe('settings', () => {
	it('off by default: nothing set anywhere = 0', () => {
		expect(effectiveSettleSeconds(null, null)).toBe(0)
		expect(effectiveSettleSeconds(undefined, undefined)).toBe(0)
	})
	it('global value, per-app override (null = global, 0 = off, N = N)', () => {
		expect(effectiveSettleSeconds('600', null)).toBe(600)
		expect(effectiveSettleSeconds('600', 0)).toBe(0)
		expect(effectiveSettleSeconds('600', 120)).toBe(120)
		expect(effectiveSettleSeconds(null, 90)).toBe(90)
	})
	it('capped at 1800 s whatever the setting says; junk reads as unset', () => {
		expect(DEPLOY_SETTLE_MAX_SECONDS).toBe(1800)
		expect(effectiveSettleSeconds('86400', null)).toBe(1800)
		expect(effectiveSettleSeconds(null, 99999)).toBe(1800)
		for (const junk of ['', ' ', 'abc', '-5', 'NaN', 'Infinity', '1e3', '0x10', '10s']) expect(parseSettleSeconds(junk)).toBeNull()
		expect(parseSettleSeconds('90.9')).toBe(90)
		expect(effectiveSettleSeconds('abc', null)).toBe(0)
		expect(parseSettleSeconds(' 300 ')).toBe(300)
	})
})

describe('who is held', () => {
	it('only webhook pushes (single app and fan-out)', () => {
		for (const t of ['webhook', 'webhook:me', 'webhook-group:me', 'webhook-catchup:me']) expect(isSettleTrigger(t)).toBe(true)
		for (const t of [null, undefined, '', 'manual:me', 'wizard:me', 'preview:x']) expect(isSettleTrigger(t)).toBe(false)
	})
	it('[urgent] in any commit message of the push (any case) or powder_force = urgent', () => {
		expect(commitMessageIsUrgent('fix login [URGENT]')).toBe(true)
		expect(commitMessageIsUrgent('[urgent] hotfix')).toBe(true)
		expect(commitMessageIsUrgent('urgent fix')).toBe(false)
		expect(pushIsUrgent({ head_commit: { message: 'x [Urgent]' } })).toBe(true)
		expect(pushIsUrgent({ powder_force: true })).toBe(true)
		expect(pushIsUrgent({ powder_force: 'true', head_commit: { message: 'x' } })).toBe(false)
		expect(pushIsUrgent({ head_commit: { message: 'later' }, commits: [{ message: 'fix [urgent]' }, { message: 'later' }] })).toBe(true)
		expect(pushIsUrgent({ head_commit: { message: 'a' }, commits: [{ message: 'b' }, null, 'x'] })).toBe(false)
		expect(pushIsUrgent({ head_commit: null })).toBe(false)
		expect(pushIsUrgent({})).toBe(false)
	})
})

describe('heldSql (the one definition) and the waiting note', () => {
	it('a predicate over the row alias; queued, not_before ahead, window on for the app', () => {
		const q = heldSql('d')
		expect(q).toContain("d.status = 'queued'")
		expect(q).toContain('d.not_before > now()')
		expect(q).toContain('app_repos s WHERE s.server_id = d.server_id')
		expect(q).toContain("m.key = 'deploy_settle_seconds'")
		expect(heldSql('"deploys"', now)).toContain(`"deploys".not_before > '${now.toISOString()}'::timestamptz`)
		expect(heldSql('d')).not.toMatch(/[`$\\"]/)
	})
	it('the note names the UTC time and both ways to skip the wait', () => {
		expect(utcClock(new Date('2026-11-16T10:10:00Z'))).toBe('10:10')
		expect(utcClock(new Date('2026-07-01T21:05:00Z'))).toBe('21:05')
		const note = settleNote({ status: 'queued', notBefore: later(600) }, now)
		expect(note).toContain('waiting until 10:10 UTC')
		expect(note).toContain('to bundle further pushes')
		expect(note).toContain('redeploy now')
		expect(note).toContain('[urgent]')
		expect(settleNote({ status: 'queued', notBefore: null }, now)).toBeNull()
	})
})

describe('automatic rollback and a held row', () => {
	const t0 = new Date('2026-11-16T09:50:00Z')
	const row = (id: string, minutes: number, over: Partial<DeployRow> = {}): DeployRow => {
		const at = new Date(t0.getTime() + minutes * 60_000)
		return { id, kind: 'git_deploy', status: 'success', startedAt: at, queuedAt: at, finishedAt: at, gitSha: id.repeat(40), imageTag: `app:${id}`, ...over }
	}
	const prev = row('a', 0)
	const bad = row('b', 5)
	const input = (extra: DeployRow, at: Date) => ({ deploy: bad, containerName: 'app', autoRollback: true, history: [extra, bad, prev], now: at, env: {} })
	it('a held push does not supersede: automatic rollback stays on', () => {
		const held = row('c', 8, { status: 'queued', finishedAt: null, gitSha: null, imageTag: null, held: true })
		expect(staticBlockers(input(held, now))).toEqual([])
	})
	it('a queued push that is not held (or whose hold is over) still supersedes, as before', () => {
		const ready = row('c', 8, { status: 'queued', finishedAt: null, gitSha: null, imageTag: null, held: false })
		expect(staticBlockers(input(ready, now))).toContain('superseded')
		const unknown = row('c', 8, { status: 'queued', finishedAt: null, gitSha: null, imageTag: null })
		expect(staticBlockers(input(unknown, now))).toContain('superseded')
	})
})
