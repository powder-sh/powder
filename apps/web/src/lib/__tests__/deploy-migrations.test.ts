import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const LIB = resolve(__dirname, '../../../../../bin/lib-migrations.sh')

// Stub psql: state file = recorded names, applied.log = files piped as SQL.
const STUB = `#!/bin/bash
sql=$(cat)
S="$STATE_DIR"
touch "$S/state"
case "$sql" in
  *"powder:schema-check"*) echo "\${STUB_SCHEMA:-public}"; exit 0 ;;
  *"powder:schema-probe"*) echo "$(grep -cvx _fresh_install_in_progress "$S/state")|\${PROBE_TABLES:-1}|$(grep -cx _fresh_install_in_progress "$S/state")" ;;
  *"select count(*)"*) wc -l < "$S/state" | tr -d ' ' ;;
  *"max(file)"*) sort "$S/state" | tail -1 ;;
  *"select 1 from"*) f=$(printf '%s' "$sql" | sed -E "s/.*file='([^']*)'.*/\\1/"); grep -qx "$f" "$S/state" && echo 1 || true ;;
  *"insert into"*) printf '%s' "$sql" | grep -oE "\\('[^']*'\\)" | sed -E "s/\\('([^']*)'\\)/\\1/" >> "$S/state" ;;
  *"create table"*) ;;
  *FAIL_ME*) echo 'psql: error' >&2; exit 3 ;;
  *) printf '%s\\n---\\n' "$sql" >> "$S/applied.log" ;;
esac
`

function setup(files: Record<string, string>, recorded: string[] = [], tableExists = true, failOnFailMe = false) {
	const root = mkdtempSync(join(tmpdir(), 'mig-'))
	const dir = join(root, 'drizzle')
	const state = join(root, 'state')
	require('node:fs').mkdirSync(dir)
	require('node:fs').mkdirSync(state)
	for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c)
	writeFileSync(join(state, 'state'), recorded.map((r) => `${r}\n`).join(''))
	void tableExists
	void failOnFailMe
	writeFileSync(join(root, 'psql'), STUB)
	chmodSync(join(root, 'psql'), 0o755)
	const run = (args = 'pre') =>
		spawnSync(
			'bash',
			['-c', `. "${LIB}"; psql_run() { "$ROOT/psql" "$@"; }; MIG_DIR="${dir}"; apply_migrations ${args}`],
			{ env: { ...process.env, ROOT: root, STATE_DIR: state }, encoding: 'utf8' },
		)
	const recordedNow = () => readFileSync(join(state, 'state'), 'utf8').split('\n').filter(Boolean)
	const appliedLog = () => (existsSync(join(state, 'applied.log')) ? readFileSync(join(state, 'applied.log'), 'utf8') : '')
	const write = (n: string, c: string) => writeFileSync(join(dir, n), c)
	return { run, recordedNow, appliedLog, write }
}

describe('deploy-powder migration step', () => {
	it('--baseline records pinned files non-idempotent files and applies idempotent ones', () => {
		const t = setup({
			'0001_hesitant_orphan.sql': 'CREATE TABLE a ();',
			'0002_new.sql': '-- idempotent\nALTER TABLE a ADD COLUMN IF NOT EXISTS b text;',
		})
		const r = t.run('pre --baseline')
		expect(r.status).toBe(0)
		expect(r.stdout).toMatch(/baselined: 0001_hesitant_orphan.sql/)
		expect(r.stdout).toMatch(/applied: 0002_new.sql/)
		expect(t.appliedLog()).toContain('ADD COLUMN IF NOT EXISTS b')
		expect(t.appliedLog()).not.toContain('CREATE TABLE a')
		expect(t.recordedNow().sort()).toEqual(['0001_hesitant_orphan.sql', '0002_new.sql'])
	})
	it('does not re-apply recorded files', () => {
		const t = setup({ '0002_new.sql': '-- idempotent\nSELECT 1;' }, ['0002_new.sql'])
		const r = t.run()
		expect(r.status).toBe(0)
		expect(r.stdout).toMatch(/no new migrations/)
		expect(t.appliedLog()).toBe('')
	})
	it('aborts on any unrecorded non-idempotent file after the baseline, newer or older', () => {
		const newer = setup(
			{ '0002_a.sql': '-- idempotent\nSELECT 1;', '0003_b.sql': 'ALTER TABLE a ADD COLUMN c int;' },
			['0002_a.sql'],
		)
		const r = newer.run()
		expect(r.status).toBe(1)
		expect(r.stderr).toMatch(/0003_b.sql is not idempotent/)
		expect(newer.appliedLog()).toBe('')
		const older = setup(
			{ '0001_old.sql': 'CREATE TABLE a ();', '0002_a.sql': '-- idempotent\nSELECT 1;' },
			['0002_a.sql'],
		)
		const r2 = older.run()
		expect(r2.status).toBe(1)
		expect(r2.stderr).toMatch(/0001_old.sql is not idempotent/)
	})
	it('marker must be an exact line, not a mention', () => {
		const t = setup({ '0001_hesitant_orphan.sql': '-- not idempotent at all\nCREATE TABLE a ();' })
		const r = t.run('pre --baseline')
		expect(r.stdout).toMatch(/baselined: 0001_hesitant_orphan.sql/)
		expect(t.appliedLog()).toBe('')
	})
	it('prefixes each applied file with a lock_timeout', () => {
		const t = setup({ '0002_a.sql': '-- idempotent\nSELECT 1;' })
		t.run()
		expect(t.appliedLog()).toContain("SET lock_timeout='5s';")
	})
	it('a psql failure on a file aborts and records nothing for it', () => {
		const t = setup({ '0002_a.sql': '-- idempotent\nFAIL_ME;' }, [], true, true)
		const r = t.run()
		expect(r.status).toBe(1)
		expect(r.stderr).toMatch(/0002_a.sql failed/)
		expect(t.recordedNow()).toEqual([])
	})
	it('first run fails on an idempotent file, the retry succeeds (baseline already recorded)', () => {
		const t = setup({
			'0001_hesitant_orphan.sql': 'CREATE TABLE a ();',
			'0002_a.sql': '-- idempotent\nFAIL_ME;',
		})
		const r1 = t.run('pre --baseline')
		expect(r1.status).toBe(1)
		expect(t.recordedNow()).toEqual(['0001_hesitant_orphan.sql'])
		t.write('0002_a.sql', '-- idempotent\nSELECT 1;')
		const r2 = t.run()
		expect(r2.status).toBe(0)
		expect(r2.stdout).toMatch(/applied: 0002_a.sql/)
		expect(t.recordedNow().sort()).toEqual(['0001_hesitant_orphan.sql', '0002_a.sql'])
	})
})

// Fresh database: empty ledger and none of the tables the files create.
// Stub: state = ledger rows, tables = PROBE_TABLES, applied.log = "<args> :: <sql>"
// for every file piped (the ledger insert rides in the same input).
const FRESH_STUB = `#!/bin/bash
sql=$(cat)
S="$STATE_DIR"
touch "$S/state"
case "$sql" in
  *"powder:schema-check"*) echo "\${STUB_SCHEMA:-public}"; exit 0 ;;
  *"create table if not exists public.powder_deploy_migrations"*) ;;
  *"powder:schema-probe"*) [ -n "$PROBE_FAIL" ] && exit 2; [ -n "$PROBE_GARBAGE" ] && { echo 'garbage'; exit 0; }; echo "$(grep -cvx _fresh_install_in_progress "$S/state")|\${PROBE_TABLES:-0}|$(grep -cx _fresh_install_in_progress "$S/state")" ;;
  *pg_advisory_lock*)
    case "$sql" in *powder:already-recorded*)
      f=$(printf '%s' "$sql" | sed -nE "s/.*WHERE file = '([^']*)'.*/\\1/p" | head -1)
      grep -qx "$f" "$S/state" && { echo 'ERROR:  powder:already-recorded' >&2; exit 3; } ;;
    esac
    printf '%s :: %s\\n---\\n' "$*" "$sql" >> "$S/applied.log"
    case "$sql" in *FAIL_ME*) echo 'psql: error' >&2; exit 3 ;; esac
    printf '%s' "$sql" | grep -oE "values \\('[^']*'\\)" | sed -E "s/values \\('([^']*)'\\)/\\1/" >> "$S/state" ;;
  *"select 1 from"*) f=$(printf '%s' "$sql" | sed -E "s/.*file='([^']*)'.*/\\1/"); grep -qx "$f" "$S/state" && echo 1 || true ;;
  *"delete from"*) grep -vx _fresh_install_in_progress "$S/state" > "$S/state.new"; mv "$S/state.new" "$S/state" ;;
  *"insert into"*) printf '%s' "$sql" | grep -oE "\\('[^']*'\\)" | sed -E "s/\\('([^']*)'\\)/\\1/" >> "$S/state" ;;
esac
`

function freshSetup(files: Record<string, string>, recorded: string[] = []) {
	const root = mkdtempSync(join(tmpdir(), 'mig-fresh-'))
	const dir = join(root, 'drizzle')
	const state = join(root, 'state')
	require('node:fs').mkdirSync(dir)
	require('node:fs').mkdirSync(state)
	for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c)
	writeFileSync(join(state, 'state'), recorded.map((r) => `${r}\n`).join(''))
	writeFileSync(join(root, 'psql'), FRESH_STUB)
	chmodSync(join(root, 'psql'), 0o755)
	const run = (args = 'pre', env: Record<string, string> = {}) =>
		spawnSync(
			'bash',
			['-c', `. "${LIB}"; psql_run() { "$ROOT/psql" "$@"; }; MIG_DIR="${dir}"; apply_migrations ${args}`],
			{
				env: { ...process.env, ROOT: root, STATE_DIR: state, POWDER_ALLOW_FRESH_SCHEMA: '1', ...env },
				encoding: 'utf8',
			},
		)
	const recordedNow = () => readFileSync(join(state, 'state'), 'utf8').split('\n').filter(Boolean)
	const appliedLog = () => (existsSync(join(state, 'applied.log')) ? readFileSync(join(state, 'applied.log'), 'utf8') : '')
	const write = (n: string, c: string) => writeFileSync(join(dir, n), c)
	return { run, recordedNow, appliedLog, write }
}

const FRESH_FILES = {
	'0000_init.sql': 'CREATE TABLE "servers" (id text);',
	'0001_enum.sql': "ALTER TYPE k ADD VALUE 'x';",
	'0002_more.sql': '-- idempotent\nCREATE TABLE IF NOT EXISTS "deploys" (id text);',
	'0003_late.sql': '-- idempotent\n-- post-deploy\nSELECT 3333;',
}

describe('lib-migrations: fresh database', () => {
	it('applies every file in filename order, pre and post, and records each', () => {
		const t = freshSetup(FRESH_FILES)
		const r = t.run('pre')
		expect(r.status).toBe(0)
		expect(r.stdout).toMatch(/fresh database/)
		expect(r.stdout).toMatch(/applied: 4 files \(fresh install\)/)
		const log = t.appliedLog()
		const order = ['CREATE TABLE "servers"', "ADD VALUE 'x'", '"deploys"', 'SELECT 3333'].map((m) => log.indexOf(m))
		expect(order.every((i) => i >= 0)).toBe(true)
		expect([...order].sort((a, b) => a - b)).toEqual(order)
		expect(t.recordedNow().sort()).toEqual(Object.keys(FRESH_FILES).sort())
	})
	it('records a transactional file in the same -1 input that applies it; ADD VALUE files run without -1', () => {
		const t = freshSetup(FRESH_FILES)
		t.run('pre')
		const chunks = t.appliedLog().split('\n---\n').filter(Boolean)
		const init = chunks.find((c) => c.includes('"servers"')) ?? ''
		expect(init.split(' :: ')[0]).toMatch(/(^| )-1( |$)/)
		expect(init).toContain('ON_ERROR_STOP=1')
		expect(init).toContain("insert into public.powder_deploy_migrations(file) values ('0000_init.sql')")
		const en = chunks.find((c) => c.includes('ADD VALUE')) ?? ''
		expect(en.split(' :: ')[0]).not.toMatch(/(^| )-1( |$)/)
	})
	it('the second run is a no-op, and the marker row is gone', () => {
		const t = freshSetup(FRESH_FILES)
		expect(t.run('pre').status).toBe(0)
		expect(t.recordedNow()).not.toContain('_fresh_install_in_progress')
		// The tables now exist and the ledger has rows: the normal path.
		const again = t.run('pre', { PROBE_TABLES: '2' })
		expect(again.status).toBe(0)
		expect(again.stdout).toMatch(/no new migrations \(pre-deploy\)/)
		const post = t.run('post', { PROBE_TABLES: '2' })
		expect(post.stdout).toMatch(/no new migrations \(post-deploy\)/)
	})
	it('a failure half way resumes on the next run instead of asking for --baseline', () => {
		const t = freshSetup({ ...FRESH_FILES, '0002_more.sql': '-- idempotent\nFAIL_ME;' })
		const r1 = t.run('pre')
		expect(r1.status).toBe(1)
		expect(r1.stderr).toMatch(/0002_more.sql failed/)
		expect(t.recordedNow().sort()).toEqual(['0000_init.sql', '0001_enum.sql', '_fresh_install_in_progress'])
		t.write('0002_more.sql', FRESH_FILES['0002_more.sql'])
		// Tables from 0000 exist now; the marker keeps it on the fresh path.
		const r2 = t.run('pre', { PROBE_TABLES: '1' })
		expect(r2.status).toBe(0)
		expect(r2.stdout).toMatch(/applied: 2 files \(fresh install\)/)
		expect(t.recordedNow().sort()).toEqual(Object.keys(FRESH_FILES).sort())
		expect(t.appliedLog().match(/CREATE TABLE "servers"/g)?.length).toBe(1)
	})
	it('--baseline on an empty database is ignored, the schema is created', () => {
		const t = freshSetup(FRESH_FILES)
		const r = t.run('pre --baseline')
		expect(r.status).toBe(0)
		expect(r.stdout).toMatch(/--baseline ignored/)
		expect(r.stdout).not.toMatch(/baselined:/)
		expect(t.recordedNow().sort()).toEqual(Object.keys(FRESH_FILES).sort())
	})
	it('tables present with an empty ledger is a hand-built schema: still needs --baseline', () => {
		const t = freshSetup(FRESH_FILES)
		const r = t.run('pre', { PROBE_TABLES: '1' })
		expect(r.status).toBe(1)
		expect(r.stderr).toMatch(/0000_init.sql is not idempotent and not recorded/)
		expect(t.appliedLog()).toBe('')
		expect(t.recordedNow()).toEqual([])
	})
	it('fails closed when the probe fails or answers garbage', () => {
		for (const env of [{ PROBE_FAIL: '1' }, { PROBE_GARBAGE: '1' }] as Record<string, string>[]) {
			const t = freshSetup(FRESH_FILES)
			const r = t.run('pre', env)
			expect(r.status).toBe(1)
			expect(t.appliedLog()).toBe('')
			expect(t.recordedNow()).toEqual([])
		}
	})
	it('a ledger with rows and no marker is the normal path even if no table is found', () => {
		const t = freshSetup(FRESH_FILES, ['0000_init.sql'])
		const r = t.run('pre', { PROBE_TABLES: '0' })
		expect(r.status).toBe(1)
		expect(r.stderr).toMatch(/0001_enum.sql is not idempotent/)
	})
	it('refuses a session whose current schema is not public, before the ledger is touched', () => {
		for (const schema of ['other', '(none)']) {
			const t = freshSetup(FRESH_FILES)
			const r = t.run('pre', { STUB_SCHEMA: schema })
			expect(r.status).toBe(1)
			expect(r.stderr).toContain(`current schema is '${schema}', not public`)
			expect(t.appliedLog()).toBe('')
			expect(t.recordedNow()).toEqual([])
		}
	})
	it('checks the ledger inside the locked input: a file another applier recorded meanwhile is skipped', () => {
		const t = freshSetup(FRESH_FILES)
		expect(t.run('pre').status).toBe(0)
		const init = t.appliedLog().split('\n---\n').find((c) => c.includes('"servers"')) ?? ''
		const sql = init.split(' :: ')[1] ?? ''
		expect(sql.indexOf('pg_advisory_lock')).toBeLessThan(sql.indexOf('powder:already-recorded'))
		expect(sql.indexOf('powder:already-recorded')).toBeLessThan(sql.indexOf('CREATE TABLE "servers"'))
		// Simulate the second applier: every file is recorded, the marker is back.
		const r = t.run('pre', { PROBE_TABLES: '0' })
		expect(r.status).toBe(0)
		expect(r.stdout).toMatch(/no new migrations|applied: 0 files \(fresh install\), 4 already recorded/)
	})
	it('an empty database without POWDER_ALLOW_FRESH_SCHEMA is refused: nothing applied, nothing recorded', () => {
		// The env file of an existing install has no opt-in: a wrong DATABASE_URL must
		// not turn into an empty, running powder.
		for (const optIn of ['', '0', 'no']) {
			const t = freshSetup(FRESH_FILES)
			const r = t.run('pre', { POWDER_ALLOW_FRESH_SCHEMA: optIn })
			expect(r.status).toBe(1)
			expect(r.stderr).toContain('POWDER_ALLOW_FRESH_SCHEMA=1')
			expect(r.stderr).toContain('Check DATABASE_URL first')
			expect(t.appliedLog()).toBe('')
			expect(t.recordedNow()).toEqual([])
		}
	})
	it('an unfinished fresh install (marker row) resumes without the opt-in', () => {
		const t = freshSetup(FRESH_FILES, ['_fresh_install_in_progress', '0000_init.sql'])
		const r = t.run('pre', { POWDER_ALLOW_FRESH_SCHEMA: '', PROBE_TABLES: '1' })
		expect(r.status, r.stderr).toBe(0)
		expect(t.recordedNow().sort()).toEqual(Object.keys(FRESH_FILES).sort())
	})
	it('a comment that mentions CONCURRENTLY or ADD VALUE keeps the file in one transaction (fresh and normal path)', () => {
		const files = {
			'0000_init.sql': '-- idempotent\n-- not created concurrently: the table is empty here\nCREATE TABLE IF NOT EXISTS "servers" (id text);',
			'0001_idx.sql': '-- idempotent\n/* an earlier draft used\n   ALTER TYPE k ADD VALUE */\nCREATE INDEX IF NOT EXISTS i ON servers (id);',
			'0002_conc.sql': '-- idempotent\nCREATE INDEX CONCURRENTLY IF NOT EXISTS j ON servers (id);',
		}
		const argsOf = (log: string, marker: string) =>
			(log.split('\n---\n').find((c) => c.includes(marker)) ?? '').split(' :: ')[0]
		const fresh = freshSetup(files)
		expect(fresh.run('pre').status).toBe(0)
		expect(argsOf(fresh.appliedLog(), '"servers" (id text)')).toMatch(/(^| )-1( |$)/)
		expect(argsOf(fresh.appliedLog(), 'INDEX IF NOT EXISTS i')).toMatch(/(^| )-1( |$)/)
		expect(argsOf(fresh.appliedLog(), 'CONCURRENTLY IF NOT EXISTS j')).not.toMatch(/(^| )-1( |$)/)
		// normal path: a recorded ledger, tables present
		const normal = freshSetup(files, ['0000_init.sql'])
		const r = normal.run('pre', { PROBE_TABLES: '1' })
		expect(r.status, r.stderr).toBe(0)
		expect(r.stdout).toContain('applied: 0001_idx.sql\n')
		expect(r.stdout).toContain('applied: 0002_conc.sql (non-transactional: CONCURRENTLY)')
		expect(argsOf(normal.appliedLog(), 'INDEX IF NOT EXISTS i')).toMatch(/(^| )-1( |$)/)
		expect(argsOf(normal.appliedLog(), 'CONCURRENTLY IF NOT EXISTS j')).not.toMatch(/(^| )-1( |$)/)
	})
	it('names the ledger and the probed tables in public', () => {
		const lib = readFileSync(LIB, 'utf8')
		expect(lib).toContain('POWDER_LEDGER=public.powder_deploy_migrations')
		expect(lib).toContain("to_regclass('public.' || quote_ident(t.n))")
		expect(lib).not.toMatch(/(from|into|exists) powder_deploy_migrations/)
	})
})
