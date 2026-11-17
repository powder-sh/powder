import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { needTool } from './need-tool'
import { initdbArgs, pg, PG_BIN, pgEnv } from './pg-cluster'
import { heldSql } from '../deploy-settle'

// The in-flight counts of bin/self-deploy.sh and bin/install.sh (powder refuses to recreate
// itself while deploys run) must not count a push held on its settle window, with the same
// rule as the web app (deploy-settle.ts heldSql), and must still work on a database from
// before migration 0063 (the first self-deploy that ships it counts BEFORE migrating).
// The functions are cut out of the real scripts and run under bash against a throwaway
// postgres; ssh / docker are shell functions that run psql locally.

const BIN = resolve(__dirname, '../../../../../bin')
const SCRIPTS = ['self-deploy.sh', 'install.sh'] as const

/** POWDER_HELD_SQL=... through the end of inflight_count() in a script. */
function inflightPart(script: string): string {
	const text = readFileSync(join(BIN, script), 'utf8')
	const start = text.indexOf('\nPOWDER_HELD_SQL=')
	const fn = text.indexOf('\ninflight_count() {', start)
	const end = text.indexOf('\n}\n', fn)
	if (start < 0 || fn < 0 || end < 0) throw new Error(`${script}: inflight_count not found`)
	return text.slice(start + 1, end + 3)
}

describe('the scripts carry the one definition of held', () => {
	for (const s of SCRIPTS)
		it(`${s}: POWDER_HELD_SQL is exactly heldSql('d')`, () => {
			const line = inflightPart(s).split('\n')[0] ?? ''
			expect(line).toBe(`POWDER_HELD_SQL="${heldSql('d')}"`)
		})
})

const hasPg = needTool('deploy-settle-scripts', PG_BIN !== null, 'initdb is not installed (no postgres server binaries)')
const migrations = join(__dirname, '../../../../../packages/db/drizzle')
const port = String(20000 + Math.floor(Math.random() * 20000))

describe.skipIf(!hasPg)('in-flight counts on a real postgres', () => {
	const dir = mkdtempSync(join(tmpdir(), 'settle-scripts-pg-'))
	const conn = (db: string) => `postgres://postgres@127.0.0.1:${port}/${db}`
	const run = (cmd: string, args: string[]) => {
		const r = spawnSync(cmd, args, { encoding: 'utf8', env: pgEnv() })
		if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}${r.stdout}`)
		return r.stdout
	}
	const psql = (db: string, sql: string) => run('psql', [conn(db), '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql])
	const migrate = (db: string, upTo: string) => {
		for (const f of readdirSync(migrations)
			.filter((f) => /^\d{4}_.*\.sql$/.test(f) && f < upTo)
			.sort())
			run('psql', [conn(db), '-v', 'ON_ERROR_STOP=1', '-q', '-f', join(migrations, f)])
	}

	beforeAll(() => {
		run(pg('initdb'), initdbArgs(join(dir, 'data')))
		run(pg('pg_ctl'), ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, '-l', join(dir, 'log'), '-w', 'start'])
		psql('postgres', 'CREATE DATABASE fresh')
		psql('postgres', 'CREATE DATABASE old')
		migrate('fresh', '9999')
		migrate('old', '0063')
		for (const db of ['fresh', 'old']) {
			psql(
				db,
				`INSERT INTO app_repos(id, server_id, container_name, repo_url, webhook_token, webhook_secret_encrypted, deploy_key_pub, deploy_key_priv_encrypted)
				 VALUES ('r1', 's', 'held', 'x', 't1', 'x', 'x', 'x'), ('r2', 's', 'busy', 'x', 't2', 'x', 'x', 'x')`,
			)
			psql(db, `INSERT INTO deploys(id, server_id, container_name, kind, status) VALUES ('d_run', 's', 'busy', 'git_deploy', 'running')`)
		}
		psql('fresh', `INSERT INTO deploys(id, server_id, container_name, kind, status, not_before) VALUES ('d_held', 's', 'held', 'git_deploy', 'queued', now() + interval '10 minutes')`)
		psql('old', `INSERT INTO deploys(id, server_id, container_name, kind, status) VALUES ('d_q', 's', 'held', 'git_deploy', 'queued')`)
	}, 120_000)
	afterAll(() => {
		spawnSync(pg('pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'])
		rmSync(dir, { recursive: true, force: true })
	})

	/** Run the script's inflight_count against `db`, with ssh / docker answering from psql. */
	const count = (script: (typeof SCRIPTS)[number], db: string): string => {
		const f = join(dir, `${script}.${db}.sh`)
		const shim =
			script === 'self-deploy.sh'
				? `HOST=server1; DB_EXEC="psql ${conn(db)}"\nssh() { shift; eval "$1"; }\n`
				: `PG_USER=postgres; PG_DB=${db}\ndocker() { shift 3; command psql -h 127.0.0.1 -p ${port} "$@"; }\n`
		writeFileSync(f, `set -euo pipefail\n${shim}${inflightPart(script)}\ninflight_count\n`)
		return run('bash', [f]).trim()
	}

	for (const s of SCRIPTS) {
		it(`${s}: a held push is not in flight; the running deploy is`, () => {
			psql('fresh', `DELETE FROM powder_meta WHERE key = 'deploy_settle_seconds'`)
			// window off: the row is claimable, so it IS in flight
			expect(count(s, 'fresh')).toBe('2')
			psql('fresh', `INSERT INTO powder_meta(key, value) VALUES ('deploy_settle_seconds', '600')`)
			expect(count(s, 'fresh')).toBe('1')
			// the per-app 0 releases it: in flight again
			psql('fresh', `UPDATE app_repos SET deploy_settle_seconds = 0 WHERE container_name = 'held'`)
			expect(count(s, 'fresh')).toBe('2')
			psql('fresh', `UPDATE app_repos SET deploy_settle_seconds = NULL WHERE container_name = 'held'`)
			psql('fresh', `DELETE FROM powder_meta WHERE key = 'deploy_settle_seconds'`)
		})
		it(`${s}: before migration 0063 (no not_before column) the old count still works`, () => {
			expect(count(s, 'old')).toBe('2')
		})
	}
})
