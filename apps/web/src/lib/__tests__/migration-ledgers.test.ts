import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFakeDocker } from './fixtures/fake-docker'

const REPO = resolve(__dirname, '../../../../..')
const SCRIPT = join(REPO, 'infra/powder-migrate')
const LIB = join(REPO, 'bin/lib-migrations.sh')

// ── infra/powder-migrate: fail closed ───────────────────────────────────────
// Stub docker: the psql run is routed on the SQL text. SCHEMA_RC / SCHEMA_OUT
// control the information_schema query, REC_FAIL=1 fails the ledger insert.
const DOCKER = `#!/bin/bash
echo "[docker] $*" >> "$CALLS"
case "$1" in
  inspect) case "$*" in *Networks*) echo appnet;; esac; exit 0;;
  exec) echo "postgres://app:pw@db:5432/app"; exit 0;;
  image) exit 0;;
  run)
    stdin=$(cat)
    all="$* $stdin"
    case "$all" in
      *"count(*) from _powder_migrations"*) echo 0;;
      *"information_schema.tables"*) [ -n "$SCHEMA_OUT" ] && echo "$SCHEMA_OUT"; exit "\${SCHEMA_RC:-0}";;
      *"select filename from _powder_migrations"*) ;;
      *"insert into _powder_migrations"*) [ "$REC_FAIL" = 1 ] && exit 3; echo "recorded" >> "$CALLS";;
    esac
    exit 0;;
esac
exit 0
`

function runMigrate(env: Record<string, string>, mode = 'apply', sql = 'select 1;\n') {
	const root = mkdtempSync(join(tmpdir(), 'pml-'))
	const stubs = join(root, 'stubs')
	const apps = join(root, 'apps')
	mkdirSync(stubs)
	mkdirSync(join(apps, 'demo/src/drizzle'), { recursive: true })
	writeFileSync(join(apps, 'demo/src/drizzle/0001.sql'), sql)
	writeFakeDocker(stubs, DOCKER)
	const calls = join(root, 'calls.log')
	writeFileSync(calls, '')
	const r = spawnSync('bash', [SCRIPT, 'demo', mode], {
		env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, CALLS: calls, POWDER_APPS_DIR: apps, POWDER_MIGRATE_WORK_DIR: `${apps}-migwork`, ...env },
		encoding: 'utf8',
	})
	return { status: r.status, out: r.stdout, log: readFileSync(calls, 'utf8') }
}

describe('powder-migrate fails closed', () => {
	it('the information_schema query failing (exit 2) aborts with exit 1 and applies nothing', () => {
		const r = runMigrate({ SCHEMA_RC: '2' })
		expect(r.status).toBe(1)
		expect(r.out).not.toContain('applying:')
		expect(r.out).toContain('cannot count existing tables')
	})
	it('a non-numeric table count aborts', () => {
		const r = runMigrate({ SCHEMA_OUT: 'ERROR: permission denied' })
		expect(r.status).toBe(1)
		expect(r.out).not.toContain('applying:')
	})
	it('counts all schemas except system ones', () => {
		const r = runMigrate({ SCHEMA_OUT: '4' })
		expect(r.out).toContain('BASELINE')
		expect(r.log).toContain("not in ('pg_catalog','information_schema','pg_toast')")
		expect(r.out).not.toContain('applying:')
	})
	it('an empty database applies each file in one transaction (psql -1)', () => {
		const r = runMigrate({ SCHEMA_OUT: '0' })
		expect(r.status).toBe(0)
		expect(r.out).toContain('applying: 0001.sql')
		expect(r.log).toMatch(/exec psql -X -v ON_ERROR_STOP=1 "\$@"\s+sh -1 -f -/)
	})
	it('CONCURRENTLY files run without -1 and say so; others stay transactional', () => {
		const c = runMigrate({ SCHEMA_OUT: '0' }, 'apply', 'CREATE INDEX Concurrently IF NOT EXISTS i ON t (a);\n')
		expect(c.status).toBe(0)
		expect(c.out).toContain('applying: 0001.sql (non-transactional: CONCURRENTLY)')
		expect(c.log).toMatch(/"\$@"\s+sh -f -/)
		expect(c.log).not.toMatch(/sh -1 -f -/)
		const n = runMigrate({ SCHEMA_OUT: '0' }, 'apply', '-- mentions concurrent updates only\nselect 1;\n')
		expect(n.out).not.toContain('non-transactional')
		expect(n.log).toMatch(/sh -1 -f -/)
	})
	it('ALTER TYPE ... ADD VALUE files run without -1 (enum value unusable in the adding transaction)', () => {
		const e = runMigrate({ SCHEMA_OUT: '0' }, 'apply', "ALTER TYPE   mood  ADD   VALUE IF NOT EXISTS 'ok';\nSELECT 'ok'::mood;\n")
		expect(e.status).toBe(0)
		expect(e.out).toContain('applying: 0001.sql (non-transactional: ADD VALUE)')
		expect(e.log).toMatch(/"\$@"\s+sh -f -/)
		expect(e.log).not.toMatch(/sh -1 -f -/)
		const n = runMigrate({ SCHEMA_OUT: '0' }, 'apply', '-- we add values later\nselect 1;\n')
		expect(n.log).toMatch(/sh -1 -f -/)
	})
	it('a comment naming concurrently keeps the file in one transaction', () => {
		const r = runMigrate({ SCHEMA_OUT: '0' }, 'apply', '-- TODO: create index concurrently later\nCREATE INDEX IF NOT EXISTS i ON t (a);\n')
		expect(r.status).toBe(0)
		expect(r.out).toContain('applying: 0001.sql\n')
		expect(r.out).not.toContain('non-transactional')
		expect(r.log).toMatch(/sh -1 -f -/)
		const b = runMigrate({ SCHEMA_OUT: '0' }, 'apply', "/* was: ALTER TYPE mood\n ADD VALUE 'x' */\nselect 1;\n")
		expect(b.out).not.toContain('non-transactional')
	})
	it('only ALTER TYPE ... ADD VALUE counts, across lines too; an ADD of a column named value does not', () => {
		const n = runMigrate({ SCHEMA_OUT: '0' }, 'apply', 'ALTER TABLE t ADD value int;\n')
		expect(n.out).not.toContain('non-transactional')
		expect(n.log).toMatch(/sh -1 -f -/)
		const m = runMigrate({ SCHEMA_OUT: '0' }, 'apply', "ALTER TYPE mood\n  ADD VALUE IF NOT EXISTS 'ok'; -- new mood\n")
		expect(m.out).toContain('applying: 0001.sql (non-transactional: ADD VALUE)')
	})
	it('the comment stripping and the no-transaction rule are the same text in the lib and the server script', () => {
		const block = (p: string) => {
			const s = readFileSync(p, 'utf8')
			const a = s.indexOf('# BEGIN migration-txn')
			const b = s.indexOf('# END migration-txn')
			expect(a, p).toBeGreaterThanOrEqual(0)
			expect(b, p).toBeGreaterThan(a)
			return s.slice(a, b)
		}
		expect(block(SCRIPT)).toBe(block(LIB))
		expect(block(LIB)).toContain('migration_txn_exception()')
		expect(readFileSync(SCRIPT, 'utf8')).toContain('nt=$(migration_txn_exception "$f")')
	})
	it('a failed ledger insert fails the run', () => {
		const r = runMigrate({ SCHEMA_OUT: '0', REC_FAIL: '1' })
		expect(r.status).toBe(1)
		expect(r.out).toContain('FAILED to record')
	})
})

// ── bin/lib-migrations.sh: no implicit baseline, post-deploy phase ──────────
const PSQL = `#!/bin/bash
sql=$(cat)
S="$STATE_DIR"
touch "$S/state"
echo "$* :: $sql" >> "$S/calls.log"
case "$sql" in
  *"powder:schema-check"*) echo "\${STUB_SCHEMA:-public}"; exit 0 ;;
  *"powder:schema-probe"*) echo "$(grep -cvx _fresh_install_in_progress "$S/state")|\${PROBE_TABLES:-1}|$(grep -cx _fresh_install_in_progress "$S/state")" ;;
  *"select 1 from"*) f=$(printf '%s' "$sql" | sed -E "s/.*file='([^']*)'.*/\\1/"); grep -qx "$f" "$S/state" && echo 1 || true ;;
  *"insert into"*) printf '%s' "$sql" | grep -oE "\\('[^']*'\\)" | sed -E "s/\\('([^']*)'\\)/\\1/" >> "$S/state" ;;
  *"create table"*) ;;
  *) printf '%s\\n---\\n' "$sql" >> "$S/applied.log" ;;
esac
`
function libSetup(files: Record<string, string>, recorded: string[] = []) {
	const root = mkdtempSync(join(tmpdir(), 'lib-'))
	const dir = join(root, 'drizzle')
	const state = join(root, 'state')
	mkdirSync(dir)
	mkdirSync(state)
	for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c)
	writeFileSync(join(state, 'state'), recorded.map((r) => `${r}\n`).join(''))
	writeFileSync(join(root, 'psql'), PSQL)
	chmodSync(join(root, 'psql'), 0o755)
	const run = (args: string) =>
		spawnSync('bash', ['-c', `. "${LIB}"; psql_run() { "$ROOT/psql" "$@"; }; MIG_DIR="${dir}"; apply_migrations ${args}`], {
			env: { ...process.env, ROOT: root, STATE_DIR: state },
			encoding: 'utf8',
		})
	const recordedNow = () => readFileSync(join(state, 'state'), 'utf8').split('\n').filter(Boolean)
	const applied = () => (existsSync(join(state, 'applied.log')) ? readFileSync(join(state, 'applied.log'), 'utf8') : '')
	const calls = () => (existsSync(join(state, 'calls.log')) ? readFileSync(join(state, 'calls.log'), 'utf8') : '')
	return { run, recordedNow, applied, calls }
}

describe('lib-migrations ledger', () => {
	it('creating the ledger silences the "already exists" NOTICE like every other statement', () => {
		const lib = readFileSync(LIB, 'utf8')
		expect(lib).toContain(
			'echo "SET client_min_messages=warning;"; echo "create table if not exists $POWDER_LEDGER',
		)
	})
	it('an empty ledger does not record an unapplied file without --baseline', () => {
		const t = libSetup({ '0021_mono_support.sql': 'ALTER TABLE a ADD COLUMN x int;' })
		const r = t.run('pre')
		expect(r.status).toBe(1)
		expect(r.stderr).toMatch(/0021_mono_support.sql is not idempotent/)
		expect(t.recordedNow()).toEqual([])
		expect(t.applied()).toBe('')
	})
	it('--baseline records only the pinned list, never other files', () => {
		const t = libSetup({
			'0021_mono_support.sql': 'ALTER TABLE a ADD COLUMN x int;',
			'0099_new.sql': '-- idempotent\nSELECT 1;',
		})
		const r = t.run('pre --baseline')
		expect(r.status).toBe(0)
		expect(t.recordedNow().sort()).toEqual(['0021_mono_support.sql', '0099_new.sql'])
		expect(t.applied()).not.toContain('ADD COLUMN x')
	})
	it('--baseline does not record an unpinned non-idempotent file', () => {
		const t = libSetup({ '0100_unknown.sql': 'ALTER TABLE a ADD COLUMN y int;' })
		const r = t.run('pre --baseline')
		expect(r.status).toBe(1)
		expect(t.recordedNow()).toEqual([])
	})
	it('post-deploy files wait for the post phase', () => {
		const files = {
			'0001_a.sql': '-- idempotent\nSELECT 1;',
			'0002_drop.sql': '-- idempotent\n-- post-deploy\nSELECT 2;',
		}
		const t = libSetup(files)
		expect(t.run('pre').status).toBe(0)
		expect(t.recordedNow()).toEqual(['0001_a.sql'])
		expect(t.run('post').status).toBe(0)
		expect(t.recordedNow().sort()).toEqual(['0001_a.sql', '0002_drop.sql'])
	})
	it('lib: CONCURRENTLY files run without -1 and are labelled; others use -1', () => {
		const t = libSetup({
			'0001_idx.sql': '-- idempotent\nCREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a);\n',
			'0002_plain.sql': '-- idempotent\nSELECT 2222;\n',
		})
		const r = t.run('pre')
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('0001_idx.sql (non-transactional: CONCURRENTLY)')
		const text = t.calls()
		const argsFor = (marker: string) => {
			const at = text.indexOf(marker)
			const start = text.lastIndexOf(' :: SELECT pg_advisory_lock', at)
			return text.slice(text.lastIndexOf('\n', start) + 1, start)
		}
		expect(argsFor('CONCURRENTLY IF NOT EXISTS')).not.toMatch(/(^| )-1( |$)/)
		expect(argsFor('SELECT 2222')).toMatch(/(^| )-1( |$)/)
	})
	it('lib: ADD VALUE files run without -1', () => {
		const t = libSetup({
			'0001_enum.sql': "-- idempotent\nALTER TYPE mood ADD VALUE IF NOT EXISTS 'ok';\n",
			'0002_plain.sql': '-- idempotent\nSELECT 2222;\n',
		})
		const r = t.run('pre')
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('0001_enum.sql (non-transactional: ADD VALUE)')
		const text = t.calls()
		const at = text.indexOf('ADD VALUE IF NOT EXISTS')
		const start = text.lastIndexOf(' :: SELECT pg_advisory_lock', at)
		expect(text.slice(text.lastIndexOf('\n', start) + 1, start)).not.toMatch(/(^| )-1( |$)/)
	})
	it('drops 0044 and 0045 carry the post-deploy marker', () => {
		for (const n of ['0044_drop_ship_posts_watchdog.sql', '0045_drop_legacy_tables.sql']) {
			const s = readFileSync(join(REPO, 'packages/db/drizzle', n), 'utf8')
			expect(s.split('\n')).toContain('-- post-deploy')
			expect(s.split('\n')).toContain('-- idempotent')
		}
	})
})
