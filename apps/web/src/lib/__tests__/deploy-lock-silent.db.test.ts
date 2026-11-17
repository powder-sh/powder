import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { needTool } from './need-tool'
import { initdbArgs, pg, PG_BIN, pgEnv } from './pg-cluster'

// The deploy lock (deploys_running_unique / deploys_queued_unique) against a real
// postgres: every expected conflict answers the same as before, and postgres logs
// no "duplicate key" ERROR for any of them (a log scraper would file those as
// DB errors). Skipped where initdb is not installed.

const hasPg = needTool('deploy-lock-silent.db', PG_BIN !== null, 'initdb is not installed (no postgres server binaries)')
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

describe.skipIf(!hasPg)('deploy lock conflicts log no postgres ERROR', () => {
	const dir = mkdtempSync(join(tmpdir(), 'deploy-lock-pg-'))
	const log = join(dir, 'log')
	const psql = (args: string[]) => run('psql', [conn, '-v', 'ON_ERROR_STOP=1', '-q', ...args])
	const prevWorker = process.env.POWDER_DEPLOY_WORKER
	beforeAll(() => {
		run(pg('initdb'), initdbArgs(join(dir, 'data')))
		run(pg('pg_ctl'), ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, '-l', log, '-w', 'start'])
		for (const f of readdirSync(migrations)
			.filter((f) => /^\d{4}_.*\.sql$/.test(f))
			.sort())
			psql(['-f', join(migrations, f)])
		process.env.POWDER_DEPLOY_WORKER = 'true'
	}, 120_000)
	afterAll(async () => {
		process.env.POWDER_DEPLOY_WORKER = prevWorker
		const d = await import('../db').catch(() => null)
		await (d?.db as unknown as { $client?: { end: () => Promise<void> } })?.$client?.end?.()
		spawnSync(pg('pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'])
		rmSync(dir, { recursive: true, force: true })
	})

	const sha = (c: string) => c.repeat(40)
	const rows = (app: string) =>
		psql(['-tAc', `SELECT status || ':' || coalesce(requested_sha, '-') FROM deploys WHERE container_name = '${app}' ORDER BY queued_at, id`])
			.trim()
			.split('\n')
			.filter(Boolean)

	it('startDeploy: a push onto a queued row folds and unpins; inline onto a running row is in flight', async () => {
		const { startDeploy, DeployInFlightError } = await import('../deploys')
		const base = { serverId: 'srv_a', containerName: 'blog', kind: 'git_deploy' as const }
		const first = await startDeploy({ ...base, requestedSha: sha('a') })
		expect(first.status).toBe('queued')
		const second = await startDeploy({ ...base, requestedSha: sha('b') }).catch((e) => e)
		expect(second).toBeInstanceOf(DeployInFlightError)
		expect(second.coalesced).toBe(true)
		expect(rows('blog')).toEqual(['queued:-'])

		const running = await startDeploy({ ...base, containerName: 'shop', inline: true })
		expect(running.status).toBe('running')
		const inline = await startDeploy({ ...base, containerName: 'shop', inline: true }).catch((e) => e)
		expect(inline).toBeInstanceOf(DeployInFlightError)
		expect(inline.coalesced).toBeFalsy()
		expect(rows('shop')).toEqual(['running:-'])
	})

	it('requeueClaimedDeploy: requeues alone, folds behind a queued sibling', async () => {
		const { requeueClaimedDeploy, startDeploy } = await import('../deploys')
		const base = { serverId: 'srv_a', kind: 'git_deploy' as const }
		const alone = await startDeploy({ ...base, containerName: 'solo', inline: true })
		expect(await requeueClaimedDeploy(alone.id)).toBe('requeued')
		expect(rows('solo')).toEqual(['queued:-'])

		const claimed = await startDeploy({ ...base, containerName: 'busy', inline: true })
		await startDeploy({ ...base, containerName: 'busy', requestedSha: sha('c') })
		expect(await requeueClaimedDeploy(claimed.id)).toBe('folded')
		expect(rows('busy')).toEqual(['failed:-', `queued:${sha('c')}`])
		expect(await requeueClaimedDeploy(claimed.id)).toBe('gone')
	})

	it('claimNextQueuedDeploy: the guarded flip claims queued rows, never next to a running one', async () => {
		const { claimNextQueuedDeploy } = await import('../deploys')
		const claimed: string[] = []
		for (let r = await claimNextQueuedDeploy(); r; r = await claimNextQueuedDeploy()) {
			expect(r.status).toBe('running')
			claimed.push(r.containerName)
		}
		expect(claimed.sort()).toEqual(['blog', 'busy', 'solo'])
		expect(rows('shop')).toEqual(['running:-'])
	})

	it('postgres logged no unique violation', () => {
		const text = readFileSync(log, 'utf8')
		expect(text).not.toMatch(/duplicate key value violates unique constraint/)
	})
})
