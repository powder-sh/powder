import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { needTool } from './need-tool'
import { initdbArgs, pg, PG_BIN, pgEnv } from './pg-cluster'

// The powder_meta store of the compose-drift state (deploy/compose-drift-inventory.ts)
// against a real postgres with every migration applied:
//   - get/set/del round-trip, list() sorted with each row's state
//   - list() drops the rows of apps powder no longer has (no app_repos row), so a
//     deleted app leaves the compose-drift inventory
//   - an unregistered container's standing result neither retires a card nor joins
//     the inventory, on every deploy (no row survives to make it look known)
// Skipped where initdb is not installed.

const hasPg = needTool('compose-drift-store.db', PG_BIN !== null, 'initdb is not installed (no postgres server binaries)')
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

describe.skipIf(!hasPg)('compose-drift state in powder_meta', () => {
	const dir = mkdtempSync(join(tmpdir(), 'compose-drift-pg-'))
	const log = join(dir, 'log')
	const psql = (args: string[]) => run('psql', [conn, '-v', 'ON_ERROR_STOP=1', '-q', ...args])
	const addApp = (server: string, app: string) =>
		psql([
			'-c',
			`INSERT INTO app_repos (id, server_id, container_name, repo_url, webhook_token, webhook_secret_encrypted, deploy_key_pub, deploy_key_priv_encrypted) VALUES ('r_${server}_${app}', '${server}', '${app}', 'git@github.com:x/${app}.git', 'tok_${server}_${app}', 'x', 'x', 'x')`,
		])
	beforeAll(() => {
		run(pg('initdb'), initdbArgs(join(dir, 'data')))
		run(pg('pg_ctl'), ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, '-l', log, '-w', 'start'])
		for (const f of readdirSync(migrations)
			.filter((f) => /^\d{4}_.*\.sql$/.test(f))
			.sort())
			psql(['-f', join(migrations, f)])
		psql(['-c', "INSERT INTO servers (id, name, host) VALUES ('s1', 's1', '192.0.2.20') ON CONFLICT DO NOTHING"])
		addApp('s1', 'blog')
		addApp('s1', 'shop')
	}, 120_000)
	afterAll(async () => {
		const d = await import('../db').catch(() => null)
		await (d?.db as unknown as { $client?: { end: () => Promise<void> } })?.$client?.end?.()
		spawnSync(pg('pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'])
		rmSync(dir, { recursive: true, force: true })
	})

	it('round-trips state, lists it sorted, and prunes the rows of removed apps', async () => {
		const { powderMetaComposeDriftStore: store } = await import('../deploy/compose-drift-inventory')
		await store.set('s1/shop', 'standing')
		await store.set('s1/blog', 'drift')
		expect(await store.get('s1/blog')).toBe('drift')
		await store.set('s1/blog', 'standing')
		expect(await store.get('s1/blog')).toBe('standing')
		expect(await store.list()).toEqual([
			{ ref: 's1/blog', value: 'standing' },
			{ ref: 's1/shop', value: 'standing' },
		])
		// the app is deleted (its app_repos row goes): its state goes with the next list
		psql(['-c', "DELETE FROM app_repos WHERE container_name = 'shop'"])
		expect(await store.list()).toEqual([{ ref: 's1/blog', value: 'standing' }])
		expect(await store.get('s1/shop')).toBeNull()
		await store.del('s1/blog')
		expect(await store.get('s1/blog')).toBeNull()
		// the prune touches compose_drift: rows only
		psql(['-c', "INSERT INTO powder_meta (key, value) VALUES ('compose_driftless', 'keep') ON CONFLICT DO NOTHING"])
		await store.list()
		expect(psql(['-tAc', "SELECT value FROM powder_meta WHERE key = 'compose_driftless'"]).trim()).toBe('keep')
	})

	it('an unregistered container never retires a card or joins the inventory, deploy after deploy', async () => {
		const { composeDriftStep, powderMetaComposeDriftStore: store } = await import('../deploy/compose-drift-inventory')
		for (let i = 0; i < 3; i++) expect(await composeDriftStep('s1/ghost', 'standing', store)).toEqual({ retireOld: false, joined: false })
		expect(await store.get('s1/ghost')).toBeNull()
		// a registered app: retired and joined once, then quiet
		addApp('s1', 'wiki')
		expect(await composeDriftStep('s1/wiki', 'standing', store)).toEqual({ retireOld: true, joined: true })
		expect(await composeDriftStep('s1/wiki', 'standing', store)).toEqual({ retireOld: false, joined: false })
		// a drift row is sticky through standing deploys, cleared only by ok
		await composeDriftStep('s1/wiki', 'drift', store)
		await composeDriftStep('s1/wiki', 'standing', store)
		expect(await store.get('s1/wiki')).toBe('drift')
		await composeDriftStep('s1/wiki', 'ok', store)
		expect(await store.get('s1/wiki')).toBeNull()
	})
})
