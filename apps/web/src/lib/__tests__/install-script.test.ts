import { spawnSync } from 'node:child_process'
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathWithout } from './hermetic'

// Runs bin/install.sh for real under bash with stub docker/curl/id/ssh-keygen
// on PATH, in a temp copy of the checkout, and asserts on the env file it
// writes and the commands it would have run.

const REPO = resolve(__dirname, '../../../../..')

const STUBS: Record<string, string> = {
	docker: `#!/bin/bash
echo "[docker] $*" >> "$CALLS"
case "$*" in
  # powder's DB: whether the deploys table exists, then the in-flight count, one
  # answer per call from STUB_INFLIGHT (space-separated, the last one repeats).
  "exec powder-postgres psql"*to_regclass*) echo "\${STUB_DEPLOYS_TABLE:-t}"; exit 0;;
  "exec powder-postgres psql"*information_schema*) echo "\${STUB_SETTLE_COLS:-0}"; exit 0;;
  "exec powder-postgres psql"*) a=(\${STUB_INFLIGHT:-0}); n=$(cat "$STATE/inflight-n" 2>/dev/null || echo 0)
    echo $((n + 1)) > "$STATE/inflight-n"; [ "$n" -ge \${#a[@]} ] && n=$((\${#a[@]} - 1)); echo "\${a[$n]}"; exit 0;;
  "info") exit "\${DOCKER_INFO_RC:-0}";;
  "compose version --short") echo "\${COMPOSE_VERSION:-2.29.1}"; exit 0;;
  "network inspect web") [ -f "$STATE/net" ] && exit 0; exit 1;;
  "network create web") touch "$STATE/net"; exit 0;;
  # powder's DB exists once compose started postgres (or STUB_PG says it already did).
  "container inspect -f ok powder-postgres") { [ -n "$STUB_PG" ] || [ -f "$STATE/pg" ]; } && { echo ok; exit 0; }; exit 1;;
  "container inspect"*" postgres") [ -n "$STUB_LEGACY" ] && { echo "/opt/apps/powder-pgdata "; exit 0; }; exit 1;;
  "container inspect"*) exit 1;;
  "inspect --type container"*) echo true; exit 0;;
  # Models the real start order: powder serves (schema applied) once it was
  # started; the worker heartbeats exist only once the worker container runs.
  # What compose sees: the shell value of SSH_KEY_PATH and the opt-in in the env file.
  *" up -d"*) echo "[compose-env] SSH_KEY_PATH=\${SSH_KEY_PATH-unset} fresh=$(grep -c '^POWDER_ALLOW_FRESH_SCHEMA=1$' "$POWDER_ENV_FILE")" >> "$CALLS"
    case "$*" in *" postgres"*) touch "$STATE/pg";; esac
    case "$*" in *" powder"*) touch "$STATE/powder";; esac
    case "$*" in *" worker"*) touch "$STATE/worker";; esac
    exit 0;;
  "exec powder node -e"*) [ -f "$STATE/powder" ] && [ -z "$STUB_NO_SERVE" ] || exit 1
    echo '{"status":"degraded","db":true}'; exit 0;;
  logs*) echo "[first-run] setup token: tok_ABC123 (open /setup on this powder)"; exit 0;;
esac
case "$*" in
  *check-config*) echo "[config-check] powder.env passes";;
esac
exit 0
`,
	// /api/health as the real route answers it: nothing until powder serves; with
	// POWDER_DEPLOY_WORKER=true a 503 (curl -f: exit 22, no body) until the worker
	// container has started; without it, ok as soon as powder serves.
	curl: `#!/bin/bash
echo "[curl] $*" >> "$CALLS"
[ -f "$STATE/powder" ] || exit 7
[ -n "$STUB_NO_HEARTBEAT" ] && exit 22
if grep -Eq '^POWDER_DEPLOY_WORKER=(true|1|yes|on)$' "$POWDER_ENV_FILE" && [ ! -f "$STATE/worker" ]; then exit 22; fi
echo '{"status":"ok"}'
`,
	id: `#!/bin/bash
[ "$1" = -u ] && { echo "\${STUB_UID:-0}"; exit 0; }
exec /usr/bin/id "$@"
`,
	sleep: '#!/bin/bash\nexit 0\n',
	// DNS answers for the dashboard host (STUB_DNS, space-separated; empty: not found)
	// and this server's own addresses (STUB_OWN_IP), as getent ahosts and ip -o addr print them.
	getent: `#!/bin/bash
echo "[getent] $*" >> "$CALLS"
[ -n "$STUB_DNS" ] || exit 2
for a in $STUB_DNS; do echo "$a      STREAM $2"; done
`,
	ip: `#!/bin/bash
[ "$*" = "-o addr show" ] || exit 1
echo "1: lo    inet 127.0.0.1/8 scope host lo"
echo "2: eth0    inet \${STUB_OWN_IP:-203.0.113.10}/24 brd 203.0.113.255 scope global eth0"
`,
	flock: '#!/bin/bash\nshift 3\nexec "$@"\n',
	// STUB_MV_FAIL: the rename over the env file fails; STUB_MV_TERM: the script is
	// killed (SIGTERM) while the temp file exists.
	mv: `#!/bin/bash
[ -n "$STUB_MV_FAIL" ] && exit 1
[ -n "$STUB_MV_TERM" ] && { kill -TERM $PPID; exit 1; }
exec /bin/mv "$@"
`,
	'ssh-keygen': `#!/bin/bash
echo "[ssh-keygen] $*" >> "$CALLS"
f=""; while [ $# -gt 0 ]; do [ "$1" = -f ] && f=$2; shift; done
[ -n "$f" ] && { echo key > "$f"; echo pub > "$f.pub"; }
exit 0
`,
}

const SECRET = 'gh_secret_0123456789abcdef0123456789'

function setup() {
	const root = mkdtempSync(join(tmpdir(), 'install-'))
	const src = join(root, 'src')
	const stubs = join(root, 'stubs')
	const state = join(root, 'state')
	for (const d of [
		src,
		stubs,
		state,
		join(src, 'bin'),
		join(src, 'docker'),
		join(root, 'apps'),
		join(root, 'ssh'),
	])
		mkdirSync(d, { recursive: true })
	cpSync(join(REPO, 'bin/install.sh'), join(src, 'bin/install.sh'))
	cpSync(join(REPO, 'bin/lib-db-layout.sh'), join(src, 'bin/lib-db-layout.sh'))
	cpSync(join(REPO, 'docker-compose.yml'), join(src, 'docker-compose.yml'))
	cpSync(join(REPO, 'docker/powder.env.example'), join(src, 'docker/powder.env.example'))
	// The bootstrap stub "installs Docker" (copies the docker stub onto PATH) when
	// STUB_BOOT_DOCKER is set, as the real --apply does when docker is absent.
	writeFileSync(
		join(src, 'bin/server-bootstrap.sh'),
		'#!/bin/bash\necho "[bootstrap] $*" >> "$CALLS"\n[ -n "$STUB_BOOT_DOCKER" ] && cp "$STUB_BOOT_DOCKER" "$NODOCKER_BIN/docker"\nexit 0\n',
	)
	for (const [n, body] of Object.entries(STUBS)) {
		writeFileSync(join(stubs, n), body)
		chmodSync(join(stubs, n), 0o755)
	}
	const envFile = join(root, 'apps/powder.env')
	const calls = join(root, 'calls.log')
	writeFileSync(join(root, 'secret'), `${SECRET}\n`)
	const meminfo = (memKb: number, swapKb: number) => {
		const f = join(root, `meminfo-${memKb}-${swapKb}`)
		writeFileSync(f, `MemTotal:       ${memKb} kB\nMemFree:        1000 kB\nSwapTotal:      ${swapKb} kB\n`)
		return f
	}
	// A PATH without docker: the stubs minus docker, then the system dirs.
	const nodocker = join(root, 'nodocker')
	mkdirSync(nodocker)
	for (const n of Object.keys(STUBS).filter((n) => n !== 'docker')) cpSync(join(stubs, n), join(nodocker, n))
	const run = (args: string[], env: Record<string, string> = {}) => {
		const r = spawnSync('bash', [join(src, 'bin/install.sh'), ...args], {
			env: {
				...process.env,
				PATH: `${stubs}:${process.env.PATH}`,
				NODOCKER_BIN: nodocker,
				CALLS: calls,
				STATE: state,
				POWDER_ENV_FILE: envFile,
				POWDER_DATA_DIR: join(root, 'apps'),
				POWDER_BUILD_CACHE_ID_FILE: join(root, 'apps/.powder-build-cache-id'),
				SSH_KEY_PATH: join(root, 'ssh/id_ed25519'),
				GITHUB_CLIENT_SECRET: '',
				GITHUB_CLIENT_ID: '',
				POWDER_DASHBOARD_HOST: '',
				STUB_DNS: '203.0.113.10',
				POWDER_MEMINFO_FILE: meminfo(4_000_000, 0),
				...env,
			},
			input: '',
			encoding: 'utf8',
		})
		return { ...r, out: `${r.stdout}${r.stderr}` }
	}
	const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '')
	const envText = () => readFileSync(envFile, 'utf8')
	const full = [
		'--host',
		'deploy.example.com',
		'--github-client-id',
		'Ov23liAbCdEf012345',
		'--github-client-secret-file',
		join(root, 'secret'),
	]
	const sysNoDocker = pathWithout(['docker'])
	const runNoDocker = (args: string[], env: Record<string, string> = {}) =>
		run(args, { PATH: `${nodocker}:${sysNoDocker}`, ...env })
	return { root, src, stubs, run, runNoDocker, log, envText, envFile, full, meminfo }
}

const get = (text: string, key: string) =>
	text
		.split('\n')
		.filter((l) => l.startsWith(`${key}=`))
		.map((l) => l.slice(key.length + 1))

describe('bin/install.sh', () => {
	it('fresh server: env file 0600 with new secrets, then network, proxy, build, start, health', () => {
		const t = setup()
		const r = t.run(t.full)
		expect(r.status, r.out).toBe(0)
		const env = t.envText()
		expect(statSync(t.envFile).mode & 0o777).toBe(0o600)
		expect(
			env
				.split('\n')
				.filter((l) => !l.startsWith('#'))
				.join('\n'),
		).not.toContain('CHANGE_ME')
		const [pw] = get(env, 'POWDER_DB_PASSWORD')
		expect(pw).toMatch(/^[0-9a-f]{48}$/)
		expect(get(env, 'DATABASE_URL')).toEqual([`postgres://admin:${pw}@powder-postgres:5432/powder`])
		expect(get(env, 'BETTER_AUTH_SECRET')[0]).toMatch(/^[0-9a-f]{64}$/)
		expect(get(env, 'POWDER_ENCRYPTION_KEY')[0]).toMatch(/^[0-9a-f]{64}$/)
		expect(get(env, 'BETTER_AUTH_SECRET')[0]).not.toBe(get(env, 'POWDER_ENCRYPTION_KEY')[0])
		expect(get(env, 'BETTER_AUTH_URL')).toEqual(['https://deploy.example.com'])
		expect(get(env, 'GITHUB_CLIENT_ID')).toEqual(['Ov23liAbCdEf012345'])
		expect(get(env, 'GITHUB_CLIENT_SECRET')).toEqual([SECRET])
		expect(get(env, 'POWDER_DASHBOARD_HOST')).toEqual(['deploy.example.com'])
		expect(get(env, 'SSH_KEY_PATH')).toEqual([join(t.root, 'ssh/id_ed25519')])
		expect(get(env, 'POWDER_DATA_DIR')).toEqual([join(t.root, 'apps')])
		// secrets never reach the terminal
		expect(r.out).not.toContain(SECRET)
		expect(r.out).not.toContain(pw)
		const log = t.log()
		const order = [
			'[ssh-keygen]',
			'[docker] network create web',
			'[bootstrap] --apply --proxy traefik --yes',
			'build powder',
			'build worker',
			'check-config',
			`--env-file ${t.envFile} up -d postgres powder`,
			'[docker] exec powder node -e',
			`--env-file ${t.envFile} up -d worker`,
			'[curl] -fsS --max-time 5 http://127.0.0.1:3050/api/health',
		].map((m) => log.indexOf(m))
		expect(
			order.every((i) => i >= 0),
			log,
		).toBe(true)
		expect([...order].sort((a, b) => a - b)).toEqual(order)
		expect(r.stdout).toMatch(/^ {2}2\. Setup token: tok_ABC123$/m)
		expect(r.stdout).not.toContain('[first-run] setup token')
		expect(r.stdout).toContain('https://deploy.example.com/setup')
		expect(r.stdout).toContain('https://deploy.example.com/api/auth/callback/github')
		expect(r.stdout).toContain('bin/install.sh --set-admin <id>')
	})

	it('worker mode (the example env): the worker starts before the ok wait, which then passes', () => {
		const t = setup()
		const r = t.run(t.full)
		expect(r.status, r.out).toBe(0)
		expect(get(t.envText(), 'POWDER_DEPLOY_WORKER')).toEqual(['true'])
		const log = t.log()
		// no ok probe before the worker is up: that probe could only ever see 503
		expect(log.indexOf('[curl]')).toBeGreaterThan(log.indexOf(`--env-file ${t.envFile} up -d worker`))
		expect(r.out).toContain('  ready')
		expect(r.out).toContain('  healthy')
	})

	it('worker mode off: same order, health is ok as soon as powder serves', () => {
		const t = setup()
		expect(t.run(t.full).status).toBe(0)
		writeFileSync(t.envFile, t.envText().replace(/^POWDER_DEPLOY_WORKER=.*$/m, 'POWDER_DEPLOY_WORKER=false'))
		// containers gone (as after `docker compose down`): nothing serves until started
		for (const f of ['powder', 'worker']) rmSync(join(t.root, 'state', f))
		const r = t.run([])
		expect(r.status, r.out).toBe(0)
		expect(get(t.envText(), 'POWDER_DEPLOY_WORKER')).toEqual(['false'])
		expect(r.out).toContain('  healthy')
		expect(t.log()).toContain(`--env-file ${t.envFile} up -d worker`)
	})

	it('names the stage that timed out and the log to read', () => {
		const t = setup()
		// powder never serves: stage 1, the worker is never started
		let r = t.run(t.full, { STUB_NO_SERVE: '1' })
		expect(r.status).toBe(1)
		expect(r.out).toContain('stage 1/2: powder did not serve')
		expect(r.out).toContain('docker logs powder')
		expect(t.log()).not.toContain('up -d worker')
		// powder serves but the heartbeats never arrive: stage 2, worker log named
		r = t.run([], { STUB_NO_HEARTBEAT: '1' })
		expect(r.status).toBe(1)
		expect(r.out).toContain('stage 2/2:')
		expect(r.out).toContain('docker logs powder-worker')
	})

	it('a re-run never changes the env file and does not recreate the network', () => {
		const t = setup()
		expect(t.run(t.full).status).toBe(0)
		const before = t.envText()
		const r = t.run(['--host', 'other.example.com'])
		expect(r.status, r.out).toBe(0)
		expect(t.envText()).toBe(before)
		expect(t.log().match(/network create web/g)?.length).toBe(1)
		expect(r.out).toContain('BETTER_AUTH_URL in')
	})

	it('fills only empty keys of an existing env file', () => {
		const t = setup()
		writeFileSync(
			t.envFile,
			`POWDER_DB_USER=admin\nPOWDER_DB_PASSWORD=keepme\nDATABASE_URL=postgres://admin:keepme@powder-postgres:5432/powder\nBETTER_AUTH_SECRET=existing\nGITHUB_CLIENT_ID=\nPOWDER_DATA_DIR=${join(t.root, 'apps')}\n`,
			{ mode: 0o644 },
		)
		const r = t.run(t.full, { STUB_PG: '1' })
		expect(r.status, r.out).toBe(0)
		const env = t.envText()
		expect(get(env, 'POWDER_DB_PASSWORD')).toEqual(['keepme'])
		expect(get(env, 'BETTER_AUTH_SECRET')).toEqual(['existing'])
		expect(get(env, 'GITHUB_CLIENT_ID')).toEqual(['Ov23liAbCdEf012345'])
		expect(get(env, 'POWDER_ENCRYPTION_KEY')[0]).toMatch(/^[0-9a-f]{64}$/)
		expect(statSync(t.envFile).mode & 0o777).toBe(0o600)
	})

	it('refuses bad values before writing anything', () => {
		for (const args of [
			['--host', 'deploy.example.com;rm -rf /'],
			['--host', 'localhost'],
			['--host', 'deploy.example.com', '--github-client-id', 'id with space'],
		]) {
			const t = setup()
			const r = t.run([...args, '--github-client-secret-file', join(t.root, 'secret')])
			expect(r.status).toBe(1)
			expect(existsSync(t.envFile)).toBe(false)
			expect(t.log()).not.toContain('build')
		}
		const t = setup()
		const r = t.run(['--github-client-secret', SECRET])
		expect(r.status).toBe(1)
		expect(r.out).toContain('not on the command line')
		expect(r.out).not.toContain(SECRET)
	})

	it('without a terminal a missing value is an error naming the callback URL', () => {
		const t = setup()
		const r = t.run(['--host', 'deploy.example.com', '--github-client-id', 'Ov23liAbCdEf012345'])
		expect(r.status).toBe(1)
		expect(r.out).toContain('https://deploy.example.com/api/auth/callback/github')
		expect(r.out).toContain('is required')
		expect(existsSync(t.envFile)).toBe(false)
	})

	it('checks prerequisites: compose older than 2.24 and a non-root run stop it', () => {
		const t = setup()
		const old = t.run(t.full, { COMPOSE_VERSION: '2.20.3' })
		expect(old.status).toBe(1)
		expect(old.out).toContain('docker compose 2.24 or newer (found 2.20.3)')
		const nonroot = t.run(t.full, { STUB_UID: '1000' })
		expect(nonroot.status).toBe(1)
		expect(nonroot.out).toContain('run as root')
		expect(existsSync(t.envFile)).toBe(false)
	})

	it('refuses a server on the shared-network DB layout, and a DB without its env file', () => {
		const t = setup()
		const legacy = t.run(t.full, { STUB_LEGACY: '1' })
		expect(legacy.status).toBe(1)
		expect(legacy.out).toContain('bin/self-deploy.sh')
		const orphan = t.run(t.full, { STUB_PG: '1' })
		expect(orphan.status).toBe(1)
		expect(orphan.out).toContain('restore your env file')
		expect(existsSync(t.envFile)).toBe(false)
	})

	it('a DB layout answer that is not a known word stops before anything changes', () => {
		for (const answer of ['', 'weird']) {
			const t = setup()
			writeFileSync(join(t.src, 'bin/lib-db-layout.sh'), `POWDER_DB_LAYOUT_SH='echo ${answer}'\n`)
			const r = t.run(t.full)
			expect(r.status, answer).toBe(1)
			expect(r.out).toContain(`could not detect the DB layout of powder (got: ${answer || 'nothing'})`)
			expect(t.log()).not.toMatch(/compose .*(?:build|up)/)
			expect(existsSync(t.envFile)).toBe(false)
		}
	})

	it('with no DB container, the DATABASE_URL host decides the layout', () => {
		const t = setup()
		expect(t.run(t.full).status).toBe(0)
		// `docker compose down`: no container left, the data dir stays.
		rmSync(join(t.root, 'state/pg'))
		mkdirSync(join(t.root, 'apps/powder-pgdata'))
		const priv = t.run([])
		expect(priv.status, priv.out).toBe(0)
		expect(t.log()).not.toContain('-f docker-compose.shared-db.yml')
		rmSync(join(t.root, 'state/pg'))
		writeFileSync(t.envFile, t.envText().replace('@powder-postgres:5432', '@postgres:5432'))
		const shared = t.run([])
		expect(shared.status).toBe(1)
		expect(shared.out).toContain('shared-network layout')
	})

	it('--dry-run changes nothing and runs no mutating docker command', () => {
		const t = setup()
		const r = t.run([...t.full, '--dry-run'], { STUB_UID: '1000' })
		expect(r.status, r.out).toBe(0)
		expect(existsSync(t.envFile)).toBe(false)
		expect(existsSync(join(t.root, 'ssh/id_ed25519'))).toBe(false)
		const log = t.log()
		expect(log).not.toMatch(/network create|build|up -d|\[bootstrap\]|\[ssh-keygen\]/)
		expect(r.stdout).toContain('would run:')
		expect(r.stdout).toContain('dry run: nothing was changed')
		expect(r.out).not.toContain(SECRET)
	})

	it('--no-proxy skips Traefik and leaves POWDER_DASHBOARD_HOST unset', () => {
		const t = setup()
		const r = t.run([...t.full, '--no-proxy'])
		expect(r.status, r.out).toBe(0)
		expect(t.log()).not.toContain('[bootstrap]')
		expect(get(t.envText(), 'POWDER_DASHBOARD_HOST')).toEqual([])
		expect(r.stdout).toContain('127.0.0.1:3050')
	})

	describe('--set-admin', () => {
		it('writes the id once and recreates powder and worker', () => {
			const t = setup()
			expect(t.run(t.full).status).toBe(0)
			const r = t.run(['--set-admin', 'AbC123_x-9'])
			expect(r.status, r.out).toBe(0)
			expect(get(t.envText(), 'POWDER_ADMIN_USER_IDS')).toEqual(['AbC123_x-9'])
			expect(statSync(t.envFile).mode & 0o777).toBe(0o600)
			expect(t.log()).toContain(`--env-file ${t.envFile} up -d --force-recreate powder worker`)
			const again = t.run(['--set-admin', 'AbC123_x-9'])
			expect(again.status).toBe(0)
			expect(again.stdout).toContain('already contains')
			expect(get(t.envText(), 'POWDER_ADMIN_USER_IDS')).toEqual(['AbC123_x-9'])
			t.run(['--set-admin', 'second'])
			expect(get(t.envText(), 'POWDER_ADMIN_USER_IDS')).toEqual(['AbC123_x-9,second'])
		})
		it('takes no flag for the id: --set-admin --dry-run is a usage error and writes nothing', () => {
			const t = setup()
			expect(t.run(t.full).status).toBe(0)
			const before = t.envText()
			const calls = t.log()
			for (const args of [['--set-admin', '--dry-run'], ['--set-admin=--dry-run'], ['--set-admin', '-x']]) {
				const r = t.run(args)
				expect(r.status, r.out).toBe(1)
			}
			expect(t.run(['--set-admin', '--dry-run']).out).toContain('--set-admin needs a value')
			expect(t.run(['--set-admin=-abc']).out).toContain('starting with a letter or digit')
			expect(t.envText()).toBe(before)
			expect(t.log()).toBe(calls)
		})
		it('accepts the id shape better-auth generates (32 letters and digits)', () => {
			const t = setup()
			expect(t.run(t.full).status).toBe(0)
			const id = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE'
			expect(t.run(['--set-admin', id]).status).toBe(0)
			expect(get(t.envText(), 'POWDER_ADMIN_USER_IDS')).toEqual([id])
		})
		it('refuses a malformed id and a missing env file', () => {
			const t = setup()
			expect(t.run(['--set-admin', 'x']).out).toContain('install powder first')
			expect(t.run(t.full).status).toBe(0)
			const before = t.envText()
			for (const bad of ['a,b', 'a b', '$(id)', 'x\nPOWDER_HARDEN=false']) {
				const r = t.run(['--set-admin', bad])
				expect(r.status).toBe(1)
			}
			expect(t.envText()).toBe(before)
		})
		it('uses the same compose overrides as bin/self-deploy.sh', () => {
			const t = setup()
			expect(t.run(t.full).status).toBe(0)
			writeFileSync(t.envFile, `${t.envText()}POWDER_HARDEN=false\n`)
			const r = t.run(['--set-admin', 'abc'])
			expect(r.status, r.out).toBe(0)
			expect(t.log()).toContain(
				'-f docker-compose.yml -f docker-compose.unharden.yml up -d --force-recreate powder worker',
			)
		})
		it('--dry-run prints the change without writing it', () => {
			const t = setup()
			expect(t.run(t.full).status).toBe(0)
			const before = t.envText()
			const r = t.run(['--set-admin', 'abc', '--dry-run'])
			expect(r.status).toBe(0)
			expect(r.stdout).toContain('would set POWDER_ADMIN_USER_IDS=abc')
			expect(t.envText()).toBe(before)
		})
	})

	it('a re-run never infers POWDER_DASHBOARD_HOST from BETTER_AUTH_URL; an explicit --host fills it', () => {
		const t = setup()
		expect(t.run(t.full).status).toBe(0)
		writeFileSync(t.envFile, t.envText().replace(/^POWDER_DASHBOARD_HOST=.*\n/m, ''))
		const r = t.run([])
		expect(r.status, r.out).toBe(0)
		expect(get(t.envText(), 'POWDER_DASHBOARD_HOST')).toEqual([])
		expect(t.run(['--host', 'deploy.example.com']).status).toBe(0)
		expect(get(t.envText(), 'POWDER_DASHBOARD_HOST')).toEqual(['deploy.example.com'])
	})

	describe('--no-proxy is remembered', () => {
		it('stores POWDER_PROXY=none; a re-run without the flag runs no Traefik and sets no dashboard host', () => {
			const t = setup()
			expect(t.run([...t.full, '--no-proxy']).status).toBe(0)
			expect(get(t.envText(), 'POWDER_PROXY')).toEqual(['none'])
			const before = t.log().length
			const r = t.run(['--host', 'deploy.example.com'])
			expect(r.status, r.out).toBe(0)
			expect(t.log().slice(before)).not.toContain('[bootstrap]')
			expect(t.log().slice(before)).not.toContain('[getent]')
			expect(get(t.envText(), 'POWDER_DASHBOARD_HOST')).toEqual([])
			expect(r.stdout).toContain('POWDER_PROXY=none')
		})
		it('--proxy wins for that run, with a notice, and the file keeps none', () => {
			const t = setup()
			expect(t.run([...t.full, '--no-proxy']).status).toBe(0)
			const before = t.log().length
			const r = t.run(['--proxy', '--host', 'deploy.example.com'])
			expect(r.status, r.out).toBe(0)
			expect(r.stderr).toContain('--proxy sets up Traefik for this run only')
			expect(t.log().slice(before)).toContain('[bootstrap] --apply --proxy traefik --yes')
			expect(get(t.envText(), 'POWDER_PROXY')).toEqual(['none'])
		})
		it('refuses an unknown POWDER_PROXY value', () => {
			const t = setup()
			expect(t.run(t.full).status).toBe(0)
			writeFileSync(t.envFile, `${t.envText()}POWDER_PROXY=caddy\n`)
			const r = t.run([])
			expect(r.status).toBe(1)
			expect(r.out).toContain("POWDER_PROXY in")
		})
	})

	describe('BETTER_AUTH_URL with a port or http on a re-run', () => {
		for (const url of ['http://p.example.com:8443', 'https://p.example.com:8443/', 'HTTP://P.example.com']) {
			it(`reads ${url} as scheme, host and port`, () => {
				const t = setup()
				expect(t.run([...t.full, '--no-proxy']).status).toBe(0)
				writeFileSync(t.envFile, t.envText().replace(/^BETTER_AUTH_URL=.*$/m, `BETTER_AUTH_URL=${url}`))
				const before = t.envText()
				for (const extra of [['--dry-run'], []]) {
					const r = t.run(extra)
					expect(r.status, r.out).toBe(0)
					const origin = url.toLowerCase().replace(/\/$/, '')
					expect(r.stdout).toContain(`${origin}/setup`)
				}
				expect(t.envText()).toBe(before)
			})
		}
		it('refuses a value that is not an http(s) URL with a host', () => {
			for (const url of ['p.example.com:8443', 'ftp://p.example.com', 'https://bad_host!']) {
				const t = setup()
				expect(t.run([...t.full, '--no-proxy']).status).toBe(0)
				writeFileSync(t.envFile, t.envText().replace(/^BETTER_AUTH_URL=.*$/m, `BETTER_AUTH_URL=${url}`))
				const r = t.run([])
				expect(r.status, url).toBe(1)
				expect(r.out).toContain('BETTER_AUTH_URL in')
			}
		})
		it('a host given on the command line stays strict', () => {
			const t = setup()
			for (const h of ['p.example.com:8443', 'http://p.example.com']) {
				const r = t.run(['--host', h, '--github-client-secret-file', join(t.root, 'secret')])
				expect(r.status).toBe(1)
				expect(r.out).toContain('not a hostname')
			}
			expect(existsSync(t.envFile)).toBe(false)
		})
	})

	describe('deploys in flight (existing database)', () => {
		const existing = () => {
			const t = setup()
			expect(t.run(t.full).status).toBe(0)
			return t
		}
		it('refuses before building while deploys run, and --force goes ahead', () => {
			const t = existing()
			const before = t.log().length
			const r = t.run([], { STUB_PG: '1', STUB_INFLIGHT: '2' })
			expect(r.status).toBe(1)
			expect(r.out).toContain('2 deploy(s) in flight')
			expect(r.out).toContain('--force')
			const after = t.log().slice(before)
			expect(after).toContain('exec powder-postgres psql -U admin -d powder')
			expect(after).not.toMatch(/ build | up -d/)
			const f = t.run(['--force'], { STUB_PG: '1', STUB_INFLIGHT: '2' })
			expect(f.status, f.out).toBe(0)
		})
		it('refuses when the count cannot be read from a running database', () => {
			const t = existing()
			const r = t.run([], { STUB_PG: '1', STUB_INFLIGHT: 'x' })
			expect(r.status).toBe(1)
			expect(r.out).toContain('could not be read')
		})
		it('waits for deploys that start during the build, then recreates', () => {
			const t = existing()
			const before = t.log().length
			// quiet at the start, two busy answers before the powder recreate
			const r = t.run([], { STUB_PG: '1', STUB_INFLIGHT: '0 1 1 0' })
			expect(r.status, r.out).toBe(0)
			expect(r.stdout).toContain('1 deploy(s) in flight: waiting before the recreate (1/90, 30s)')
			const after = t.log().slice(before)
			// the refusal check, two busy answers and the quiet one, all before the powder recreate
			const upTo = after.slice(0, after.indexOf('up -d postgres powder'))
			expect(upTo.match(/select count\(\*\) from deploys/g)?.length).toBe(4)
		})
		it('gives up after 45 minutes without touching the containers', () => {
			const t = existing()
			const before = t.log().length
			const r = t.run([], { STUB_PG: '1', STUB_INFLIGHT: '0 1' })
			expect(r.status).toBe(1)
			expect(r.out).toContain('after 45 minutes')
			expect(t.log().slice(before)).not.toContain('up -d')
		})
		it('a database without the deploys table counts as quiet; a fresh server is not asked', () => {
			const t = existing()
			expect(t.run([], { STUB_PG: '1', STUB_DEPLOYS_TABLE: 'f', STUB_INFLIGHT: '5' }).status).toBe(0)
			const f = setup()
			expect(f.run(f.full, { STUB_INFLIGHT: '5' }).status).toBe(0)
			expect(f.log()).not.toContain('exec powder-postgres')
		})
		it('--set-admin refuses too, before writing the id', () => {
			const t = existing()
			const envBefore = t.envText()
			const r = t.run(['--set-admin', 'abc'], { STUB_PG: '1', STUB_INFLIGHT: '1' })
			expect(r.status).toBe(1)
			expect(r.out).toContain('1 deploy(s) in flight')
			expect(t.envText()).toBe(envBefore)
		})
	})

	describe('fresh schema opt-in', () => {
		it('a new server: compose starts powder with POWDER_ALLOW_FRESH_SCHEMA=1, the file drops it once powder serves', () => {
			const t = setup()
			const r = t.run(t.full)
			expect(r.status, r.out).toBe(0)
			expect(t.log()).toMatch(/\[docker\] .* up -d postgres powder\n\[compose-env\] .*fresh=1/)
			expect(get(t.envText(), 'POWDER_ALLOW_FRESH_SCHEMA')).toEqual([])
			expect(r.stdout).toContain('POWDER_ALLOW_FRESH_SCHEMA removed')
		})
		it('a server with a database never gets it', () => {
			const t = setup()
			expect(t.run(t.full).status).toBe(0)
			const before = t.log().length
			expect(t.run([], { STUB_PG: '1' }).status).toBe(0)
			expect(t.log().slice(before)).not.toContain('fresh=1')
			expect(t.log().slice(before)).toContain('fresh=0')
		})
		// An install whose database is gone: the data dir moved, or POWDER_DATA_DIR
		// or the database settings changed.
		const lostDatabase = () => {
			const t = setup()
			expect(t.run(t.full).status).toBe(0)
			rmSync(join(t.root, 'state/pg'))
			return t
		}
		it('an existing env file with no database is refused, the env file untouched, nothing started', () => {
			const t = lostDatabase()
			const envBefore = t.envText()
			const before = t.log().length
			const r = t.run([])
			expect(r.status).toBe(1)
			expect(r.out).toContain('exists but powder\'s database does not')
			expect(r.out).toContain('data dir was moved')
			expect(r.out).toContain('--fresh-database')
			expect(t.envText()).toBe(envBefore)
			expect(t.log().slice(before)).not.toContain(' up -d')
		})
		it('--fresh-database: the opt-in is written for that run and dropped once powder serves', () => {
			const t = lostDatabase()
			const before = t.log().length
			const r = t.run(['--fresh-database'])
			expect(r.status, r.out).toBe(0)
			expect(t.log().slice(before)).toMatch(/up -d postgres powder\n\[compose-env\] .*fresh=1/)
			expect(get(t.envText(), 'POWDER_ALLOW_FRESH_SCHEMA')).toEqual([])
		})
		it('an unfinished earlier run (the opt-in still in the file) goes on without the flag', () => {
			const t = lostDatabase()
			writeFileSync(t.envFile, `${t.envText()}POWDER_ALLOW_FRESH_SCHEMA=1\n`)
			const before = t.log().length
			const r = t.run([])
			expect(r.status, r.out).toBe(0)
			expect(t.log().slice(before)).toContain('fresh=1')
		})
	})

	describe('POWDER_ENV_FILE', () => {
		it('a path other than the default is written into the file', () => {
			const t = setup()
			expect(t.run(t.full).status).toBe(0)
			expect(get(t.envText(), 'POWDER_ENV_FILE')).toEqual([t.envFile])
		})
		it('refuses a stored path that differs from the file in use', () => {
			const t = setup()
			expect(t.run(t.full).status).toBe(0)
			writeFileSync(t.envFile, t.envText().replace(/^POWDER_ENV_FILE=.*$/m, 'POWDER_ENV_FILE=/srv/other.env'))
			const r = t.run([])
			expect(r.status).toBe(1)
			expect(r.out).toContain('says POWDER_ENV_FILE=/srv/other.env')
		})
		it('refuses a path an app could own; the default and /opt/apps/powder/ pass', () => {
			for (const [p, app] of [
				['/opt/apps/shop.env', 'shop'],
				['/opt/apps//shop.env', 'shop'],
				['/opt/apps/powder-x.env', 'powder-x'],
				['/opt/apps/shop/powder.env', 'shop'],
			]) {
				const t = setup()
				const r = t.run([...t.full, '--dry-run'], { POWDER_ENV_FILE: p, STUB_UID: '1000' })
				expect(r.status, p).toBe(1)
				expect(r.out).toContain(`an app named '${app}' would own`)
			}
			for (const p of ['/opt/apps/powder.env', '/opt/apps/powder/powder.env', '/srv/powder/powder.env']) {
				const t = setup()
				const r = t.run([...t.full, '--dry-run'], { POWDER_ENV_FILE: p, STUB_UID: '1000' })
				expect(r.out).not.toContain('would own')
			}
		})
	})

	describe('env file safety', () => {
		it('refuses a symlinked env file and leaves the link alone', () => {
			const t = setup()
			expect(t.run(t.full).status).toBe(0)
			const real = join(t.root, 'real.env')
			writeFileSync(real, t.envText(), { mode: 0o600 })
			rmSync(t.envFile)
			symlinkSync(real, t.envFile)
			const r = t.run([])
			expect(r.status).toBe(1)
			expect(r.out).toContain('is a symlink')
			expect(lstatSync(t.envFile).isSymbolicLink()).toBe(true)
		})
		const leftovers = (t: ReturnType<typeof setup>) =>
			readdirSync(join(t.root, 'apps')).filter((f) => f.startsWith('.powder.env.'))
		it('removes the secret-holding temp file when the write fails', () => {
			const t = setup()
			const r = t.run(t.full, { STUB_MV_FAIL: '1' })
			expect(r.status).toBe(1)
			expect(leftovers(t)).toEqual([])
		})
		it('removes it when the script is killed', () => {
			const t = setup()
			const r = t.run(t.full, { STUB_MV_TERM: '1' })
			expect(r.status).toBe(143)
			expect(leftovers(t)).toEqual([])
		})
	})

	it('compose reads its values from the env file, not the shell, and says so', () => {
		const t = setup()
		expect(t.run(t.full).status).toBe(0)
		const before = t.log().length
		const r = t.run([], { SSH_KEY_PATH: join(t.root, 'ssh/other_key') })
		expect(r.status, r.out).toBe(0)
		expect(r.stderr).toContain('note: SSH_KEY_PATH is set in the shell to another value than in')
		const after = t.log().slice(before)
		expect(after).toContain('[compose-env] SSH_KEY_PATH=unset')
		expect(after).not.toContain('other_key')
	})

	it('POWDER_DATA_DIR is stored on create; a re-run with another value is refused', () => {
		const t = setup()
		expect(t.run(t.full).status).toBe(0)
		const before = t.envText()
		const other = t.run([], { POWDER_DATA_DIR: '/srv/elsewhere' })
		expect(other.status).toBe(1)
		expect(other.out).toContain('POWDER_DATA_DIR=/srv/elsewhere differs from')
		expect(t.log()).not.toContain('/srv/elsewhere')
		expect(t.envText()).toBe(before)
		expect(t.run([]).status).toBe(0)
		// An older env file without the key means /opt/apps: another env value is refused too.
		writeFileSync(t.envFile, before.replace(/^POWDER_DATA_DIR=.*\n/m, ''))
		expect(t.run([]).out).toContain('unset, so /opt/apps')
		expect(t.run(['--set-admin', 'abc']).status).toBe(1)
	})

	it('docker missing without a terminal: stops with the two commands, unless --yes', () => {
		const t = setup()
		const r = t.runNoDocker(t.full)
		expect(r.status).toBe(1)
		expect(r.out).toContain('sudo bin/server-bootstrap.sh --apply --proxy traefik')
		expect(r.out).toContain('re-run this with --yes')
		expect(t.log()).not.toContain('[bootstrap]')
		expect(existsSync(t.envFile)).toBe(false)
		const y = t.runNoDocker([...t.full, '--yes'], { STUB_BOOT_DOCKER: join(t.stubs, 'docker') })
		expect(y.status, y.out).toBe(0)
		expect(t.log()).toMatch(/\[bootstrap\] --apply --proxy traefik --yes\n[\s\S]*\[docker\] info/)
		// --yes alone installs from Docker's apt repository, never the convenience script
		expect(t.log()).not.toContain('--docker-script')
		expect(y.out).toContain("Docker 29.x from Docker's apt repository")
		expect(existsSync(t.envFile)).toBe(true)
	})

	it('docker missing with --docker-script --yes: only then the bootstrap gets --docker-script', () => {
		const t = setup()
		const r = t.runNoDocker(t.full.concat(['--docker-script']))
		expect(r.status).toBe(1)
		expect(r.out).toContain('sudo bin/server-bootstrap.sh --apply --proxy traefik --docker-script')
		expect(r.out).toContain('get.docker.com script')
		const y = t.runNoDocker([...t.full, '--docker-script', '--yes'], { STUB_BOOT_DOCKER: join(t.stubs, 'docker') })
		expect(y.status, y.out).toBe(0)
		expect(t.log()).toContain('[bootstrap] --apply --proxy traefik --docker-script --yes')
	})

	it('docker missing with --no-proxy --yes: the bootstrap runs in nginx mode (never Traefik)', () => {
		const t = setup()
		const r = t.runNoDocker([...t.full, '--no-proxy', '--yes'], { STUB_BOOT_DOCKER: join(t.stubs, 'docker') })
		expect(r.status, r.out).toBe(0)
		expect(t.log()).toContain('[bootstrap] --apply --proxy nginx --yes')
		expect(t.log()).not.toContain('--proxy traefik')
	})

	it('a custom key path in an existing shared dir does not chmod that dir; a new dir is 0700', () => {
		const t = setup()
		const shared = join(t.root, 'apps')
		chmodSync(shared, 0o755)
		const r = t.run(t.full, { SSH_KEY_PATH: join(shared, 'powder_key') })
		expect(r.status, r.out).toBe(0)
		expect(statSync(shared).mode & 0o777).toBe(0o755)
		const t2 = setup()
		const fresh = join(t2.root, 'keys/powder')
		expect(t2.run(t2.full, { SSH_KEY_PATH: join(fresh, 'id') }).status).toBe(0)
		expect(statSync(fresh).mode & 0o777).toBe(0o700)
	})

	describe('DNS check for the dashboard host', () => {
		it('says so when the host resolves to this server', () => {
			const t = setup()
			const r = t.run(t.full)
			expect(r.status, r.out).toBe(0)
			expect(t.log()).toContain('[getent] ahosts deploy.example.com')
			expect(r.stdout).toContain('deploy.example.com resolves to this server (203.0.113.10)')
			expect(r.stderr).not.toContain('⚠ DNS')
		})
		it('warns with the consequence and the fix, and installs anyway, when it points elsewhere', () => {
			const t = setup()
			const r = t.run(t.full, { STUB_DNS: '198.51.100.7' })
			expect(r.status, r.out).toBe(0)
			expect(r.stderr).toContain('⚠ DNS: deploy.example.com resolves to 198.51.100.7, not to this server (203.0.113.10)')
			expect(r.stderr).toContain("Traefik's default")
			expect(r.stderr).toContain('docker restart traefik')
			expect(t.log()).toContain('up -d worker')
			expect(r.stdout).toContain('The DNS check above says it does not point here yet.')
		})
		it('warns when the host does not resolve at all', () => {
			const t = setup()
			const r = t.run(t.full, { STUB_DNS: '' })
			expect(r.status, r.out).toBe(0)
			expect(r.stderr).toContain('⚠ DNS: deploy.example.com does not resolve.')
		})
		it('--dry-run shows the check without a lookup; --no-proxy skips it', () => {
			const t = setup()
			const r = t.run([...t.full, '--dry-run'], { STUB_UID: '1000' })
			expect(r.status, r.out).toBe(0)
			expect(r.stdout).toContain('would check that deploy.example.com resolves to an address of this server')
			expect(t.log()).not.toContain('[getent]')
			const n = t.run([...t.full, '--no-proxy'])
			expect(n.status, n.out).toBe(0)
			expect(t.log()).not.toContain('[getent]')
		})
		it('DNS is a prerequisite in the closing text, before the next steps', () => {
			const t = setup()
			const r = t.run(t.full)
			const dns = r.stdout.indexOf('DNS first:')
			expect(dns).toBeGreaterThan(-1)
			expect(dns).toBeLessThan(r.stdout.indexOf('Next:'))
		})
	})

	describe('memory check', () => {
		it('warns below 2 GB of memory plus swap, gives the swap commands and continues', () => {
			const t = setup()
			const r = t.run(t.full, { POWDER_MEMINFO_FILE: t.meminfo(1_000_000, 0) })
			expect(r.status, r.out).toBe(0)
			expect(r.stderr).toContain('⚠ memory: this server has 976 MB of memory and 0 MB of swap')
			expect(r.stderr).toContain('fallocate -l 2G /swapfile')
			expect(t.log()).toContain('up -d worker')
		})
		it('stays quiet with enough memory, or enough swap on top', () => {
			const t = setup()
			for (const f of [t.meminfo(4_000_000, 0), t.meminfo(1_000_000, 2_000_000)]) {
				const r = t.run([...t.full, '--dry-run'], { POWDER_MEMINFO_FILE: f, STUB_UID: '1000' })
				expect(r.status, r.out).toBe(0)
				expect(r.stderr).not.toContain('⚠ memory')
			}
		})
	})

	it('a flag without its value is a usage error, not a silent exit', () => {
		for (const f of ['--host', '--github-client-id', '--github-client-secret-file', '--set-admin']) {
			const t = setup()
			const r = t.run([f])
			expect(r.status).toBe(1)
			expect(r.out).toContain(`${f} needs a value`)
			const r2 = t.run([f, '--dry-run'])
			expect(r2.out).toContain(`${f} needs a value`)
		}
	})
})
