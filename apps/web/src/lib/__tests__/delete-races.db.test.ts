import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { needTool } from './need-tool'
import { initdbArgs, pg, PG_BIN, pgEnv } from './pg-cluster'

// Two races around deletes, against a real postgres (initdb in a temp dir, every
// migration applied, removed afterwards). Skipped where initdb is not installed.
//   - app creation vs server deletion: no foreign key from app_repos to servers, so
//     createRepo key-share-locks the server row (lockServerForAppCreate) and
//     deleteServer locks it FOR UPDATE; whichever comes second waits and then sees
//     the first. A status update of the same row does not wait for the create.
//   - a delete that runs longer than the watchdog's silent threshold keeps its row
//     (inlineProgress stamps the heartbeat and writes output).

const hasPg = needTool('delete-races.db', PG_BIN !== null, 'initdb is not installed (no postgres server binaries)')
const migrations = join(__dirname, '../../../../../packages/db/drizzle')
const port = String(20000 + Math.floor(Math.random() * 20000))
const conn = `postgres://postgres@127.0.0.1:${port}/postgres`
// Before anything imports ../db (it reads DATABASE_URL once); the modules under
// test are imported dynamically for the same reason.
if (hasPg) {
	process.env.DATABASE_URL = conn
	process.env.POWDER_ENCRYPTION_KEY = 'ab'.repeat(32)
}

function run(cmd: string, args: string[]) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', env: pgEnv() })
	if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}${r.stdout}`)
	return r.stdout
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!hasPg)('delete races on a real postgres', () => {
	const dir = mkdtempSync(join(tmpdir(), 'delete-races-pg-'))
	const psql = (args: string[]) => run('psql', [conn, '-v', 'ON_ERROR_STOP=1', '-q', ...args])
	beforeAll(() => {
		run(pg('initdb'), initdbArgs(join(dir, 'data')))
		run(pg('pg_ctl'), [
			'-D',
			join(dir, 'data'),
			'-o',
			`-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`,
			'-l',
			join(dir, 'log'),
			'-w',
			'start',
		])
		for (const f of readdirSync(migrations)
			.filter((f) => /^\d{4}_.*\.sql$/.test(f))
			.sort())
			psql(['-f', join(migrations, f)])
	}, 120_000)
	afterAll(async () => {
		const d = await import('../db').catch(() => null)
		await (d?.db as unknown as { $client?: { end: () => Promise<void> } })?.$client?.end?.()
		spawnSync(pg('pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'])
		rmSync(dir, { recursive: true, force: true })
	})

	const repoInput = (serverId: string, containerName: string) => ({
		serverId,
		containerName,
		repoUrl: 'git@github.com:zorb/zorbweb.git',
		branch: 'main',
		pub: 'ssh-ed25519 AAAA',
		priv: 'k',
	})
	const appCount = (serverId: string) =>
		psql(['-tAc', `SELECT count(*) FROM app_repos WHERE server_id = '${serverId}'`]).trim()

	it('a server delete that holds the row lock: the app create waits, then refuses and leaves no app', async () => {
		const { db, servers, eq } = await import('../db')
		const { createRepo, ServerGoneError } = await import('../repos')
		psql(['-c', "INSERT INTO servers (id, name, host) VALUES ('srv_a', 'a', '192.0.2.10')"])

		let release!: () => void
		const held = new Promise<void>((r) => {
			release = r
		})
		let locked!: () => void
		const lockTaken = new Promise<void>((r) => {
			locked = r
		})
		// The delete side, paused between its row lock and the delete.
		const deleting = db.transaction(async (tx) => {
			await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, 'srv_a')).for('update')
			locked()
			await held
			await tx.delete(servers).where(eq(servers.id, 'srv_a'))
		})
		await lockTaken
		let settled = false
		const creating = createRepo(repoInput('srv_a', 'zorbweb')).then(
			(v) => {
				settled = true
				return v
			},
			(e: unknown) => {
				settled = true
				throw e
			},
		)
		await sleep(300)
		expect(settled).toBe(false) // waits on the server row
		release()
		await deleting
		await expect(creating).rejects.toBeInstanceOf(ServerGoneError)
		expect(appCount('srv_a')).toBe('0')
	}, 30_000)

	it('an app create in flight: the server delete waits, then sees the app and refuses', async () => {
		const { db, appRepos, createId, prefixes } = await import('../db')
		const { lockServerForAppCreate } = await import('../repos')
		const { deleteServer } = await import('../servers')
		psql(['-c', "INSERT INTO servers (id, name, host) VALUES ('srv_b', 'b', '192.0.2.11')"])

		let release!: () => void
		const held = new Promise<void>((r) => {
			release = r
		})
		let locked!: () => void
		const lockTaken = new Promise<void>((r) => {
			locked = r
		})
		// The create side (createRepo's lock), paused before its insert.
		const creating = db.transaction(async (tx) => {
			await lockServerForAppCreate(tx, 'srv_b')
			locked()
			await held
			await tx.insert(appRepos).values({
				id: createId(prefixes.appRepo),
				serverId: 'srv_b',
				containerName: 'quuxapi',
				repoUrl: 'git@github.com:zorb/quuxapi.git',
				webhookToken: 'tok_b',
				webhookSecretEncrypted: 'x',
				deployKeyPub: 'x',
				deployKeyPrivEncrypted: 'x',
			})
		})
		await lockTaken
		let settled = false
		const deleting = deleteServer('srv_b').then((v) => {
			settled = true
			return v
		})
		await sleep(300)
		expect(settled).toBe(false) // waits on the server row
		release()
		await creating
		expect(await deleting).toEqual({ ok: false, reason: 'apps', apps: ['quuxapi'] })
		expect(psql(['-tAc', "SELECT count(*) FROM servers WHERE id = 'srv_b'"]).trim()).toBe('1')
	}, 30_000)

	it('an app create in flight does not hold up a status update of its server', async () => {
		const { db } = await import('../db')
		const { lockServerForAppCreate } = await import('../repos')
		psql(['-c', "INSERT INTO servers (id, name, host) VALUES ('srv_d', 'd', '192.0.2.12')"])

		let release!: () => void
		const held = new Promise<void>((r) => {
			release = r
		})
		let locked!: () => void
		const lockTaken = new Promise<void>((r) => {
			locked = r
		})
		const creating = db.transaction(async (tx) => {
			await lockServerForAppCreate(tx, 'srv_d')
			locked()
			await held
		})
		await lockTaken
		try {
			// A lock wait fails the statement after lock_timeout instead of hanging.
			psql([
				'-c',
				"SET lock_timeout = '2s'; UPDATE servers SET status = 'connected', last_seen_at = now() WHERE id = 'srv_d'",
			])
		} finally {
			release()
			await creating
		}
		expect(psql(['-tAc', "SELECT status FROM servers WHERE id = 'srv_d'"]).trim()).toBe('connected')
	}, 30_000)

	it('without a server row the create refuses at once', async () => {
		const { createRepo, ServerGoneError } = await import('../repos')
		await expect(createRepo(repoInput('srv_gone', 'zorbweb'))).rejects.toBeInstanceOf(ServerGoneError)
		expect(appCount('srv_gone')).toBe('0')
	})

	it('a delete running longer than the silent threshold is not reaped once it reports progress', async () => {
		const { inlineProgress } = await import('../deploys')
		const { reapStuckDeploys } = await import('../deploy-watchdog')
		const status = (id: string) => psql(['-tAc', `SELECT status FROM deploys WHERE id = '${id}'`]).trim()
		// Two deletes started 10 minutes ago, past SILENT_AFTER_MIN, no output yet.
		psql([
			'-c',
			`INSERT INTO deploys (id, server_id, container_name, kind, status, started_at) VALUES
			   ('dep_silent', 'srv_c', 'oldapp', 'delete', 'running', now() - interval '10 minutes'),
			   ('dep_live', 'srv_c', 'zorbweb', 'delete', 'running', now() - interval '10 minutes')`,
		])
		const progress = inlineProgress('dep_live', 60_000)
		try {
			await progress.step('deleting zorbweb: inspecting the container')
			await reapStuckDeploys()
		} finally {
			progress.stop()
		}
		// No heartbeat and no output is what the silent rule reaps.
		expect(status('dep_silent')).toBe('failed')
		expect(status('dep_live')).toBe('running')
		expect(psql(['-tAc', "SELECT output, heartbeat_at IS NOT NULL FROM deploys WHERE id = 'dep_live'"]).trim()).toBe(
			'deleting zorbweb: inspecting the container|t',
		)
	}, 30_000)
})
