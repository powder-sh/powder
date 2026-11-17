import { spawnSync } from 'node:child_process'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The powder image applies migrations on boot (docker/powder-entrypoint.sh) by
// sourcing bin/lib-migrations.sh, the same rules file bin/self-deploy.sh uses.
// These tests pin that the entrypoint delegates to the lib (no second copy of
// the rules) and that the image ships everything it needs.

const REPO = resolve(__dirname, '../../../../..')
const LIB = join(REPO, 'bin/lib-migrations.sh')
const ENTRY = join(REPO, 'docker/powder-entrypoint.sh')
const DRIZZLE = join(REPO, 'packages/db/drizzle')

// Stub psql (same routing as deploy-migrations.test.ts): state = recorded names,
// applied.log = SQL piped for files.
const STUB = `#!/bin/bash
sql=$(cat)
S="$STATE_DIR"
touch "$S/state"
echo "$*" >> "$S/args.log"
case "$sql" in
  *"powder:schema-check"*) echo "\${STUB_SCHEMA:-public}"; exit 0 ;;
  *"powder:schema-probe"*) echo "$(grep -cvx _fresh_install_in_progress "$S/state")|\${PROBE_TABLES:-1}|$(grep -cx _fresh_install_in_progress "$S/state")" ;;
  *"select 1 from"*) f=$(printf '%s' "$sql" | sed -E "s/.*file='([^']*)'.*/\\1/"); grep -qx "$f" "$S/state" && echo 1 || true ;;
  *"insert into"*) printf '%s' "$sql" | grep -oE "\\('[^']*'\\)" | sed -E "s/\\('([^']*)'\\)/\\1/" >> "$S/state" ;;
  *"create table"*) ;;
  *) printf '%s\\n---\\n' "$sql" >> "$S/applied.log" ;;
esac
`

function setup(files: Record<string, string>, recorded: string[] = [], nodeHealthy = false) {
	const root = mkdtempSync(join(tmpdir(), 'bootmig-'))
	const dir = join(root, 'migrations')
	const state = join(root, 'state')
	const stubs = join(root, 'stubs')
	mkdirSync(dir)
	mkdirSync(state)
	mkdirSync(stubs)
	for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c)
	writeFileSync(join(state, 'state'), recorded.map((r) => `${r}\n`).join(''))
	writeFileSync(join(stubs, 'psql'), STUB)
	chmodSync(join(stubs, 'psql'), 0o755)
	// `node` is only used by the entrypoint's health probe; stub it so the post
	// phase sees a healthy (exit 0) or unhealthy (exit 1) app without a server.
	writeFileSync(join(stubs, 'node'), `#!/bin/bash\nexit ${nodeHealthy ? 0 : 1}\n`)
	chmodSync(join(stubs, 'node'), 0o755)
	const run = (env: Record<string, string> = {}) =>
		spawnSync('bash', [ENTRY, 'echo', 'SERVED'], {
			env: {
				...process.env,
				PATH: `${stubs}:${process.env.PATH}`,
				STATE_DIR: state,
				MIG_DIR: dir,
				POWDER_MIGRATIONS_LIB: LIB,
				DATABASE_URL: 'postgres://u:p@db:5432/powder',
				POWDER_MIGRATE_POST_WAIT: '0',
				...env,
			},
			encoding: 'utf8',
		})
	const recordedNow = () => readFileSync(join(state, 'state'), 'utf8').split('\n').filter(Boolean)
	const appliedLog = () =>
		existsSync(join(state, 'applied.log')) ? readFileSync(join(state, 'applied.log'), 'utf8') : ''
	const argsLog = () =>
		existsSync(join(state, 'args.log')) ? readFileSync(join(state, 'args.log'), 'utf8') : ''
	return { run, recordedNow, appliedLog, argsLog }
}

describe('powder image: migrations on boot', () => {
	it('applies pending idempotent pre files through lib-migrations, then serves', () => {
		const t = setup({
			'0051_a.sql': '-- idempotent\nALTER TABLE x ADD COLUMN IF NOT EXISTS y int;',
		})
		const r = t.run()
		expect(r.status).toBe(0)
		expect(r.stdout).toMatch(/applied: 0051_a.sql/)
		expect(r.stdout).toContain('SERVED')
		expect(t.appliedLog()).toContain('ADD COLUMN IF NOT EXISTS y')
		expect(t.appliedLog()).toContain('pg_advisory_lock')
		expect(t.recordedNow()).toEqual(['0051_a.sql'])
		expect(t.argsLog()).toContain('-d postgres://u:p@db:5432/powder')
		// psql exits 0 on a failed statement from stdin unless ON_ERROR_STOP is set:
		// every call (ledger reads and inserts too) must carry it.
		const calls = t.argsLog().trim().split('\n')
		expect(calls.length).toBeGreaterThan(2)
		for (const c of calls) expect(c).toContain('-v ON_ERROR_STOP=1')
	})
	it('aborts boot on an unrecorded non-idempotent file with the lib message and never serves', () => {
		const t = setup({ '0051_bad.sql': 'ALTER TABLE x ADD COLUMN y int;' })
		const r = t.run()
		expect(r.status).toBe(1)
		expect(r.stderr).toMatch(/0051_bad.sql is not idempotent and not recorded/)
		expect(r.stderr).toMatch(/NOT starting/)
		expect(r.stdout).not.toContain('SERVED')
		expect(t.appliedLog()).toBe('')
	})
	it('post-deploy files wait for a healthy app', () => {
		const t = setup(
			{ '0051_drop.sql': '-- idempotent\n-- post-deploy\nDROP TABLE IF EXISTS old;' },
			[],
			true,
		)
		const r = t.run({ POWDER_MIGRATE_POST_WAIT: '5' })
		expect(r.status).toBe(0)
		expect(r.stdout).toMatch(/no new migrations \(pre-deploy\)/)
		expect(r.stdout).toMatch(/post-deploy phase/)
		expect(t.appliedLog()).toContain('DROP TABLE IF EXISTS old')
		expect(t.recordedNow()).toEqual(['0051_drop.sql'])
	})
	it('post-deploy files are deferred to the next boot when the app never gets healthy', () => {
		const t = setup(
			{ '0051_drop.sql': '-- idempotent\n-- post-deploy\nDROP TABLE IF EXISTS old;' },
			[],
			false,
		)
		const r = t.run()
		expect(r.status).toBe(0)
		expect(r.stderr).toMatch(/deferred to the next boot/)
		expect(t.appliedLog()).toBe('')
		expect(t.recordedNow()).toEqual([])
	})
	it('POWDER_MIGRATE_BASELINE=1 passes --baseline (pinned list only)', () => {
		const t = setup({ '0001_hesitant_orphan.sql': 'CREATE TABLE a ();' })
		const r = t.run({ POWDER_MIGRATE_BASELINE: '1' })
		expect(r.status).toBe(0)
		expect(r.stdout).toMatch(/baselined: 0001_hesitant_orphan.sql/)
		expect(t.appliedLog()).toBe('')
	})
	it('POWDER_MIGRATE_ON_BOOT=off skips the schema step', () => {
		const t = setup({ '0051_bad.sql': 'ALTER TABLE x ADD COLUMN y int;' })
		const r = t.run({ POWDER_MIGRATE_ON_BOOT: 'off' })
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('SERVED')
		expect(t.argsLog()).toBe('')
	})
	it('POWDER_SKIP_BOOT_MIGRATIONS=1 (self-deploy --skip-migrations) skips the schema step', () => {
		const t = setup({ '0051_bad.sql': 'ALTER TABLE x ADD COLUMN y int;' })
		const r = t.run({ POWDER_SKIP_BOOT_MIGRATIONS: '1' })
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('SERVED')
		expect(t.argsLog()).toBe('')
		const r0 = t.run({ POWDER_SKIP_BOOT_MIGRATIONS: '0' })
		expect(r0.status).toBe(1)
	})
	// Small fixture shaped like prod: two pinned non-idempotent files (names from
	// the --baseline list), one idempotent pre file and one post-deploy file. The
	// real files are covered by the "migration files" guards below.
	const LEDGER_FIXTURE = {
		'0000_elite_mentor.sql': 'CREATE TABLE a ();',
		'0033_backup_retention.sql': 'ALTER TABLE a ADD COLUMN b int;',
		'0050_c.sql': '-- idempotent\nALTER TABLE a ADD COLUMN IF NOT EXISTS c int;',
		'0051_drop.sql': '-- idempotent\n-- post-deploy\nDROP TABLE IF EXISTS old;',
	}
	it('a ledger written by bin/self-deploy.sh needs no baseline at boot', () => {
		// Fully populated ledger (prod today): nothing to do, serves.
		const full = setup(LEDGER_FIXTURE, Object.keys(LEDGER_FIXTURE))
		const r1 = full.run()
		expect(r1.status).toBe(0)
		expect(r1.stdout).toMatch(/no new migrations \(pre-deploy\)/)
		expect(r1.stdout).toContain('SERVED')
		expect(full.appliedLog()).toBe('')
		// Ledger with only the --baseline pinned files: the idempotent rest applies.
		const partial = setup(LEDGER_FIXTURE, ['0000_elite_mentor.sql', '0033_backup_retention.sql'])
		const r2 = partial.run()
		expect(r2.status).toBe(0)
		expect(r2.stderr).not.toMatch(/not idempotent/)
		expect(r2.stdout).toMatch(/applied: 0050_c.sql/)
		expect(r2.stdout).toContain('SERVED')
	}, 15_000)
	it('the entrypoint sources lib-migrations.sh and holds no rules of its own', () => {
		const s = readFileSync(ENTRY, 'utf8')
		expect(s).toContain('. "$LIB"')
		expect(s).toContain('apply_migrations pre')
		expect(s).toContain('apply_migrations post')
		expect(s).not.toMatch(/grep -qx|insert into|select 1 from|is_idempotent_file/)
	})
	it('the web image ships the migration SQL, the lib and the entrypoint', () => {
		const df = readFileSync(join(REPO, 'docker/web.Dockerfile'), 'utf8')
		const runner = df.slice(df.indexOf('AS runner\n'), df.indexOf('AS runner-worker'))
		expect(runner).toContain('COPY packages/db/drizzle/*.sql ./migrations/')
		expect(runner).toContain('COPY bin/lib-migrations.sh ./bin/lib-migrations.sh')
		expect(runner).toContain('COPY docker/powder-entrypoint.sh ./bin/powder-entrypoint.sh')
		expect(runner).toContain('ENTRYPOINT ["/bin/bash", "/app/bin/powder-entrypoint.sh"]')
		expect(runner).toMatch(/install[^\n]*postgresql-client/)
		const ignore = readFileSync(join(REPO, '.dockerignore'), 'utf8')
		expect(ignore).not.toMatch(/^(bin|packages|docker)\b/m)
	})
})

describe('migration files', () => {
	const files = readdirSync(DRIZZLE).filter((f) => f.endsWith('.sql'))
	const marked = (f: string) =>
		readFileSync(join(DRIZZLE, f), 'utf8').split('\n').includes('-- idempotent')
	it('every file numbered above 0050 carries the exact line -- idempotent', () => {
		const unmarked = files.filter((f) => Number.parseInt(f.slice(0, 4), 10) > 50 && !marked(f))
		expect(unmarked).toEqual([])
	})
	it('every file not on the pinned baseline list is idempotent (else boot aborts)', () => {
		const lib = readFileSync(LIB, 'utf8')
		const pinned = lib.slice(
			lib.indexOf('POWDER_BASELINE_FILES=('),
			lib.indexOf(')\n', lib.indexOf('POWDER_BASELINE_FILES=(')),
		)
		const unmarked = files.filter((f) => !pinned.includes(f) && !marked(f))
		expect(unmarked).toEqual([])
	})
})
