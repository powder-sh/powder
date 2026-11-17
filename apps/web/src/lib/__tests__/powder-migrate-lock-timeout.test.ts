// powder-migrate applies transactional migration files with a lock_timeout (default
// 10s, POWDER_MIGRATE_LOCK_TIMEOUT: 0 or 1s..600s): an ALTER stuck behind another
// session's lock fails the deploy before the swap instead of queueing every query on
// that table while the old container serves. Only the sessions that apply
// transactional files get it; a file that runs SET lock_timeout itself keeps control.
// Non-transactional files (CONCURRENTLY, ADD VALUE) get none, and such a file is never
// recorded while an index it names is INVALID (or one turned INVALID while it ran).
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFakeDocker } from './fixtures/fake-docker'
import { needTool } from './need-tool'
import { initdbArgs, pg, PG_BIN, pgEnv } from './pg-cluster'

const SCRIPT = resolve(__dirname, '../../../../../infra/powder-migrate')

// Logs every `docker run` with its argv on one line; ledger reads answer "1" tracked so no
// auto-baseline runs, the file list answers nothing applied.
const STUB_DOCKER = `#!/bin/bash
echo "[docker] $*" >> "$CALLS"
case "$1" in
  inspect)
    case "$*" in
      *project.config_files*) exit 0;;
      *'com.docker.compose.service'*) exit 0;;
      *Networks*) echo appnet;;
    esac; exit 0;;
  exec) echo "postgres://app:pw@db:5432/app"; exit 0;;
  image) exit 0;;
  run) a="$*"; echo "RUN \${a//$'\\n'/ }" >> "$CALLS"; cat >/dev/null; case "$*" in *"count(*) from _powder_migrations"*) echo 1;; esac; exit 0;;
esac
exit 0
`

function stubRun(
	env: Record<string, string> = {},
	files: Record<string, string> = {
		'0001_add.sql': 'alter table t add column if not exists x int;\n',
	},
) {
	const root = mkdtempSync(join(tmpdir(), 'pm-lt-'))
	const stubs = join(root, 'stubs')
	const mig = join(root, 'apps/demo/src/db/migrations')
	mkdirSync(stubs)
	mkdirSync(mig, { recursive: true })
	writeFakeDocker(stubs, STUB_DOCKER)
	for (const [n, body] of Object.entries(files)) writeFileSync(join(mig, n), body)
	const calls = join(root, 'calls.log')
	writeFileSync(calls, '')
	const r = spawnSync('bash', [SCRIPT, 'demo', 'apply'], {
		env: {
			...process.env,
			PATH: `${stubs}:${process.env.PATH}`,
			CALLS: calls,
			POWDER_APPS_DIR: join(root, 'apps'),
			POWDER_MIGRATE_WORK_DIR: join(root, 'w'),
			...env,
		},
		encoding: 'utf8',
	})
	const runs = readFileSync(calls, 'utf8')
		.split('\n')
		.filter((l) => l.startsWith('RUN '))
	return { r, runs, applyRuns: runs.filter((l) => l.includes(' -f -')) }
}

describe('powder-migrate lock_timeout (stub docker)', () => {
	const LT = (ms: number) => `-e PGOPTIONS=-c lock_timeout=${ms}ms`
	it('default: the session applying a transactional file gets lock_timeout 10s, no other session does', () => {
		const { r, runs, applyRuns } = stubRun()
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('applying: 0001_add.sql')
		expect(applyRuns).toHaveLength(1)
		expect(applyRuns[0]).toContain(LT(10000))
		expect(runs.filter((l) => l.includes('PGOPTIONS'))).toHaveLength(1)
		expect(runs.length).toBeGreaterThan(1)
	})
	it('non-transactional files (CONCURRENTLY, ADD VALUE) run without a lock_timeout', () => {
		for (const body of [
			'create index concurrently if not exists i on t(id);\n',
			"alter type mood add value if not exists 'meh';\n",
		]) {
			const { r, runs, applyRuns } = stubRun({}, { '0001_nt.sql': body })
			expect(r.status).toBe(0)
			expect(r.stdout).toContain('without lock_timeout')
			expect(applyRuns).toHaveLength(1)
			expect(runs.join('\n')).not.toContain('PGOPTIONS')
		}
	})
	it('POWDER_MIGRATE_LOCK_TIMEOUT overrides it within 1s..600s; 0 sets none', () => {
		const cases: [string, number][] = [
			['2500ms', 2500],
			['1s', 1000],
			['1min', 60000],
			['600s', 600000],
			['30000', 30000],
		]
		for (const [v, ms] of cases) {
			const { r, applyRuns } = stubRun({ POWDER_MIGRATE_LOCK_TIMEOUT: v })
			expect(r.stdout, v).not.toContain('WARNING')
			expect(applyRuns[0], v).toContain(LT(ms))
		}
		for (const v of ['0', '0s']) {
			const { r, runs } = stubRun({ POWDER_MIGRATE_LOCK_TIMEOUT: v })
			expect(r.status).toBe(0)
			expect(runs.join('\n')).not.toContain('PGOPTIONS')
		}
	})
	it('out of range or not a duration: warning, 10s (never passed through)', () => {
		for (const v of [
			'999999999s',
			'601s',
			'11min',
			'500ms',
			'10h',
			'-5s',
			'1.5s',
			'1s -c statement_timeout=0',
		]) {
			const { r, applyRuns } = stubRun({ POWDER_MIGRATE_LOCK_TIMEOUT: v })
			expect(r.status, v).toBe(0)
			expect(r.stdout, v).toContain('POWDER_MIGRATE_LOCK_TIMEOUT=')
			expect(r.stdout, v).toContain('using 10s')
			expect(applyRuns[0], v).toContain(LT(10000))
			expect(applyRuns[0], v).not.toContain('statement_timeout')
		}
	})
})

// A docker stub that runs the psql wrapper on this host: the -e variables of
// `docker run` are exported, the flags dropped, and the command after the image runs
// with the local psql against a throwaway cluster.
const PG_DOCKER = `#!/bin/bash
case "$1" in
  inspect)
    case "$*" in
      *project.config_files*) exit 0;;
      *'com.docker.compose.service'*) exit 0;;
      *Networks*) echo appnet;;
    esac; exit 0;;
  exec) echo "$TEST_DBURL"; exit 0;;
  image) exit 0;;
  run)
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        -e) case "$2" in *=*) export "$2";; esac; shift 2;;
        --network|--cap-drop|--security-opt|--user|--tmpfs|--pids-limit|--memory) shift 2;;
        -*) shift;;
        *) shift; break;;
      esac
    done
    exec "$@";;
esac
exit 0
`

const hasPg = needTool(
	'powder-migrate-lock-timeout',
	PG_BIN !== null,
	'initdb is not installed (no postgres server binaries)',
)
const port = String(20000 + Math.floor(Math.random() * 20000))

describe.skipIf(!hasPg)('powder-migrate lock_timeout on a real postgres', () => {
	const dir = mkdtempSync(join(tmpdir(), 'pm-lt-pg-'))
	const url = `postgres://postgres@127.0.0.1:${port}/postgres`
	const psql = (sql: string) => {
		const r = spawnSync('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', '-qtAc', sql], {
			encoding: 'utf8',
			env: pgEnv(),
		})
		if (r.status !== 0) throw new Error(`psql: ${r.stderr}`)
		return r.stdout.trim()
	}
	beforeAll(() => {
		const run = (cmd: string, args: string[]) => {
			const r = spawnSync(cmd, args, { encoding: 'utf8', env: pgEnv() })
			if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}${r.stdout}`)
		}
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
		psql('create table t(id int)')
		psql('create table other(id int)')
		psql('create table dup(v int); insert into dup values (1), (1)')
		// a database-level default the helper's timeout overrides (PGOPTIONS wins over it)
		psql(`alter database postgres set lock_timeout = '60s'`)
		psql(
			`create table _powder_migrations(filename text primary key, applied_at timestamptz default now()); insert into _powder_migrations values ('0000_base.sql')`,
		)
	}, 120_000)
	afterAll(() => {
		spawnSync(pg('pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'])
		rmSync(dir, { recursive: true, force: true })
	})

	/** Runs `sql` then sleeps `seconds` in one transaction of another session; resolves
	 *  once that session is sleeping (its lock and snapshot are held). */
	async function hold(sql: string, seconds: number) {
		const p = spawn(
			'psql',
			[
				url,
				'-X',
				'-c',
				`begin isolation level repeatable read; ${sql}; select pg_sleep(${seconds}); commit;`,
			],
			{
				env: pgEnv(),
				stdio: 'ignore',
			},
		)
		for (let i = 0; i < 100; i++) {
			if (
				psql(
					`select count(*) from pg_stat_activity where query like '%pg_sleep%' and state = 'active' and pid <> pg_backend_pid()`,
				) !== '0'
			)
				return p
			await new Promise((r) => setTimeout(r, 50))
		}
		throw new Error('holder did not start')
	}
	const holdLock = (seconds: number) => hold('lock table t in access share mode', seconds)
	const recorded = (f: string) =>
		psql(`select count(*) from _powder_migrations where filename = '${f}'`)

	/** Ends the holder: killing psql alone leaves its backend sleeping with the lock. */
	function release(holder: ReturnType<typeof spawn>) {
		psql(
			`select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep%' and pid <> pg_backend_pid()`,
		)
		holder.kill()
	}

	function migrateEnv(file: string, body: string, env: Record<string, string> = {}) {
		const root = mkdtempSync(join(dir, 'run-'))
		const stubs = join(root, 'stubs')
		const mig = join(root, 'apps/demo/src/db/migrations')
		mkdirSync(stubs)
		mkdirSync(mig, { recursive: true })
		writeFakeDocker(stubs, PG_DOCKER)
		writeFileSync(join(mig, file), body)
		return {
			...pgEnv(),
			PATH: `${stubs}:${process.env.PATH}`,
			TEST_DBURL: url,
			POWDER_APPS_DIR: join(root, 'apps'),
			POWDER_MIGRATE_WORK_DIR: join(root, 'w'),
			...env,
		}
	}
	function migrate(file: string, body: string, env: Record<string, string> = {}) {
		return spawnSync('bash', [SCRIPT, 'demo', 'apply'], {
			env: migrateEnv(file, body, env),
			encoding: 'utf8',
		})
	}
	/** migrate() in the background: resolves with its exit code and output. */
	function migrateAsync(file: string, body: string) {
		const p = spawn('bash', [SCRIPT, 'demo', 'apply'], { env: migrateEnv(file, body) })
		let stdout = ''
		p.stdout.on('data', (d) => {
			stdout += d
		})
		p.stderr.resume()
		return new Promise<{ status: number | null; stdout: string }>((res) =>
			p.on('close', (status) => res({ status, stdout })),
		)
	}
	async function until(sql: string, what: string) {
		for (let i = 0; i < 200; i++) {
			if (psql(sql) !== '0') return
			await new Promise((r) => setTimeout(r, 50))
		}
		throw new Error(`timed out waiting for ${what}`)
	}

	it('a transactional ALTER blocked by another session fails at the lock timeout (over a database default of 60s): rc 1, nothing recorded', async () => {
		const holder = await holdLock(20)
		const t = Date.now()
		const r = migrate('0001_add_x.sql', 'alter table t add column x int;\n', {
			POWDER_MIGRATE_LOCK_TIMEOUT: '1s',
		})
		release(holder)
		expect(r.status).toBe(1)
		expect(`${r.stdout}${r.stderr}`).toContain('lock timeout')
		expect(r.stdout).toContain('[migrate] FAILED on 0001_add_x.sql')
		expect(Date.now() - t).toBeLessThan(15_000)
		expect(recorded('0001_add_x.sql')).toBe('0')
	}, 60_000)

	it('a file that sets its own lock_timeout keeps control: it waits for the lock and applies', async () => {
		const holder = await holdLock(2)
		const r = migrate(
			'0002_add_y.sql',
			"set lock_timeout = '30s';\nalter table t add column y int;\n",
			{ POWDER_MIGRATE_LOCK_TIMEOUT: '1s' },
		)
		release(holder)
		expect(r.stdout).toContain('applying: 0002_add_y.sql')
		expect(r.status).toBe(0)
		expect(
			psql(
				`select count(*) from information_schema.columns where table_name = 't' and column_name = 'y'`,
			),
		).toBe('1')
		expect(psql(`select count(*) from _powder_migrations where filename = '0002_add_y.sql'`)).toBe(
			'1',
		)
	}, 60_000)

	it('a CONCURRENTLY file waits for an older transaction past the timeout and succeeds: index valid, recorded', async () => {
		const holder = await hold('select count(*) from other', 3)
		const t = Date.now()
		const r = migrate(
			'0003_idx.sql',
			'create index concurrently if not exists t_id_idx on t(id);\n',
			{
				POWDER_MIGRATE_LOCK_TIMEOUT: '1s',
			},
		)
		const took = Date.now() - t
		release(holder)
		expect(r.stdout).toContain(
			'applying: 0003_idx.sql (non-transactional: CONCURRENTLY), without lock_timeout',
		)
		expect(r.status).toBe(0)
		expect(took).toBeGreaterThan(1500)
		expect(psql(`select indisvalid from pg_index where indexrelid = 't_id_idx'::regclass`)).toBe(
			't',
		)
		expect(recorded('0003_idx.sql')).toBe('1')
	}, 60_000)

	const valid = (idx: string) =>
		psql(`select indisvalid from pg_index where indexrelid = '${idx}'::regclass`)
	/** an INVALID index made directly (as a cancelled concurrent build leaves one) */
	const makeInvalid = (idx: string, on: string) => {
		psql(`create index ${idx} on ${on}`)
		psql(`update pg_index set indisvalid = false where indexrelid = '${idx}'::regclass`)
	}
	const UNIQ = 'create unique index concurrently if not exists dup_v_key on dup(v);\n'

	it('retry sequence: a failed unique concurrent build is never recorded while its index is INVALID, until dropped and rebuilt', () => {
		// deploy 1: duplicate values, the build fails and leaves dup_v_key INVALID
		const r1 = migrate('0004_uniq.sql', UNIQ)
		expect(r1.status).toBe(1)
		expect(r1.stdout).toContain('[migrate] FAILED on 0004_uniq.sql')
		expect(r1.stdout).toContain(
			'INVALID index(es) that 0004_uniq.sql names or left behind: dup_v_key',
		)
		expect(r1.stdout).toContain('DROP INDEX CONCURRENTLY')
		expect(valid('dup_v_key')).toBe('f')
		expect(recorded('0004_uniq.sql')).toBe('0')
		// deploy 2: a plain retry; IF NOT EXISTS skips the invalid index and psql exits 0
		const r2 = migrate('0004_uniq.sql', UNIQ)
		expect(`${r2.stdout}${r2.stderr}`).toContain('already exists, skipping')
		expect(r2.status).toBe(1)
		expect(r2.stdout).toContain(
			'[migrate] FAILED on 0004_uniq.sql: INVALID index(es) it names or left behind: dup_v_key - not recorded',
		)
		expect(r2.stdout).toContain('DROP INDEX CONCURRENTLY')
		expect(recorded('0004_uniq.sql')).toBe('0')
		// a retry of a file without IF NOT EXISTS fails on "already exists" and still names the real state
		const r2b = migrate(
			'0004_uniq_b.sql',
			'create unique index concurrently dup_v_key on dup(v);\n',
		)
		expect(r2b.status).toBe(1)
		expect(`${r2b.stdout}${r2b.stderr}`).toContain('already exists')
		expect(r2b.stdout).toContain(
			'INVALID index(es) that 0004_uniq_b.sql names or left behind: dup_v_key',
		)
		expect(recorded('0004_uniq_b.sql')).toBe('0')
		// the fix: drop the index, fix the data, redeploy
		psql('drop index concurrently dup_v_key')
		psql('delete from dup a using dup b where a.ctid > b.ctid and a.v = b.v')
		const r3 = migrate('0004_uniq.sql', UNIQ)
		expect(r3.status).toBe(0)
		expect(valid('dup_v_key')).toBe('t')
		expect(recorded('0004_uniq.sql')).toBe('1')
	}, 60_000)

	it('a non-transactional file that exits 0 but leaves a new INVALID index fails and is not recorded', () => {
		const r = migrate(
			'0005_left.sql',
			"create index concurrently if not exists t_id2_idx on t(id);\nupdate pg_index set indisvalid = false where indexrelid = 't_id2_idx'::regclass;\n",
		)
		expect(r.status).toBe(1)
		expect(r.stdout).toContain(
			'[migrate] FAILED on 0005_left.sql: INVALID index(es) it names or left behind: t_id2_idx - not recorded',
		)
		expect(r.stdout).not.toContain('dup_v_key')
		expect(recorded('0005_left.sql')).toBe('0')
	}, 60_000)

	it('an unrelated INVALID index that existed before (another name) does not fail a file', () => {
		expect(valid('t_id2_idx')).toBe('f')
		const r = migrate(
			'0006_ok.sql',
			'create index concurrently if not exists t_id3_idx on t(id);\n',
		)
		expect(r.status).toBe(0)
		expect(recorded('0006_ok.sql')).toBe('1')
	}, 60_000)

	it('a file that names an index that is valid passes', () => {
		expect(valid('t_id3_idx')).toBe('t')
		const r = migrate(
			'0007_again.sql',
			'create index concurrently if not exists t_id3_idx on t(id);\n',
		)
		expect(r.status).toBe(0)
		expect(recorded('0007_again.sql')).toBe('1')
	}, 60_000)

	it('identifiers: a quoted name and a schema-qualified name match; a name inside a longer word does not', () => {
		// quoted, mixed case, invalid before the file: only the name rule can catch it
		makeInvalid('"Quoted_Idx"', 't(id)')
		const q = migrate(
			'0008_quoted.sql',
			'create index concurrently if not exists "Quoted_Idx" on t(id);\n',
		)
		expect(q.status).toBe(1)
		expect(q.stdout).toContain(
			'INVALID index(es) it names or left behind: Quoted_Idx - not recorded',
		)
		expect(recorded('0008_quoted.sql')).toBe('0')
		// schema-qualified reference
		makeInvalid('sq_idx', 'other(id)')
		const sq = migrate(
			'0009_schema.sql',
			"create index concurrently if not exists other_id_idx on other(id);\ncomment on index public.sq_idx is 'x';\n",
		)
		expect(sq.status).toBe(1)
		expect(sq.stdout).toContain('INVALID index(es) it names or left behind: sq_idx - not recorded')
		expect(sq.stdout).not.toContain('Quoted_Idx')
		expect(recorded('0009_schema.sql')).toBe('0')
		// dup_v is invalid, but the file only has it inside longer words (dup_v_idx2, dup_v2)
		makeInvalid('dup_v', 'dup(v)')
		const sub = migrate(
			'0010_sub.sql',
			'-- see dup_v2\ncreate index concurrently if not exists dup_v_idx2 on dup(v);\n',
		)
		expect(sub.status).toBe(0)
		expect(recorded('0010_sub.sql')).toBe('1')
	}, 60_000)
	it('an invalid index named only in a comment does not fail a file', () => {
		makeInvalid('cm_idx', 'other(id)')
		const r = migrate(
			'0011_comment.sql',
			'-- replaces cm_idx\n/* cm_idx */\ncreate index concurrently if not exists other_id2_idx on other(id);\n',
		)
		expect(r.status).toBe(0)
		expect(recorded('0011_comment.sql')).toBe('1')
	}, 60_000)

	it("another session's concurrent build that is still running when a file ends does not fail it", async () => {
		psql(`create type mood as enum ('a')`)
		// an older snapshot keeps the background build waiting (and its index INVALID)
		const holder = await hold('select count(*) from other', 30)
		const run = migrateAsync(
			'0012_enum.sql',
			"alter type mood add value if not exists 'b';\nselect pg_sleep(4);\n",
		)
		// the build starts while the file runs: its index is not in the list taken before
		await until(
			`select count(*) from pg_stat_activity where query like '%pg_sleep(4)%' and state = 'active' and pid <> pg_backend_pid()`,
			'the migration to run',
		)
		const bg = spawn('psql', [url, '-X', '-c', 'create index concurrently t_bg_idx on t(id)'], {
			env: pgEnv(),
			stdio: 'ignore',
		})
		const bgDone = new Promise((res) => bg.on('close', res))
		await until(
			`select count(*) from pg_stat_progress_create_index p join pg_class c on c.oid = p.index_relid where c.relname = 't_bg_idx'`,
			'the background build',
		)
		const r = await run
		expect(valid('t_bg_idx')).toBe('f')
		release(holder)
		await bgDone
		expect(r.stdout).toContain('non-transactional: ADD VALUE')
		expect(r.stdout).not.toContain('t_bg_idx')
		expect(r.status).toBe(0)
		expect(recorded('0012_enum.sql')).toBe('1')
		expect(valid('t_bg_idx')).toBe('t')
	}, 60_000)
})
