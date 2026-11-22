import { spawnSync } from 'node:child_process'
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DB_LAYOUT_SH } from '../deploy/self-deploy'

// Runs bin/self-deploy.sh for real under bash with stub ssh/rsync/git/curl/sleep
// on PATH and asserts on the commands it would have run (migrations first).

const BIN = resolve(__dirname, '../../../../../bin')

const STUBS: Record<string, string> = {
	ssh: `#!/bin/bash
echo "[ssh] $*" >> "$CALLS"
if [ ! -t 0 ]; then SQL=$(cat); [ -n "$SQL" ] && echo "[sql] $SQL" >> "$CALLS"; fi
case "$SQL" in
  *"powder:schema-check"*) echo "\${STUB_SCHEMA:-public}"; exit 0 ;;
  *"powder:schema-probe"*) echo "\${PROBE_OUT:-1|1|0}"; exit 0;;
  *"count(*) from public.powder_deploy_migrations"*) echo "\${MIG_COUNT:-0}"; exit 0;;
  *"select 1 from public.powder_deploy_migrations"*)
    N=$(echo "$SQL" | sed -n "s/.*file='\\([^']*\\)'.*/\\1/p")
    grep -q "('$N'" "$CALLS.rec" 2>/dev/null && echo 1
    exit 0;;
  *"insert into public.powder_deploy_migrations"*) echo "$SQL" >> "$CALLS.rec"; exit 0;;
esac
# The recreate step really runs (locally, with the stub docker) so a failed
# \`up\` behind \`| tail\` is observable as the script's exit status.
case "$2" in
  *"bash -o pipefail -c"*"force-recreate"*) cd "$POWDER_SRC" && bash -c "$2"; exit $?;;
esac
case "$*" in
  *"env-pin-report.ts"*) [ -n "$STUB_PIN_FAIL" ] && { echo "[env-pin-report] failed: connect ECONNREFUSED"; exit 1; }; echo "[env-pin-report] 0 apps need attention"; exit 0;;
  *"check-config"*) [ -n "$STUB_CONFIG_BROKEN" ] && { echo 'exec: "pnpm": executable file not found in $PATH'; exit 127; }; [ -n "$STUB_CONFIG_BAD" ] && { echo "__POWDER_CONFIG_BAD__ the new powder would refuse to start:"; echo " - BETTER_AUTH_SECRET is only 8 characters"; exit 1; }; echo "[config-check] powder.env passes"; exit 0;;
  *".powder-build-cache-id"*) printf '%s' 0123456789abcdef0123456789abcdef; exit 0;;
  *"powder-pgdata"*) [ "$STUB_LAYOUT_SSH_FAIL" = 1 ] && exit 255; [ -n "$STUB_BANNER" ] && echo "$STUB_BANNER"; echo "\${STUB_LAYOUT:-private}"; exit 0;;
  *"docker inspect -f ok powder-postgres"*) [ -n "$STUB_PG_NEW" ] && echo ok; exit 0;;
  *"^DATABASE_URL=.*@powder-postgres:"*) [ "$STUB_DBURL_OK" = 1 ] && exit 0; exit 1;;
esac
case "$*" in
  *"^POWDER_DASHBOARD_HOST=."*) echo "\${TRAEFIK_OUT:-skip}"; exit 0;;
esac
case "$*" in
  *"s/^POWDER_DB_USER="*) echo "\${STUB_DB_USER:-}"; exit 0;;
  *"s/^POWDER_DB_NAME="*) echo "\${STUB_DB_NAME:-}"; exit 0;;
  *"s/^POWDER_PORT="*) echo "\${STUB_PORT:-}"; exit 0;;
  *"s/^POWDER_DB_NETWORK="*) echo "\${STUB_DB_NETWORK:-}"; exit 0;;
  *"s/^POWDER_WEB_READONLY="*) echo "\${STUB_WEB_RO:-}"; exit 0;;
  *"s/^POWDER_HARDEN="*) echo "\${STUB_HARDEN:-}"; exit 0;;
esac
case "$*" in
  *"powder:inflight-cols"*) echo "\${STUB_SETTLE_COLS:-0}";;
  *"from deploys"*) echo "\${STUB_INFLIGHT:-0}";;
  *api/health*) echo '{"status":"ok"}';;
esac
exit 0
`,
	rsync: '#!/bin/bash\necho "[rsync] $*" >> "$CALLS"\n',
	curl: '#!/bin/bash\necho "[curl] $*" >> "$CALLS"\ncase "$*" in *http_code*) if [ -n "$CURL_SEQ" ]; then echo x >> "$CALLS.n"; n=$(wc -l < "$CALLS.n"); echo "$CURL_SEQ" | cut -d, -f$n; else echo "${CURL_CODE:-200}"; fi;; esac\n',
	sleep: '#!/bin/bash\nexit 0\n',
	docker: `#!/bin/bash
echo "[docker] $*" >> "$CALLS"
case "$*" in *" up "*) echo "[docker-env] POWDER_SKIP_BOOT_MIGRATIONS=\${POWDER_SKIP_BOOT_MIGRATIONS-unset}" >> "$CALLS";; esac
case "$*" in *" up "*) [ "$FAIL_UP" = 1 ] && exit 1;; esac
exit 0
`,
	// `git archive HEAD` emits the COMMITTED tree (a fixture dir), never the repo dir.
	git: `#!/bin/bash
echo "[git] $*" >> "$CALLS"
case "$*" in
  "archive HEAD") tar -c -C "$ARCHIVE_SRC" .;;
  "rev-parse --short HEAD") echo abc1234;;
  "status --porcelain --untracked-files=no") [ "$DIRTY" = 1 ] && echo " M apps/web/x.ts";;
esac
exit 0
`,
}

function run(
	args: string[],
	files: Record<string, string>,
	extraEnv: Record<string, string> = {},
	wtOnly: Record<string, string> = {},
	composeYml = 'services: {}\n',
) {
	const root = mkdtempSync(join(tmpdir(), 'sds-'))
	const repo = join(root, 'repo')
	const stubs = join(root, 'stubs')
	const archive = join(root, 'archive')
	mkdirSync(join(repo, 'bin'), { recursive: true })
	mkdirSync(join(repo, 'packages/db/drizzle'), { recursive: true })
	mkdirSync(join(archive, 'bin'), { recursive: true })
	mkdirSync(join(archive, 'packages/db/drizzle'), { recursive: true })
	mkdirSync(stubs)
	cpSync(join(BIN, 'self-deploy.sh'), join(repo, 'bin/self-deploy.sh'))
	cpSync(join(BIN, 'lib-db-layout.sh'), join(repo, 'bin/lib-db-layout.sh'))
	// The committed tree (what `git archive HEAD` returns) carries the migration helper and SQL.
	cpSync(join(BIN, 'lib-migrations.sh'), join(archive, 'bin/lib-migrations.sh'))
	writeFileSync(join(archive, 'docker-compose.yml'), composeYml)
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(archive, 'packages/db/drizzle', name), body)
	}
	// Working-tree-only state that must never ship or be applied.
	for (const [name, body] of Object.entries(wtOnly)) {
		writeFileSync(join(repo, 'packages/db/drizzle', name), body)
	}
	for (const [name, body] of Object.entries(STUBS)) {
		writeFileSync(join(stubs, name), body)
		chmodSync(join(stubs, name), 0o755)
	}
	const src = join(root, 'remote-src')
	mkdirSync(src)
	const calls = join(root, 'calls.log')
	writeFileSync(calls, '')
	const res = spawnSync('bash', [join(repo, 'bin/self-deploy.sh'), ...args], {
		env: {
			...process.env,
			PATH: `${stubs}:${process.env.PATH}`,
			CALLS: calls,
			ARCHIVE_SRC: archive,
			POWDER_HOST: 'root@server',
			POWDER_SRC: src,
			...extraEnv,
		},
		encoding: 'utf8',
		input: '',
	})
	return { res, log: existsSync(calls) ? readFileSync(calls, 'utf8') : '' }
}

const FILES = {
	'0001_hesitant_orphan.sql': 'create table a (id int);\n',
	'0002_b.sql': '-- idempotent\ncreate table if not exists b (id int);\n',
}

describe('bin/self-deploy.sh (stubbed)', () => {
	it('applies migrations before rsync, build and recreate', () => {
		const { res, log } = run(['--baseline'], FILES)
		expect(res.stderr).toBe('')
		expect(res.status).toBe(0)
		const iMig = log.indexOf('create table if not exists b')
		expect(iMig).toBeGreaterThan(-1)
		expect(log.indexOf('[rsync]')).toBeGreaterThan(iMig)
		expect(log.indexOf('compose --env-file /opt/apps/powder.env build')).toBeGreaterThan(iMig)
		expect(log.indexOf('up -d --force-recreate')).toBeGreaterThan(iMig)
		expect(log).toContain('powder_deploy_migrations')
		expect(log).toContain('ON_ERROR_STOP=1')
	})

	it('a DB that does not answer the in-flight query stops the run, also with --force when migrations need it', () => {
		const down = { STUB_INFLIGHT: 'psql: error' }
		for (const args of [['--baseline'], ['--baseline', '--force']]) {
			const { res, log } = run(args, FILES, down)
			expect(res.status, args.join(' ')).toBe(1)
			expect(res.stderr).toContain("could not query powder's DB (container powder-postgres not running? check: ssh root@server docker ps -a --filter name=powder-postgres)")
			expect(res.stderr).not.toContain('deploy(s) in flight')
			expect(log).not.toContain('[rsync]')
			expect(log).not.toContain('force-recreate')
		}
		expect(run(['--baseline', '--force'], FILES, down).res.stderr).toContain('the migrations step needs the DB')
		const legacy = run(['--baseline'], FILES, { ...down, STUB_LAYOUT: 'legacy' })
		expect(legacy.res.stderr).toContain('container postgres not running?')
	})

	it('--force with --skip-migrations continues past a DB that does not answer, and says so', () => {
		const { res, log } = run(['--force', '--skip-migrations'], FILES, { STUB_INFLIGHT: 'psql: error' })
		expect(res.status, res.stderr).toBe(0)
		expect(res.stderr).toContain("could not query powder's DB")
		expect(res.stderr).toContain('--force: continuing without the in-flight check and without the DB')
		expect(log).toContain('up -d --force-recreate')
	})

	it('--pin-report needs the DB, also with --force: the report reads it', () => {
		for (const args of [['--pin-report'], ['--pin-report', '--force']]) {
			const { res, log } = run(args, FILES, { STUB_INFLIGHT: 'psql: error' })
			expect(res.status, args.join(' ')).toBe(1)
			expect(res.stderr).toContain("could not query powder's DB")
			expect(res.stdout).not.toContain('--pin-report done')
			expect(log).not.toContain('[rsync]')
			expect(log).not.toContain('env-pin-report.ts')
		}
		expect(run(['--pin-report', '--force'], FILES, { STUB_INFLIGHT: 'psql: error' }).res.stderr).toContain(
			"--pin-report reads powder's DB",
		)
	})

	it('a failed pin report fails --pin-report and never prints done; a normal run warns and goes on', () => {
		const r = run(['--pin-report'], FILES, { STUB_PIN_FAIL: '1' })
		expect(r.res.status).toBe(1)
		expect(r.res.stdout).toContain('[env-pin-report] failed')
		expect(r.res.stdout).not.toContain('--pin-report done')
		expect(r.res.stderr).toContain('--pin-report: the report failed (exit 1')
		const full = run(['--skip-migrations'], FILES, { STUB_PIN_FAIL: '1' })
		expect(full.res.status, full.res.stderr).toBe(0)
		expect(full.res.stderr).toContain('the env render target report failed (exit 1)')
		expect(full.log).toContain('force-recreate')
	})

	it('the pin report entry exits non-zero when the report fails', () => {
		const src = readFileSync(join(__dirname, '../../env-pin-report.ts'), 'utf8')
		expect(src).toMatch(/\.catch\([\s\S]*process\.exit\(1\)/)
	})

	it('refuses a POWDER_SRC with shell characters before any ssh', () => {
		for (const bad of ['/opt/apps/powder/src;id', '/opt/a b', '/opt/$(id)', "/opt/'x'"]) {
			const r = run(['--baseline'], FILES, { POWDER_SRC: bad })
			expect(r.res.status, bad).toBe(1)
			expect(r.res.stderr).toContain('POWDER_SRC must be a plain path')
			expect(r.log, bad).not.toContain('[ssh]')
		}
	})

	it('accepts only a plain http(s) POWDER_HEALTH_URL, and single-quotes it in the remote curl', () => {
		for (const bad of ['http://127.0.0.1:3050/api/health;id', 'http://x/$(id)', "http://x/'a'", 'ftp://x/h', 'http://x/h?a=1', 'http://x/a b']) {
			const r = run(['--baseline'], FILES, { POWDER_HEALTH_URL: bad })
			expect(r.res.status, bad).toBe(1)
			expect(r.res.stderr, bad).toContain('POWDER_HEALTH_URL must be a plain http(s) URL')
			expect(r.log, bad).not.toContain('--force-recreate')
		}
		const ok = run(['--baseline'], FILES, { POWDER_HEALTH_URL: 'https://powder.example.com:8443/api/health' })
		expect(ok.res.status, ok.res.stderr).toBe(0)
		expect(ok.log).toContain("curl -s --max-time 8 'https://powder.example.com:8443/api/health'")
	})

	it('passes POWDER_COMPOSE_PROJECT as -p, default unchanged', () => {
		const withProj = run(['--baseline'], FILES, { POWDER_COMPOSE_PROJECT: 'mypowder' })
		expect(withProj.res.status).toBe(0)
		expect(withProj.log).toContain('compose -p mypowder --env-file /opt/apps/powder.env build')
		expect(withProj.log).toContain(
			'compose -p mypowder --env-file /opt/apps/powder.env up -d --force-recreate',
		)
		const def = run(['--baseline'], FILES)
		expect(def.log).not.toContain(' -p ')
		const bad = run(['--baseline'], FILES, { POWDER_COMPOSE_PROJECT: 'a b;x' })
		expect(bad.res.status).not.toBe(0)
	})

	it('takes the DB user/name from powder.env on the server, admin/powder when unset', () => {
		const withEnv = run(['--skip-migrations'], FILES, { STUB_DB_USER: 'pgu', STUB_DB_NAME: 'pgdb' })
		expect(withEnv.res.status).toBe(0)
		expect(withEnv.log).toContain('docker exec powder-postgres psql -U pgu -d pgdb')
		const dflt = run(['--skip-migrations'], FILES)
		expect(dflt.log).toContain('docker exec powder-postgres psql -U admin -d powder')
	})

	it('an explicit POWDER_DB_EXEC/POWDER_DB_PSQL wins over powder.env', () => {
		const { log } = run(['--skip-migrations'], FILES, {
			STUB_DB_USER: 'pgu',
			STUB_DB_NAME: 'pgdb',
			POWDER_DB_EXEC: 'docker exec mydb psql -U x -d y',
			POWDER_DB_PSQL: 'docker exec -i mydb psql -U x -d y',
		})
		expect(log).toContain('docker exec mydb psql -U x -d y')
		expect(log).not.toContain('-U pgu')
	})

	it('preflight fails when POWDER_DASHBOARD_HOST is set but compose renders no traefik.enable=true', () => {
		const bad = run(['--skip-migrations'], FILES, { TRAEFIK_OUT: '0' })
		expect(bad.res.status).toBe(1)
		expect(bad.res.stderr).toContain('renders no traefik.enable=true')
		expect(bad.log).not.toContain('force-recreate')
		// before ANY change to the server: no migrations, no rsync, no build
		expect(bad.log).not.toContain('[rsync]')
		expect(bad.log).not.toContain('powder_deploy_migrations')
		expect(bad.log).not.toContain('docker compose --env-file /opt/apps/powder.env build')
		const good = run(['--skip-migrations'], FILES, { TRAEFIK_OUT: '1' })
		expect(good.res.status).toBe(0)
	})

	it('exits 1 when the public URL check is not 2xx/3xx', () => {
		const env = { POWDER_PUBLIC_URL: 'https://dash.example.com' }
		expect(run(['--skip-migrations'], FILES, env).res.status).toBe(0)
		expect(run(['--skip-migrations'], FILES, { ...env, CURL_CODE: '302' }).res.status).toBe(0)
		const bad = run(['--skip-migrations'], FILES, { ...env, CURL_CODE: '502' })
		expect(bad.res.status).toBe(1)
		expect(bad.res.stderr).toContain('public URL check failed')
	})

	it('retries the public URL up to 6 times and succeeds at the first 2xx/3xx', () => {
		const env = { POWDER_PUBLIC_URL: 'https://dash.example.com' }
		const ok = run(['--skip-migrations'], FILES, { ...env, CURL_SEQ: '502,000,301' })
		expect(ok.res.status).toBe(0)
		expect(ok.log.split('\n').filter((l) => l.includes('dash.example.com')).length).toBe(3)
		const bad = run(['--skip-migrations'], FILES, {
			...env,
			CURL_SEQ: '502,502,502,502,502,502,200',
		})
		expect(bad.res.status).toBe(1)
		expect(bad.log.split('\n').filter((l) => l.includes('dash.example.com')).length).toBe(6)
	})

	it('a weak secret in powder.env stops the deploy before the recreate', () => {
		const bad = run(['--skip-migrations'], FILES, { STUB_CONFIG_BAD: '1' })
		expect(bad.res.status).toBe(1)
		expect(bad.res.stderr).toContain('BETTER_AUTH_SECRET is only 8 characters')
		expect(bad.res.stderr).toContain('refusing to recreate')
		// built, checked in the NEW worker image, never recreated
		expect(bad.log).toContain('build worker')
		expect(bad.log).toContain('run --rm --no-deps -T --entrypoint node worker --import tsx src/check-config.ts')
		expect(bad.log).not.toContain('force-recreate')
		const good = run(['--skip-migrations'], FILES)
		expect(good.res.status).toBe(0)
		expect(good.log.indexOf('check-config')).toBeLessThan(good.log.indexOf('force-recreate'))
	})

	it('a config check that cannot run stops the deploy too (never skipped silently)', () => {
		const r = run(['--skip-migrations'], FILES, { STUB_CONFIG_BROKEN: '1' })
		expect(r.res.status).toBe(1)
		expect(r.res.stderr).toContain('could not run the config check')
		expect(r.log).not.toContain('force-recreate')
	})

	it('--pin-report builds and prints the env target report, then stops', () => {
		const r = run(['--pin-report'], FILES)
		expect(r.res.status).toBe(0)
		expect(r.log).toContain('build worker')
		expect(r.log).toContain('--import tsx src/env-pin-report.ts')
		expect(r.log).not.toContain('force-recreate')
		expect(r.log).not.toContain('powder_deploy_migrations')
		// its own image tags: docker-compose.pin-report.yml on the build and the report run
		expect(r.log).toContain('-f docker-compose.yml -f docker-compose.pin-report.yml build worker')
		expect(r.log).toMatch(/-f docker-compose\.pin-report\.yml run --rm --no-deps -T --entrypoint node worker --import tsx src\/env-pin-report\.ts/)
		// a normal run prints the report before the recreate
		const full = run(['--skip-migrations'], FILES)
		expect(full.log.indexOf('env-pin-report')).toBeGreaterThan(-1)
		expect(full.log.indexOf('env-pin-report')).toBeLessThan(full.log.indexOf('force-recreate'))
		expect(full.log).not.toContain('pin-report.yml')
	})

	it('a failed remote `up` fails the script (pipefail on the remote side)', () => {
		const ok = run(['--skip-migrations'], FILES)
		expect(ok.res.status).toBe(0)
		const bad = run(['--skip-migrations'], FILES, { FAIL_UP: '1' })
		expect(bad.res.status).not.toBe(0)
		expect(bad.log).not.toContain('healthy')
	})

	it('builds powder then worker one after the other under one lock (no parallel Next builds)', () => {
		const { log } = run(['--skip-migrations'], FILES)
		const ssh =
			log.split('\n').find((l) => l.includes('flock -w 2400 /run/powder-build.lock')) ?? ''
		expect(ssh).toContain('build powder 2>&1 | tail -8; ')
		expect(ssh).toContain('build worker 2>&1 | tail -8')
		expect(ssh).not.toContain('build powder worker')
	})

	it('--baseline records the pinned unmarked file and does not run it', () => {
		const { log } = run(['--baseline'], FILES)
		expect(log).toContain("values ('0001_hesitant_orphan.sql') on conflict do nothing")
		expect(log).not.toContain('create table a (id int)')
	})

	it('aborts before shipping on an unrecorded unmarked file without --baseline', () => {
		const { res, log } = run([], FILES)
		expect(res.status).toBe(1)
		expect(res.stderr).toContain('not idempotent')
		expect(log).not.toContain('[rsync]')
	})

	it('runs a post-deploy file only after the recreate', () => {
		const { res, log } = run(['--baseline'], {
			...FILES,
			'0003_drop.sql': '-- idempotent\n-- post-deploy\nselect 33333;\n',
		})
		expect(res.status).toBe(0)
		const iPost = log.indexOf('select 33333')
		expect(iPost).toBeGreaterThan(-1)
		expect(iPost).toBeGreaterThan(log.indexOf('up -d --force-recreate'))
	})

	it('--skip-migrations skips the schema step', () => {
		const { res, log } = run(['--skip-migrations'], FILES)
		expect(res.status).toBe(0)
		expect(res.stderr).toContain('schema step skipped')
		expect(log).not.toContain('powder_deploy_migrations')
		expect(log).toContain('[rsync]')
	})

	it('--skip-migrations also skips the boot-time step of the recreated container', () => {
		const skip = run(['--skip-migrations'], FILES)
		expect(skip.res.status).toBe(0)
		expect(skip.log).toContain('[docker-env] POWDER_SKIP_BOOT_MIGRATIONS=1')
		expect(skip.res.stderr).toContain('skips its boot-time migrations too')
		// A normal run sets it to 0 explicitly, so an earlier skip never sticks.
		const normal = run(['--baseline'], FILES)
		expect(normal.res.status).toBe(0)
		expect(normal.log).toContain('[docker-env] POWDER_SKIP_BOOT_MIGRATIONS=0')
		// compose passes it through to the powder service.
		const compose = readFileSync(resolve(BIN, '../docker-compose.yml'), 'utf8')
		const powder = compose.slice(compose.indexOf('\n  powder:'), compose.indexOf('\n  worker:'))
		expect(powder).toContain('POWDER_SKIP_BOOT_MIGRATIONS: ${POWDER_SKIP_BOOT_MIGRATIONS:-0}')
	})

	it('ships git archive HEAD, not the working tree', () => {
		const { res, log } = run(
			['--baseline'],
			FILES,
			{},
			{ '0003_wt.sql': '-- idempotent\ncreate table if not exists wt_only (id int);\n' },
		)
		expect(res.status).toBe(0)
		expect(log).toContain('[git] archive HEAD')
		// rsync source is the extracted archive dir, never the repo dir "./"
		const rsync = log.split('\n').find((l) => l.startsWith('[rsync]')) ?? ''
		expect(rsync).not.toMatch(/ \.\/ /)
		// a migration that exists only in the working tree is never applied
		expect(log).not.toContain('wt_only')
		expect(log).toContain('create table if not exists b')
	})

	it('refuses a dirty tree without --allow-dirty', () => {
		const { res, log } = run(['--baseline'], FILES, { DIRTY: '1' })
		expect(res.status).toBe(1)
		expect(res.stderr).toContain('working tree is dirty')
		expect(log).not.toContain('[rsync]')
		expect(log).not.toContain('docker compose')
	})

	it('--allow-dirty warns that uncommitted changes are not shipped, then deploys', () => {
		const { res, log } = run(['--allow-dirty', '--baseline'], FILES, { DIRTY: '1' })
		expect(res.status).toBe(0)
		expect(res.stderr).toContain('uncommitted changes are NOT shipped')
		expect(log).toContain('[rsync]')
	})

	it('--skip-tests is accepted; with no installed apps/web the test gate is skipped anyway', () => {
		const { res, log } = run(['--skip-tests', '--skip-migrations'], FILES)
		expect(res.status).toBe(0)
		expect(log).toContain('[rsync]')
	})

	it('POWDER_ENV_FILE is used for every compose call and the env lookups', () => {
		const { res, log } = run(['--skip-migrations'], FILES, { POWDER_ENV_FILE: '/srv/p/powder.env' })
		expect(res.status).toBe(0)
		for (const l of log.split('\n').filter((l) => l.includes('docker compose'))) {
			expect(l).toContain('--env-file /srv/p/powder.env')
			expect(l).toContain('POWDER_ENV_FILE=/srv/p/powder.env')
			expect(l).not.toContain('/opt/apps/powder.env')
		}
		expect(log).toContain('sed -n')
		expect(log).not.toContain('/opt/apps/powder.env')
		expect(run(['--skip-migrations'], FILES, { POWDER_ENV_FILE: '/x; rm' }).res.status).toBe(1)
	})

	it('health-checks POWDER_PORT from the env file (default 3050)', () => {
		expect(run(['--skip-migrations'], FILES).log).toContain('http://127.0.0.1:3050/api/health')
		expect(run(['--skip-migrations'], FILES, { STUB_PORT: '4100' }).log).toContain(
			'http://127.0.0.1:4100/api/health',
		)
	})

	it('silences psql NOTICE lines when applying a marked migration', () => {
		const { log } = run(['--baseline'], FILES)
		expect(log).toContain('SET client_min_messages=warning;')
	})
})

describe('docker-compose.yml has no install-specific values', () => {
	const compose = readFileSync(join(BIN, '../docker-compose.yml'), 'utf8')
	it('has no hardcoded dashboard hostname; the Traefik rule comes from POWDER_DASHBOARD_HOST', () => {
		expect(compose).not.toMatch(/Host\(`[a-z.]*powder\.sh`\)/)
		expect(compose).toContain('POWDER_DASHBOARD_HOST')
		expect(compose).toContain('traefik.enable=${POWDER_DASHBOARD_HOST:+true}')
	})
	it('renders exactly the two-host rule with host + alias, and the worker shares the build args', () => {
		expect(compose).toContain(
			'POWDER_DASHBOARD_HOST_ALIAS:+ || Host(`${POWDER_DASHBOARD_HOST_ALIAS}`)',
		)
		// Optional third host (host split: dashboard + site apex + site www).
		expect(compose).toContain(
			'POWDER_DASHBOARD_HOST_ALIAS2:+ || Host(`${POWDER_DASHBOARD_HOST_ALIAS2}`)',
		)
		const workerBlock = compose.slice(compose.indexOf('target: runner-worker'))
		expect(workerBlock).toContain('NEXT_PUBLIC_POSTHOG_KEY: ${NEXT_PUBLIC_POSTHOG_KEY:-}')
		const dir = mkdtempSync(join(tmpdir(), 'cc-'))
		writeFileSync(join(dir, 'x.env'), '')
		writeFileSync(
			join(dir, 'docker-compose.yml'),
			compose.replaceAll('/opt/apps/powder.env', join(dir, 'x.env')),
		)
		writeFileSync(
			join(dir, 'e.env'),
			'POWDER_DB_USER=u\nPOWDER_DB_PASSWORD=p\nPOWDER_DB_NAME=n\nPOWDER_DASHBOARD_HOST=powder.sh\nPOWDER_DASHBOARD_HOST_ALIAS=www.powder.sh\n',
		)
		const r = spawnSync(
			'docker',
			[
				'compose',
				'--env-file',
				join(dir, 'e.env'),
				'-f',
				join(dir, 'docker-compose.yml'),
				'config',
			],
			{ encoding: 'utf8' },
		)
		if (r.status !== 0) return // docker unavailable here: the string checks above still ran
		expect(r.stdout).toContain(
			'traefik.http.routers.powder.rule: Host(`powder.sh`) || Host(`www.powder.sh`)',
		)
		expect(r.stdout).toContain('traefik.enable: "true"')
	})
	it('mounts the ssh key from SSH_KEY_PATH instead of a fixed /root/.ssh', () => {
		expect(compose).toContain('${SSH_KEY_PATH:-/root/.ssh/id_ed25519}')
		expect(compose).not.toMatch(/^\s+- \/root\/\.ssh\//m)
	})
	it('lib-migrations header says both scripts use the archive', () => {
		const lib = readFileSync(join(BIN, 'lib-migrations.sh'), 'utf8')
		expect(lib).toContain('Every deploy script that sources it (bin/self-deploy.sh) sets it to the')
	})

	describe('DB network layout (private by default, shared-network detected)', () => {
		const LEGACY = { STUB_LAYOUT: 'legacy' }
		const PRIV = { STUB_DB_NETWORK: 'private', STUB_LAYOUT: 'legacy' }
		it('detects the layout on the server with the rule in bin/lib-db-layout.sh, given the env file', () => {
			const { res, log } = run(['--baseline'], FILES)
			expect(res.status).toBe(0)
			expect(log).toContain(`PDB_DIR=/opt/apps; PDB_ENVF=/opt/apps/powder.env; ${DB_LAYOUT_SH}`)
		})
		it('a fresh or private server uses the base compose (powder-postgres), no override, no warning', () => {
			for (const STUB_LAYOUT of ['fresh', 'private']) {
				const { res, log } = run(['--baseline'], FILES, { STUB_LAYOUT })
				expect(res.status).toBe(0)
				expect(res.stderr).toBe('')
				expect(log).not.toContain('-f docker-compose.')
				expect(log).toContain('docker exec -i powder-postgres psql')
			}
		})
		it('an existing shared-network server keeps its layout with a loud warning and is never refused', () => {
			const { res, log } = run(['--baseline'], FILES, LEGACY)
			expect(res.status).toBe(0)
			expect(res.stderr).toContain('WARNING')
			expect(res.stderr).toContain('DB network cutover')
			expect(log).toContain('docker exec -i postgres psql')
			expect(log).toContain('-f docker-compose.yml -f docker-compose.shared-db.yml build powder')
			expect(log).toContain('-f docker-compose.yml -f docker-compose.shared-db.yml up -d --force-recreate powder worker')
		})
		it('reads the last non-empty line, so a login banner before the layout is fine', () => {
			const { res, log } = run(['--baseline'], FILES, { ...LEGACY, STUB_BANNER: 'Welcome to the server' })
			expect(res.status).toBe(0)
			expect(log).toContain('-f docker-compose.yml -f docker-compose.shared-db.yml up -d --force-recreate powder worker')
		})
		it('an ssh error or an unknown answer stops the run before anything changes', () => {
			for (const env of [{ STUB_LAYOUT_SSH_FAIL: '1' }, { STUB_LAYOUT: 'garbage' }, { STUB_LAYOUT: 'legacy extra' }] as Record<string, string>[]) {
				const { res, log } = run(['--baseline', '--force'], FILES, env)
				expect(res.status, JSON.stringify(env)).toBe(1)
				expect(res.stderr).toContain('could not detect the DB layout')
				expect(log).not.toContain('[rsync]')
				expect(log).not.toContain('force-recreate')
				expect(log).not.toContain('[sql]')
			}
		})
		it('POWDER_DB_NETWORK=shared forces the shared-network layout (still warned); a bad value is refused', () => {
			const { res, log } = run(['--baseline'], FILES, { STUB_DB_NETWORK: 'shared' })
			expect(res.status).toBe(0)
			expect(res.stderr).toContain('WARNING')
			expect(log).toContain('-f docker-compose.shared-db.yml build powder')
			expect(run(['--baseline'], FILES, { STUB_DB_NETWORK: 'bogus' }).res.status).toBe(1)
		})
		it('POWDER_DB_NETWORK=private on a server still running `postgres` refuses without the flag', () => {
			const { res, log } = run(['--baseline'], FILES, PRIV)
			expect(res.status).toBe(1)
			expect(res.stderr).toContain('DB network cutover')
			expect(log).not.toContain('[rsync]')
		})
		it('--db-network-cutover needs DATABASE_URL on powder-postgres first', () => {
			const { res } = run(['--baseline', '--db-network-cutover'], FILES, PRIV)
			expect(res.status).toBe(1)
			expect(res.stderr).toContain('DATABASE_URL')
		})
		it('--db-network-cutover recreates postgres (base compose) before powder+worker', () => {
			const { res, log } = run(['--baseline', '--db-network-cutover'], FILES, {
				...PRIV,
				STUB_DBURL_OK: '1',
			})
			expect(res.status).toBe(0)
			const iPg = log.indexOf('up -d --force-recreate --no-deps postgres')
			expect(iPg).toBeGreaterThan(-1)
			expect(log).not.toContain('shared-db.yml')
			expect(log.indexOf('up -d --force-recreate powder worker')).toBeGreaterThan(iPg)
			expect(log).toContain('docker exec powder-postgres pg_isready')
		})
		it('hardening is the default; POWDER_HARDEN=false adds the opt-out override to every compose call', () => {
			for (const STUB_HARDEN of ['', 'true']) {
				const d = run(['--baseline'], FILES, { STUB_HARDEN })
				expect(d.res.status).toBe(0)
				expect(d.log).not.toContain('-f docker-compose.')
			}
			const h = run(['--baseline'], FILES, { STUB_HARDEN: 'false' })
			expect(h.res.status).toBe(0)
			expect(h.log).toContain('-f docker-compose.yml -f docker-compose.unharden.yml build powder')
			expect(h.log).toContain(
				'-f docker-compose.yml -f docker-compose.unharden.yml up -d --force-recreate powder worker',
			)
			const all = run(['--baseline'], FILES, { STUB_HARDEN: 'false', STUB_LAYOUT: 'legacy', STUB_WEB_RO: 'true' })
			expect(all.log).toContain(
				'-f docker-compose.yml -f docker-compose.shared-db.yml -f docker-compose.unharden.yml -f docker-compose.web-readonly.yml build powder',
			)
			expect(run(['--baseline'], FILES, { STUB_HARDEN: '1' }).res.status).toBe(1)
		})
		it('refuses a POWDER_WEB_READONLY value compose cannot cast', () => {
			const { res } = run(['--baseline'], FILES, { STUB_WEB_RO: '1' })
			expect(res.status).toBe(1)
			expect(res.stderr).toContain('POWDER_WEB_READONLY')
		})
	})
})
