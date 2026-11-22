import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { needTool } from './need-tool'
import { initdbArgs, pg, PG_BIN, pgEnv } from './pg-cluster'

// The settle window (lib/deploy-settle.ts) against a real, throwaway postgres (initdb in a
// temp dir, every migration applied, removed afterwards), with the clock pinned. Skipped
// where initdb is not installed. Same harness as deploy-lock-silent.db.test.ts.

const hasPg = needTool('deploy-settle.db', PG_BIN !== null, 'initdb is not installed (no postgres server binaries)')
const migrations = join(__dirname, '../../../../../packages/db/drizzle')
const port = String(20000 + Math.floor(Math.random() * 20000))
const conn = `postgres://postgres@127.0.0.1:${port}/postgres`
if (hasPg) {
	process.env.DATABASE_URL = conn
	process.env.POWDER_ENCRYPTION_KEY = 'ab'.repeat(32)
}

function run(cmd: string, args: string[]) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', env: pgEnv() })
	if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}${r.stdout}`)
	return r.stdout
}

const h = vi.hoisted(() => ({
	ghFinished: [] as Array<{ id: string; state: string; text: string }>,
	group: null as Record<string, unknown> | null,
}))
// GitHub is stubbed: notifyDeploymentFinished records what it would have sent.
vi.mock('../github-deployments', () => ({
	notifyCommitPending: () => {},
	notifyPreviewCommit: async () => {},
	notifyDeploymentStarted: vi.fn(),
	notifyDeploymentFinished: async (_repo: unknown, id: string, state: string, text: string) => {
		h.ghFinished.push({ id, state, text })
	},
	commentPreviewOnPR: vi.fn(),
}))
// For the stop route and the webhook route (everything else in them is real).
vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => ({ server: { id: 'srv_settle' }, user: { id: 'u1', email: 'me@x' } }),
}))
vi.mock('@/lib/app-lifecycle', () => ({ stopContainer: async () => 'stopped\n' }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ ok: true }) }))
vi.mock('@/lib/notifications', () => ({ notify: async () => ({ delivered: 1, deduped: false }) }))
vi.mock('@/lib/preview-deploys', () => ({ previewSkipReason: async () => 'off', previewLastSha: async () => null, spinOrRedeployPreview: vi.fn() }))
vi.mock('@/lib/repos', async (importOriginal) => ({
	...(await importOriginal<typeof import('../repos')>()),
	getRepoByToken: async () => null,
}))
vi.mock('@/lib/repo-groups', () => ({
	decryptWebhookSecretForGroup: () => 'gsek',
	getGroupByToken: async () => h.group,
	listSubAppsForGroup: async () => [
		{ id: 'repo_fan-api', serverId: 'srv_settle', containerName: 'fan-api', pathsFilter: null },
		{ id: 'repo_fan-web', serverId: 'srv_settle', containerName: 'fan-web', pathsFilter: null },
	],
	setGroupGithubRepoId: vi.fn(),
}))

const T0 = new Date('2026-11-16T10:00:00Z')
const at = (s: number) => new Date(T0.getTime() + s * 1000)
const sha = (c: string) => c.repeat(40)
const SRV = 'srv_settle'

describe.skipIf(!hasPg)('settle window on a real postgres', () => {
	const dir = mkdtempSync(join(tmpdir(), 'deploy-settle-pg-'))
	const psql = (args: string[]) => run('psql', [conn, '-v', 'ON_ERROR_STOP=1', '-q', ...args])
	const prevWorker = process.env.POWDER_DEPLOY_WORKER
	const setGlobal = (v: string | null) =>
		psql([
			'-c',
			v === null
				? `DELETE FROM powder_meta WHERE key = 'deploy_settle_seconds'`
				: `INSERT INTO powder_meta(key, value) VALUES ('deploy_settle_seconds', '${v}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
		])
	const addApp = (name: string, settle: number | null) =>
		psql([
			'-c',
			`INSERT INTO app_repos(id, server_id, container_name, repo_url, webhook_token, webhook_secret_encrypted, deploy_key_pub, deploy_key_priv_encrypted, deploy_settle_seconds)
			 VALUES ('repo_${name}', '${SRV}', '${name}', 'git@github.com:x/${name}.git', 'tok_${name}', 'x', 'x', 'x', ${settle === null ? 'NULL' : settle})`,
		])
	const rows = (app: string) =>
		psql([
			'-tAc',
			`SELECT status || '|' || coalesce(requested_sha, '-') || '|' || coalesce(to_char(not_before AT TIME ZONE 'UTC', 'HH24:MI:SS'), '-') || '|' || coalesce(failed_step, '-')
			 FROM deploys WHERE container_name = '${app}' ORDER BY queued_at, id`,
		])
			.trim()
			.split('\n')
			.filter(Boolean)
	const push = async (app: string, c: string, over: Record<string, unknown> = {}) => {
		const { startDeploy } = await import('../deploys')
		return startDeploy({
			serverId: SRV,
			containerName: app,
			kind: 'git_deploy',
			triggeredBy: 'webhook:me',
			requestedSha: sha(c),
			...over,
		}).catch((e: unknown) => e)
	}
	/** A row held on the settle window the way an older powder wrote it (pushes
	 *  no longer get one): queued, pinned, not_before = now + secs, the settle note. */
	const hold = async (app: string, c: string, over: { triggeredBy?: string; secs?: number } = {}) => {
		const { settleNoteFor } = await import('../deploy-settle')
		const now = new Date()
		const nb = new Date(now.getTime() + (over.secs ?? 600) * 1000)
		const id = `dep_hold_${app}_${c}_${now.getTime()}`
		psql([
			'-c',
			`INSERT INTO deploys(id, server_id, container_name, kind, status, queued_at, triggered_by, requested_sha, not_before, output)
			 VALUES ('${id}', '${SRV}', '${app}', 'git_deploy', 'queued', '${now.toISOString()}', '${over.triggeredBy ?? 'webhook:me'}', '${sha(c)}', '${nb.toISOString()}', '[settle] ${settleNoteFor(nb)}
')`,
		])
		return { id }
	}
	/** Claim everything claimable now; the claimed rows go back to success so the next test starts clean. */
	const claimAll = async () => {
		const { claimNextQueuedDeploy } = await import('../deploys')
		const got: string[] = []
		for (let r = await claimNextQueuedDeploy(); r; r = await claimNextQueuedDeploy()) got.push(r.containerName)
		psql(['-c', `UPDATE deploys SET status = 'success', finished_at = started_at WHERE status = 'running' AND kind = 'git_deploy'`])
		return got.sort()
	}

	beforeAll(() => {
		run(pg('initdb'), initdbArgs(join(dir, 'data')))
		run(pg('pg_ctl'), ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, '-l', join(dir, 'log'), '-w', 'start'])
		for (const f of readdirSync(migrations)
			.filter((f) => /^\d{4}_.*\.sql$/.test(f))
			.sort())
			psql(['-f', join(migrations, f)])
		process.env.POWDER_DEPLOY_WORKER = 'true'
	}, 120_000)
	afterEach(() => {
		vi.useRealTimers()
		setGlobal(null)
		h.ghFinished = []
		h.group = null
	})
	afterAll(async () => {
		process.env.POWDER_DEPLOY_WORKER = prevWorker
		const d = await import('../db').catch(() => null)
		await (d?.db as unknown as { $client?: { end: () => Promise<void> } })?.$client?.end?.()
		spawnSync(pg('pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'])
		rmSync(dir, { recursive: true, force: true })
	})
	const pin = (s: number) => {
		if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(at(s))
	}

	it('default off (no setting anywhere): a webhook push is claimable at once, exactly as today', async () => {
		addApp('plain', null)
		pin(0)
		const d = await push('plain', 'a')
		expect(d).toMatchObject({ status: 'queued', notBefore: null, output: null })
		expect(rows('plain')).toEqual([`queued|${sha('a')}|-|-`])
		expect(await claimAll()).toEqual(['plain'])
	})

	it('a lone webhook push is claimable at once even with a window set (no clock hold)', async () => {
		addApp('held', 300)
		setGlobal('600')
		pin(0)
		const d = await push('held', 'a')
		expect(d).toMatchObject({ status: 'queued', notBefore: null, output: null })
		expect(await claimAll()).toEqual(['held'])
	})

	it('a row held by an older powder is claimed once its window passed, without the settle note', async () => {
		addApp('legacy', null)
		setGlobal('600')
		pin(0)
		await hold('legacy', 'a')
		pin(599)
		expect(await claimAll()).toEqual([])
		pin(600)
		const { claimNextQueuedDeploy } = await import('../deploys')
		const claimed = await claimNextQueuedDeploy()
		expect(claimed?.containerName).toBe('legacy')
		// the settle note is dropped at claim, so the live log starts from the build
		expect(claimed?.output).toBeNull()
		await claimAll()
	})

	it('pushes while a deploy runs fold into ONE queued row of the newest commit, claimable when it ends', async () => {
		addApp('burst', null)
		setGlobal('600')
		pin(0)
		await push('burst', 'a')
		const { claimNextQueuedDeploy } = await import('../deploys')
		expect((await claimNextQueuedDeploy())?.containerName).toBe('burst')
		pin(20)
		expect(await push('burst', 'b')).toMatchObject({ status: 'queued', notBefore: null })
		pin(40)
		expect(await push('burst', 'c')).toMatchObject({ coalesced: true })
		// one queued row, unpinned (builds branch HEAD = the newest push), no clock
		expect(rows('burst')).toEqual([`running|${sha('a')}|-|-`, 'queued|-|-|-'])
		// still running: nothing to claim
		expect(await claimNextQueuedDeploy()).toBeNull()
		psql(['-c', `UPDATE deploys SET status = 'success', finished_at = now() WHERE container_name = 'burst' AND status = 'running'`])
		expect(await claimAll()).toEqual(['burst'])
		expect(rows('burst')).toHaveLength(2)
	})

	it('a push redelivered onto a held row creates no second row and does not extend the hold', async () => {
		addApp('redeliver', null)
		setGlobal('600')
		pin(0)
		await hold('redeliver', 'a')
		pin(300)
		expect(await push('redeliver', 'a')).toMatchObject({ coalesced: true })
		expect(rows('redeliver')).toEqual(['queued|-|10:10:00|-'])
		pin(600)
		expect(await claimAll()).toEqual(['redeliver'])
	})

	it('[urgent] / powder_force (urgent), manual redeploy and catch-ups of other kinds are never held', async () => {
		addApp('urgent', null)
		addApp('manual', null)
		addApp('nonpush', null)
		setGlobal('600')
		pin(0)
		expect(await push('urgent', 'a', { urgent: true })).toMatchObject({ status: 'queued', notBefore: null })
		expect(await push('manual', 'a', { triggeredBy: 'manual:me', urgent: true })).toMatchObject({ notBefore: null })
		expect(await push('nonpush', 'a', { triggeredBy: 'wizard:me' })).toMatchObject({ notBefore: null })
		expect(await claimAll()).toEqual(['manual', 'nonpush', 'urgent'])
	})

	it('an urgent push folding into a held row releases it (newest commit, now)', async () => {
		addApp('release', null)
		setGlobal('600')
		pin(0)
		await hold('release', 'a')
		pin(60)
		const e = (await push('release', 'b', { urgent: true })) as { coalesced: boolean; released: boolean }
		expect(e.coalesced).toBe(true)
		expect(e.released).toBe(true)
		expect(rows('release')).toEqual(['queued|-|-|-'])
		expect(await claimAll()).toEqual(['release'])
	})

	it('the claim keeps the "released early" line of an urgent release in the output', async () => {
		addApp('released-log', null)
		setGlobal('600')
		pin(0)
		await hold('released-log', 'a')
		pin(60)
		await push('released-log', 'b', { urgent: true, triggeredBy: 'webhook:me' })
		const { claimNextQueuedDeploy } = await import('../deploys')
		const claimed = await claimNextQueuedDeploy()
		expect(claimed?.containerName).toBe('released-log')
		expect(claimed?.output).toContain('[settle] released early (webhook:me): deploying now')
		psql(['-c', `UPDATE deploys SET status = 'success', finished_at = started_at WHERE status = 'running' AND kind = 'git_deploy'`])
	})

	it('manual redeploy on a held row releases it instead of being refused or adding a row', async () => {
		addApp('redeploy', null)
		setGlobal('600')
		pin(0)
		const held = await hold('redeploy', 'a')
		pin(30)
		const { tryStartDeploy } = await import('../deploys')
		const res = (await tryStartDeploy({
			serverId: SRV,
			containerName: 'redeploy',
			kind: 'git_deploy',
			triggeredBy: 'manual:me',
			urgent: true,
		})) as Response
		expect(res).toBeInstanceOf(Response)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true, deployId: held.id, released: true })
		expect(rows('redeploy')).toEqual(['queued|-|-|-'])
		expect(await claimAll()).toEqual(['redeploy'])
	})

	it('manual redeploy onto a queued row that is NOT held answers as before (409 in flight)', async () => {
		addApp('busyq', null)
		pin(0)
		await push('busyq', 'a')
		const { tryStartDeploy } = await import('../deploys')
		const res = (await tryStartDeploy({
			serverId: SRV,
			containerName: 'busyq',
			kind: 'git_deploy',
			triggeredBy: 'manual:me',
			urgent: true,
		})) as Response
		expect(res.status).toBe(409)
		await claimAll()
	})

	it('rollback while a push is held: the rollback starts and cancels the held row as superseded', async () => {
		addApp('rb', null)
		setGlobal('600')
		pin(0)
		await hold('rb', 'a')
		pin(60)
		const { startDeploy, cancelHeldDeploys, finishDeploy } = await import('../deploys')
		const rb = await startDeploy({ serverId: SRV, containerName: 'rb', kind: 'rollback', inline: true })
		expect(rb.status).toBe('running')
		const cancelled = await cancelHeldDeploys(SRV, 'rb', { id: rb.id, kind: 'rollback' })
		expect(cancelled).toHaveLength(1)
		expect(rows('rb')).toEqual([`failed|${sha('a')}|10:10:00|superseded`, 'running|-|-|-'])
		// the held push's GitHub deployment is finished, the same way as a runner-superseded row
		expect(h.ghFinished).toEqual([{ id: cancelled[0], state: 'failure', text: expect.stringContaining(`cancelled by rollback ${rb.id}`) }])
		await finishDeploy(rb.id, { status: 'success' })
		// nothing left to deploy over the rollback, even after the window
		pin(3600)
		expect(await claimAll()).toEqual([])
	})

	it('restart and apply pass a held row (it deploys after); a ready queued row still blocks all', async () => {
		addApp('inl', null)
		setGlobal('600')
		pin(0)
		await hold('inl', 'a')
		const { startDeploy, finishDeploy, DeployInFlightError } = await import('../deploys')
		for (const kind of ['restart', 'manual_apply'] as const) {
			const r = await startDeploy({ serverId: SRV, containerName: 'inl', kind, inline: true })
			await finishDeploy(r.id, { status: 'success' })
		}
		pin(600)
		// window over: the row is ready, so it blocks inline work again (as before the window)
		expect(await startDeploy({ serverId: SRV, containerName: 'inl', kind: 'rollback', inline: true }).catch((e) => e)).toBeInstanceOf(
			DeployInFlightError,
		)
		expect(await claimAll()).toEqual(['inl'])
	})

	it('automatic rollback is not switched off by a held row', async () => {
		addApp('auto', null)
		pin(0)
		await push('auto', 'a')
		await claimAll()
		psql(['-c', `UPDATE deploys SET git_sha = '${sha('a')}', image_tag = 'auto:a' WHERE container_name = 'auto'`])
		pin(60)
		await push('auto', 'b')
		await claimAll()
		psql(['-c', `UPDATE deploys SET git_sha = '${sha('b')}', image_tag = 'auto:b' WHERE container_name = 'auto' AND git_sha IS NULL`])
		setGlobal('600')
		pin(120)
		await hold('auto', 'c')
		const { staticBlockers } = await import('../auto-rollback')
		const { heldSql } = await import('../deploy-settle')
		const { and, db, deploys, eq, desc, sql } = await import('../db')
		// what the preflight route reads: every row with `held` from the one definition
		const check = async (now: Date) => {
			const history = (
				await db
					.select({
						id: deploys.id,
						kind: deploys.kind,
						status: deploys.status,
						startedAt: deploys.startedAt,
						queuedAt: deploys.queuedAt,
						finishedAt: deploys.finishedAt,
						gitSha: deploys.gitSha,
						imageTag: deploys.imageTag,
						held: sql<boolean>`${sql.raw(heldSql('"deploys"', now))}`,
					})
					.from(deploys)
					.where(and(eq(deploys.serverId, SRV), eq(deploys.containerName, 'auto')))
					.orderBy(desc(deploys.startedAt))
			).map((d) => ({ ...d, kind: String(d.kind), status: String(d.status) }))
			const bad = history.find((d) => d.gitSha === sha('b'))
			if (!bad) throw new Error('no deploy of b')
			return staticBlockers({ deploy: bad, containerName: 'auto', autoRollback: true, history, now, env: {} })
		}
		expect(await check(at(130))).toEqual([])
		// once the hold is over the queued push is a real newer deploy again: superseded
		expect(await check(at(720))).toContain('superseded')
		pin(720)
		expect(await claimAll()).toEqual(['auto'])
	})

	it('no window setting (per app or global, any size) holds a new push', async () => {
		addApp('off', 0)
		addApp('short', 120)
		addApp('huge', 99999)
		addApp('global', null)
		setGlobal('99999')
		pin(0)
		for (const n of ['off', 'short', 'huge', 'global']) expect(await push(n, 'a')).toMatchObject({ notBefore: null })
		expect(await claimAll()).toEqual(['global', 'huge', 'off', 'short'])
	})

	it('monorepo fan-out: no sub-app row of a push is held, urgent or not', async () => {
		for (const n of ['mono-api', 'mono-web', 'mono2-api', 'mono2-web']) addApp(n, null)
		setGlobal('600')
		pin(0)
		for (const n of ['mono-api', 'mono-web'])
			expect(await push(n, 'a', { triggeredBy: 'webhook-group:me' })).toMatchObject({ notBefore: null })
		for (const n of ['mono2-api', 'mono2-web'])
			expect(await push(n, 'a', { triggeredBy: 'webhook-group:me', urgent: true })).toMatchObject({ notBefore: null })
		expect(await claimAll()).toEqual(['mono-api', 'mono-web', 'mono2-api', 'mono2-web'])
	})

	it('stop during a hold: not blocked, the held push is cancelled and the app stops', async () => {
		addApp('stopme', null)
		setGlobal('600')
		pin(0)
		const held = await hold('stopme', 'a')
		pin(30)
		const { POST } = await import('../../app/api/servers/[id]/containers/[name]/stop/route')
		const res = await POST(new Request('http://x', { method: 'POST' }), {
			params: Promise.resolve({ id: SRV, name: 'stopme' }),
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.cancelledHeldDeploys).toEqual([held.id])
		expect(body.output).toContain(`[settle] cancelled the held push deploy ${held.id}`)
		expect(body.output).toContain('stopped')
		expect(rows('stopme')).toEqual([`failed|${sha('a')}|10:10:00|superseded`, 'success|-|-|-'])
		expect(h.ghFinished.map((g) => [g.id, g.state])).toEqual([[held.id, 'failure']])
		// the push can not start the app again later
		pin(3600)
		expect(await claimAll()).toEqual([])
	})

	it('delete during a hold is not refused (the delete route fails every queued row itself)', async () => {
		addApp('delme', null)
		setGlobal('600')
		pin(0)
		await hold('delme', 'a')
		const { startDeploy, finishDeploy } = await import('../deploys')
		const del = await startDeploy({ serverId: SRV, containerName: 'delme', kind: 'delete', inline: true })
		expect(del.status).toBe('running')
		psql(['-c', `UPDATE deploys SET status = 'failed', finished_at = now() WHERE container_name = 'delme' AND status = 'queued'`])
		await finishDeploy(del.id, { status: 'success' })
	})

	it('the window switched off mid-hold (global, or per app 0) releases rows already held', async () => {
		addApp('offglobal', null)
		addApp('offapp', null)
		setGlobal('600')
		pin(0)
		await hold('offglobal', 'a')
		await hold('offapp', 'a')
		pin(10)
		expect(await claimAll()).toEqual([])
		psql(['-c', `UPDATE app_repos SET deploy_settle_seconds = 0 WHERE container_name = 'offapp'`])
		expect(await claimAll()).toEqual(['offapp'])
		setGlobal(null)
		expect(await claimAll()).toEqual(['offglobal'])
		// junk in the global value reads as unset (off) on both sides, never as a hold
		setGlobal('ten minutes')
		expect(await push('offglobal', 'b')).toMatchObject({ notBefore: null })
		expect(await claimAll()).toEqual(['offglobal'])
	})

	it('a push reads no settle setting (a broken settings column cannot hold it)', async () => {
		addApp('readfail', null)
		setGlobal('600')
		pin(0)
		const err = vi.spyOn(console, 'error').mockImplementation(() => {})
		psql(['-c', 'ALTER TABLE app_repos RENAME COLUMN deploy_settle_seconds TO deploy_settle_seconds_x'])
		try {
			expect(await push('readfail', 'a')).toMatchObject({ status: 'queued', notBefore: null })
		} finally {
			psql(['-c', 'ALTER TABLE app_repos RENAME COLUMN deploy_settle_seconds_x TO deploy_settle_seconds'])
			err.mockRestore()
		}
		expect(await claimAll()).toEqual(['readfail'])
	})

	it('end to end through the webhook route: a fan-out push is claimable at once for both sub-apps', async () => {
		addApp('fan-api', null)
		addApp('fan-web', null)
		setGlobal('600')
		h.group = { id: 'grp_1', branch: 'main', repoUrl: 'git@github.com:acme/mono.git', githubRepoId: 4242 }
		const { POST } = await import('../../app/api/webhooks/deploy/[token]/route')
		let n = 0
		const send = (after: string, commits: Array<{ message: string }>, head: string) => {
			const body = JSON.stringify({
				ref: 'refs/heads/main',
				after,
				pusher: { name: 'me' },
				repository: { id: 4242, full_name: 'acme/mono' },
				commits: commits.map((c) => ({ ...c, modified: ['src/x.ts'] })),
				head_commit: { message: head, modified: ['src/x.ts'] },
			})
			const sig = `sha256=${createHmac('sha256', 'gsek').update(body).digest('hex')}`
			return POST(
				new Request('http://x/api/webhooks/deploy/gtok', {
					method: 'POST',
					headers: { 'x-hub-signature-256': sig, 'x-github-event': 'push', 'x-github-delivery': `fan-${++n}` },
					body,
				}),
				{ params: Promise.resolve({ token: 'gtok' }) },
			)
		}
		pin(0)
		const res = await send(sha('a'), [{ message: 'one' }], 'one')
		expect(res.status).toBe(202)
		expect((await res.json()).waiting).toBeUndefined()
		expect(rows('fan-api')).toEqual([`queued|${sha('a')}|-|-`])
		expect(rows('fan-web')).toEqual([`queued|${sha('a')}|-|-`])
		expect(await claimAll()).toEqual(['fan-api', 'fan-web'])
	})

	// last: it resets the module registry (a fresh process)
	it('a worker restart mid-hold loses nothing: the hold lives in the row', async () => {
		addApp('restart', null)
		setGlobal('600')
		pin(0)
		await hold('restart', 'a')
		pin(300)
		expect(await claimAll()).toEqual([])
		// a fresh process: new module instances, new pool
		const old = await import('../db')
		await (old.db as unknown as { $client?: { end: () => Promise<void> } }).$client?.end?.()
		vi.resetModules()
		pin(600)
		expect(await claimAll()).toEqual(['restart'])
	})
})
