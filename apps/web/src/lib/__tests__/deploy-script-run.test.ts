import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'ssh2'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseDeployFailure } from '../deploy-failure'
import { buildDeployScript, composeFileArgs, rebuildDeploy } from '../ssh'
import { parseStabilityMarkers } from '../deploy/stability'

// The script writes github.com's known_hosts to /opt/apps (falling back to a
// mktemp file in $TMPDIR when that is not writable, which the leftover-temp
// assertions would see): point it into the test dir, never the host's /opt/apps.
const KNOWN_HOSTS = vi.hoisted(() => '/opt/apps/.powder_known_hosts')

// The remote server is this machine here, so the SFTP upload of the deploy script is a local file write.
vi.mock('../ssh/files', async (importOriginal) => {
	const fs = await import('node:fs')
	return {
		...(await importOriginal<typeof import('../ssh/files')>()),
		writeFileViaSftp: async (_s: unknown, path: string, content: string, mode: number) => {
			const t = (await import('node:os')).tmpdir()
			fs.writeFileSync(
				path,
				content.replaceAll('/var/lib/powder/locks', `${t}/powder-locks-test`).replaceAll(KNOWN_HOSTS, `${t}/.powder_known_hosts`),
				{ mode },
			)
		},
	}
})

// Runs the GENERATED deploy script under bash with stub docker/git/flock/timeout,
// so silent-failure regressions (rc=0 on a failed fetch / missing image ref) are
// caught for real instead of by string matching.
//
// FAIL is a comma list of stub failures: gitfetch, catfile, fetchsha, checkout,
// reset, declared (docker compose config --services), composediff (git diff of
// the tracked compose reports a change). The stub git overwrites
// docker-compose.yml on checkout/reset (like a tracked compose would be; not with
// nocompose), and
// fails any bare `git rev-parse` (no `-c safe.directory`) with rc=128, like git
// does for a workdir not owned by the running user.

const STUBS: Record<string, string> = {
	docker: `#!/bin/bash
echo "[docker] $*" >> "$CALLS"
f() { [[ ",$FAIL," == *",$1,"* ]]; }
# drop powder_git's hardening flags (-c k=v other than safe.directory, --git-dir/--work-tree, -C)
a=""; while [ $# -gt 0 ]; do case "$1" in -c) case "$2" in safe.directory=*) a="$a -c $2";; esac; shift 2;; -C) shift 2;; --git-dir=*|--work-tree=*) shift;; *) a="$a $1"; shift;; esac; done; set -- $a
case "$*" in
  info*) exit 0;;
  *"config --services"*) f declared && exit 1; echo shop; echo db; exit 0;;
  *"config --no-interpolate --format json"*) printf '{\n  "name": "shop",\n  "services": {\n    "shop": {\n      "image": "shop:latest"\n    }\n  }\n}\n'; exit 0;;
  *" config --format json"*) printf '{\n  "name": "shop",\n  "services": {\n    "db": {\n      "image": "postgres:16"\n    },\n    "shop": {\n      "image": "shop:latest"\n    }\n  }\n}\n'; exit 0;;
  *" config"*)
    printf 'name: app\nservices:\n  shop:\n'
    if [ "$CFG" != registry ]; then printf '    build:\n      context: %s\n      dockerfile: Dockerfile\n' "$CTX"; fi
    if [ "$CFG" != noimage ]; then printf '    image: shop:latest\n'; fi
    printf '  db:\n    image: postgres:16\n'; exit 0;;
  "ps -a"*) exit 0;;
  *" up "*) f up && exit 1; exit 0;;
  *" ps -q"*) echo cid123; exit 0;;
  *"image inspect"*powder.release.cmd*) printf '%s' "$RELEASE"; exit 0;;
  inspect*) echo shop:latest; exit 0;;
  *) exit 0;;
esac
`,
	flock: `#!/bin/bash
echo "[flock] $*" >> "$CALLS"
if [ "$1" = -w ]; then shift 2; fi
if [ "$1" = 9 ]; then exit 0; fi
shift; exec "$@"
`,
	git: `#!/bin/bash
echo "[git] $*" >> "$CALLS"
# the known_hosts file the deploy key's ssh would check: present and filled while git runs
case "$GIT_SSH_COMMAND" in *UserKnownHostsFile=*) k=\${GIT_SSH_COMMAND#*UserKnownHostsFile=}; k=\${k%% *}; [ -s "$k" ] && echo "[pkh-ok] $k" >> "$CALLS";; esac
f() { [[ ",$FAIL," == *",$1,"* ]]; }
# drop powder_git's hardening flags (-c k=v other than safe.directory, --git-dir/--work-tree, -C)
a=""; while [ $# -gt 0 ]; do case "$1" in -c) case "$2" in safe.directory=*) a="$a -c $2";; esac; shift 2;; -C) shift 2;; --git-dir=*|--work-tree=*) shift;; *) a="$a $1"; shift;; esac; done; set -- $a
case "$*" in
  *rev-parse*) [[ "$*" == *safe.directory* ]] || { echo "fatal: detected dubious ownership in repository" >&2; exit 128; };;
  *"fetch origin "[0-9a-f]*) f fetchsha && exit 1; exit 0;;
  *fetch*) f gitfetch && exit 1; exit 0;;
  *cat-file*) f catfile && exit 1; exit 0;;
  *"diff --no-ext-diff"*) f composediff && exit 1; exit 0;;
  *"checkout -f"*) f nocompose || echo "repo: compose" > docker-compose.yml; f checkout && exit 1; exit 0;;
  *"reset --hard"*) f nocompose || echo "repo: compose" > docker-compose.yml; f reset && exit 1; exit 0;;
esac
case "$*" in *"remote get-url"*) echo git@github.com:x/y.git;; *"rev-parse -q --verify"*) echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;; *"rev-parse HEAD"*) echo cccccccccccccccccccccccccccccccccccccccc;; *"rev-parse --abbrev-ref"*) echo main;; esac
exit 0
`,
	sleep: `#!/bin/bash
exit 0
`,
	timeout: `#!/bin/bash
[ "$1" = -k ] && shift 2; shift; exec "$@"
`,
}

const SHA = 'a'.repeat(40)

type Opts = {
	layout: 'src' | 'wd'
	cfg: 'image' | 'noimage'
	prebuilt: boolean
	fail?: string
	sha?: string | null
	strict?: boolean
	rmWd?: boolean
	/** build.context the stub compose reports, relative to the app dir (default: the layout's). */
	ctx?: string
	/** extra files to create, relative to the app dir. */
	files?: string[]
	/** the known_hosts dir cannot be written (as /opt/apps for a non-root user): the mktemp fallback runs. */
	khUnwritable?: boolean
	/** a .deploy-key in the app dir, so git runs with GIT_SSH_COMMAND (and the known_hosts file). */
	deployKey?: boolean
	/** the image's powder.release.cmd label (empty: none). */
	release?: string
	/** a preview deploy (skipMigrate, as preview-deploys.ts passes it). */
	preview?: boolean
}

function makeBin(d: string) {
	const bin = join(d, 'bin')
	mkdirSync(bin)
	for (const [n, body] of Object.entries(STUBS)) {
		writeFileSync(join(bin, n), body)
		chmodSync(join(bin, n), 0o755)
	}
	return bin
}

function run({ layout, cfg, prebuilt, fail = '', sha = null, strict = false, rmWd = false, ctx, files = [], khUnwritable = false, deployKey = false, release = '', preview = false }: Opts) {
	const d = mkdtempSync(join(tmpdir(), 'powder-run-'))
	const wd = join(d, 'app')
	const tmp = join(d, 'tmp')
	mkdirSync(join(wd, 'src'), { recursive: true })
	mkdirSync(tmp)
	const bin = makeBin(d)
	writeFileSync(join(wd, 'src', 'Dockerfile'), 'FROM scratch\n')
	if (layout === 'src') mkdirSync(join(wd, 'src', '.git'))
	else {
		mkdirSync(join(wd, '.git'))
		writeFileSync(join(wd, 'Dockerfile'), 'FROM scratch\n')
	}
	writeFileSync(join(wd, 'docker-compose.yml'), 'local: compose\n')
	if (deployKey) writeFileSync(join(wd, '.deploy-key'), 'not-a-key\n', { mode: 0o600 })
	for (const f of files) {
		mkdirSync(join(wd, f, '..'), { recursive: true })
		writeFileSync(join(wd, f), 'x\n')
	}
	const script = buildDeployScript({
		workingDir: wd,
		configFile: `${wd}/docker-compose.yml`,
		service: 'shop',
		cf: composeFileArgs(`${wd}/docker-compose.yml`),
		declaredMode: 'auto',
		prebuilt,
		stageImage: prebuilt ? 'shop:build-x' : null,
		infra: ['db'],
		wantBranch: 'main',
		wantSha: sha,
		shaIsStrict: strict,
		swapOrdinal: undefined,
		stageId: 'dep_t',
		migrateApp: 'shop',
		shaNonce: 'testnonce123',
		skipMigrate: preview,
	} as unknown as Parameters<typeof buildDeployScript>[0]).replaceAll('/tmp/powder-stage-', `${d}/stage-`).replaceAll('/var/lib/powder/locks', `${d}/locks`).replaceAll(KNOWN_HOSTS, khUnwritable ? `${d}/no-such-dir/.powder_known_hosts` : `${d}/.powder_known_hosts`)
	const sf = join(d, 'deploy.sh')
	writeFileSync(sf, script)
	const calls = join(d, 'calls')
	writeFileSync(calls, '')
	if (rmWd) rmSync(wd, { recursive: true, force: true })
	const r = spawnSync('bash', [sf], {
		encoding: 'utf8',
		cwd: d,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			TMPDIR: tmp,
			CALLS: calls,
			FAIL: fail,
			CFG: cfg,
			RELEASE: release,
			CTX: ctx !== undefined ? join(wd, ctx) : layout === 'wd' ? wd : join(wd, 'src'),
		},
	})
	const log = readFileSync(calls, 'utf8')
	return {
		d,
		rc: r.status,
		out: `${r.stdout}${r.stderr}`,
		stdout: r.stdout,
		log,
		up: / up /.test(log),
		build: / build /.test(log),
		compose: existsSync(join(wd, 'docker-compose.yml')) ? readFileSync(join(wd, 'docker-compose.yml'), 'utf8') : null,
		tmp,
		leftoverTmp: readdirSync(tmp),
	}
}

describe('generated deploy script (run under bash with stubs)', () => {
	it('workdir layout + failing git fetch: rc!=0, no build, no up, compose preserved', () => {
		const r = run({ layout: 'wd', cfg: 'image', prebuilt: false, fail: 'gitfetch' })
		expect(r.rc).not.toBe(0)
		expect(r.build).toBe(false)
		expect(r.up).toBe(false)
		expect(r.out).toContain('git sync of the workdir FAILED')
		expect(r.out).toMatch(/Fix the deploy key at .*\/app\/\.deploy-key/)
		expect(r.out).toContain('__POWDER_FAIL__')
		expect(r.compose).toBe('local: compose\n')
		expect(r.leftoverTmp).toEqual([])
	})

	it.each(['checkout', 'reset'])('workdir layout + failing git %s: rc!=0, compose restored, CP_KEEP cleaned', (fail) => {
		const r = run({ layout: 'wd', cfg: 'image', prebuilt: false, fail })
		expect(r.rc).not.toBe(0)
		expect(r.build).toBe(false)
		expect(r.up).toBe(false)
		expect(r.out).toContain('git sync of the workdir FAILED')
		expect(r.out).toContain('__POWDER_FAIL__')
		expect(r.compose).toBe('local: compose\n')
		expect(r.leftoverTmp).toEqual([])
	})

	it('workdir layout + strict sha that cannot be resolved: rc!=0 via the sync path, compose restored, CP_KEEP cleaned', () => {
		const r = run({ layout: 'wd', cfg: 'image', prebuilt: false, fail: 'catfile,fetchsha', sha: SHA, strict: true })
		expect(r.rc).not.toBe(0)
		expect(r.build).toBe(false)
		expect(r.up).toBe(false)
		expect(r.out).toContain('refusing to sync a different commit')
		expect(r.out).toContain('git sync of the workdir FAILED')
		expect(r.out).toContain('__POWDER_FAIL__')
		expect(r.compose).toBe('local: compose\n')
		expect(r.leftoverTmp).toEqual([])
	})

	it('src layout + strict sha that cannot be resolved: rc!=0 with the src/ sync message', () => {
		const r = run({ layout: 'src', cfg: 'image', prebuilt: false, fail: 'catfile,fetchsha', sha: SHA, strict: true })
		expect(r.rc).not.toBe(0)
		expect(r.up).toBe(false)
		expect(r.out).toContain('git sync of src/ FAILED')
		expect(r.out).toContain('__POWDER_FAIL__')
	})

	it('workdir layout happy path: rc=0, up runs, compose preserved, rev-parse works with safe.directory', () => {
		const r = run({ layout: 'wd', cfg: 'image', prebuilt: false })
		expect(r.rc).toBe(0)
		expect(r.up).toBe(true)
		expect(r.compose).toBe('local: compose\n')
		expect(r.out).not.toContain('dubious ownership')
		expect(r.out).toMatch(/── git rev-parse ──\s*\n[0-9a-f]{40}\s*\nmain\s*\n/)
		expect(r.out).toMatch(/^__POWDER_SHA_testnonce123__ [0-9a-f]{40} main$/m)
		expect(r.leftoverTmp).toEqual([])
	})

	it('known_hosts dir not writable: git uses the mktemp fallback, which is removed on success and on failure', () => {
		for (const fail of ['', 'gitfetch']) {
			const r = run({ layout: 'wd', cfg: 'image', prebuilt: false, fail, khUnwritable: true, deployKey: true })
			if (fail) {
				expect(r.rc).not.toBe(0)
				expect(r.out).toContain('__POWDER_FAIL__')
			} else expect(r.rc).toBe(0)
			// the fallback file was in $TMPDIR and filled while git ran ...
			expect(r.log).toContain(`[pkh-ok] ${r.tmp}/tmp.`)
			// ... and the EXIT trap removed it, after the script's own trap still ran
			expect(r.leftoverTmp).toEqual([])
			const pkh = /\[pkh-ok\] (\S+)/.exec(r.log)?.[1] ?? ''
			expect(pkh && existsSync(pkh)).toBe(false)
			expect(r.compose).toBe('local: compose\n')
		}
	})

	it('workdir layout + pinned strict sha that resolves: rc=0', () => {
		const r = run({ layout: 'wd', cfg: 'image', prebuilt: false, sha: SHA, strict: true })
		expect(r.rc).toBe(0)
		expect(r.out).toContain(`[sync] pinned to commit ${SHA}`)
		expect(r.compose).toBe('local: compose\n')
	})

	it('unreadable app directory (cd fails): rc!=0 with a clear message, nothing built', () => {
		const r = run({ layout: 'wd', cfg: 'image', prebuilt: false, rmWd: true })
		expect(r.rc).not.toBe(0)
		expect(r.build).toBe(false)
		expect(r.up).toBe(false)
		expect(r.out).toContain('cannot cd to the app directory')
		expect(r.out).toContain('__POWDER_FAIL__')
	})

	it('compose service listing fails: rc!=0 instead of skipping the orphan guard', () => {
		const r = run({ layout: 'wd', cfg: 'image', prebuilt: false, fail: 'declared' })
		expect(r.rc).not.toBe(0)
		expect(r.build).toBe(false)
		expect(r.up).toBe(false)
		expect(r.out).toContain('cannot list the compose services')
		expect(r.out).toContain('__POWDER_FAIL__')
	})

	// the resolved build.context is compose data. A context dir holding `@` and `;`
	// must never land in `sed "s@^$PG_DIR/@@"` (GNU sed `e` = command as root). The preflight
	// refuses any char outside [A-Za-z0-9._/-] before PG_DIR is used, and the prefix
	// strip is plain parameter expansion.
	it('build.context with @ and ; (sed program injection shape): refused in preflight, nothing runs', () => {
		const evil = 'src/z@@;etouch${IFS}PWNED;#'
		const r = run({
			layout: 'src',
			cfg: 'image',
			prebuilt: false,
			ctx: evil,
			files: [`${evil}/Dockerfile`, `${evil}/pages/api/x.test.ts`],
		})
		expect(r.rc).not.toBe(0)
		expect(r.out).toContain('contains a character outside [A-Za-z0-9._/-]')
		expect(r.out).toContain('__POWDER_FAIL__')
		expect(r.out).not.toContain('test file inside pages/app tree')
		expect(r.build).toBe(false)
		expect(r.up).toBe(false)
		const found = spawnSync('find', [r.d, '-name', 'PWNED'], { encoding: 'utf8' }).stdout.trim()
		expect(found).toBe('')
	})

	it('pages/app test-file guard strips the context prefix without sed', () => {
		const r = run({ layout: 'src', cfg: 'image', prebuilt: false, files: ['src/pages/api/x.test.ts'] })
		expect(r.rc).not.toBe(0)
		expect(r.out).toContain('preflight: test file inside pages/app tree: pages/api/x.test.ts - Next builds it')
		expect(r.build).toBe(false)
		expect(r.up).toBe(false)
	})

	it('prebuilt with no image: ref for the service: rc!=0, no up, message reaches stdout and the failure parser', () => {
		const r = run({ layout: 'src', cfg: 'noimage', prebuilt: true })
		expect(r.rc).not.toBe(0)
		expect(r.up).toBe(false)
		expect(r.out).toContain('swap gate: no image: ref for service shop')
		expect(r.out).toContain('__POWDER_FAIL__')
		// stdout (what parseDeployFailure and the live log see), not stderr only
		expect(r.stdout).toContain('swap gate: no image: ref for service shop')
		expect(parseDeployFailure(r.stdout).failedStep).toBe('swap gate')
	})

	it('prebuilt: a failure after the swap gate but before the swap restores the shared tag', () => {
		const r = run({ layout: 'src', cfg: 'image', prebuilt: true, fail: 'up' })
		expect(r.rc).not.toBe(0)
		expect(r.log).toContain('[docker] image tag shop:latest shop:latest')
		expect(r.out).toContain('[release] shared tag restored to the previously running image')
	})

	it('prebuilt: a successful swap does NOT restore the shared tag', () => {
		const r = run({ layout: 'src', cfg: 'image', prebuilt: true })
		expect(r.rc).toBe(0)
		expect(r.log).not.toContain('[docker] image tag shop:latest')
	})

	it('prebuilt with an image: ref: rc=0 and up runs', () => {
		const r = run({ layout: 'src', cfg: 'image', prebuilt: true })
		expect(r.rc).toBe(0)
		expect(r.up).toBe(true)
	})
})

// Self-deploy (rebuildDeploy -> runSelfDeploy): ssh2 is replaced so the remote
// command runs locally under bash with the same stubs.
describe('self-deploy script (runSelfDeploy, run under bash with stubs)', () => {
	beforeAll(() => {
		vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client) {
			setImmediate(() => this.emit('ready'))
			return this
		})
		vi.spyOn(Client.prototype, 'end').mockImplementation(function (this: Client) {
			return this
		})
		vi.spyOn(Client.prototype, 'exec').mockImplementation(((cmd: string, cb: (e: undefined, s: unknown) => void) => {
			const p = spawn('bash', ['-c', cmd.replaceAll('/var/lib/powder/locks', `${tmpdir()}/powder-locks-test`).replaceAll(KNOWN_HOSTS, `${tmpdir()}/.powder_known_hosts`)], { env: process.env })
			const s = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
			p.stdout.on('data', (b: Buffer) => s.emit('data', b))
			p.stderr.on('data', (b: Buffer) => s.stderr.emit('data', b))
			p.on('close', (code: number) => s.emit('close', code))
			cb(undefined, s)
			return true
		}) as unknown as Client['exec'])
	})
	afterEach(() => {
		for (const k of ['POWDER_SELF_SERVICE', 'POWDER_SELF_CONTAINER', 'POWDER_SELF_SERVER_ID', 'CALLS', 'FAIL', 'CFG', 'CTX', 'TMPDIR_ORIG']) delete process.env[k]
	})

	async function selfDeploy(layout: 'src' | 'wd', fail: string) {
		const d = mkdtempSync(join(tmpdir(), 'powder-self-'))
		const wd = join(d, 'app')
		mkdirSync(join(wd, 'src'), { recursive: true })
		mkdirSync(join(wd, layout === 'src' ? 'src/.git' : '.git'), { recursive: true })
		writeFileSync(join(wd, 'docker-compose.yml'), 'local: compose\n')
		const calls = join(d, 'calls')
		writeFileSync(calls, '')
		const bin = makeBin(d)
		process.env.POWDER_SELF_SERVICE = 'shop'
		// self-deploy is decided by identity (container, server, project)
		process.env.POWDER_SELF_CONTAINER = 'shop'
		process.env.POWDER_SELF_SERVER_ID = 'x'
		process.env.CALLS = calls
		process.env.FAIL = fail
		process.env.CFG = 'image'
		process.env.CTX = layout === 'wd' ? wd : join(wd, 'src')
		const oldPath = process.env.PATH
		process.env.PATH = `${bin}:${oldPath}`
		try {
			const res = await rebuildDeploy({ id: 'x', host: '127.0.0.1', user: 'root' } as never, wd, `${wd}/docker-compose.yml`, 'shop', 'dep_t', undefined, { selfIdentity: { containerName: 'shop', composeProject: 'shop' } }).then(
				(r) => ({ ok: true as const, r }),
				(e: Error) => ({ ok: false as const, e }),
			)
			return { res, compose: readFileSync(join(wd, 'docker-compose.yml'), 'utf8') }
		} finally {
			process.env.PATH = oldPath
		}
	}

	it('workdir layout happy path: rev-parse succeeds with safe.directory, sha is parsed', async () => {
		const { res, compose } = await selfDeploy('wd', '')
		expect(res.ok).toBe(true)
		if (res.ok) expect(res.r.sha).toBe('c'.repeat(40))
		expect(compose).toBe('local: compose\n')
	})

	it('workdir layout + failing git fetch: the deploy throws, compose preserved', async () => {
		const { res, compose } = await selfDeploy('wd', 'gitfetch')
		expect(res.ok).toBe(false)
		if (!res.ok) expect(String(res.e.message)).toContain('git sync of the workdir FAILED')
		expect(compose).toBe('local: compose\n')
	})
})

// Deploy-setup markers (deploy/stability.ts) from the full generated script: printed
// with the run's nonce, never changing the run's outcome.
describe('deploy-setup markers in the generated script', () => {
	const markers = (r: { stdout: string }) => parseStabilityMarkers(r.stdout, 'testnonce123')

	it('src layout: a repo docker-compose.yml that differs is drift, none is ok; rc=0 either way', () => {
		const drift = run({ layout: 'src', cfg: 'image', prebuilt: false, fail: 'nocompose', files: ['src/docker-compose.yml'] })
		expect(drift.rc).toBe(0)
		expect(drift.out).toContain('[compose-drift] WARNING')
		expect(markers(drift).composeDrift).toBe('drift')
		// (nocompose: the stub checkout writes no src/docker-compose.yml)
		const ok = run({ layout: 'src', cfg: 'image', prebuilt: false, fail: 'nocompose' })
		expect(ok.rc).toBe(0)
		expect(markers(ok).composeDrift).toBe('ok')
	})

	it('workdir layout: a committed compose that differs is drift, a matching one ok', () => {
		const drift = run({ layout: 'wd', cfg: 'image', prebuilt: false, fail: 'composediff' })
		expect(drift.rc).toBe(0)
		expect(markers(drift).composeDrift).toBe('drift')
		const ok = run({ layout: 'wd', cfg: 'image', prebuilt: false })
		expect(ok.rc).toBe(0)
		expect(markers(ok).composeDrift).toBe('ok')
	})

	it('migrate-path: stray *.sql outside the powder-migrate folders, before powder-migrate; preview skips it', () => {
		const stray = run({ layout: 'src', cfg: 'image', prebuilt: false, files: ['src/sql/0001_init.sql'] })
		expect(stray.rc).toBe(0)
		expect(markers(stray).migratePath).toEqual(['stray-sql'])
		expect(stray.stdout.indexOf('[migrate-path] WARNING')).toBeGreaterThan(stray.stdout.indexOf('── db migrate ──'))
		const ok = run({ layout: 'src', cfg: 'image', prebuilt: false, files: ['src/drizzle/0001_init.sql'] })
		expect(ok.rc).toBe(0)
		expect(markers(ok).migratePath).toEqual([])
	})

	it('migrate-path: a ledgered migrator in powder.release.cmd raises nothing; a schema push there is release-cmd', () => {
		const knex = run({ layout: 'src', cfg: 'image', prebuilt: false, release: 'npx knex migrate:latest' })
		expect(knex.rc).toBe(0)
		expect(knex.stdout).toContain('[release] running powder.release.cmd')
		expect(markers(knex).migratePath).toEqual([])
		expect(knex.stdout).not.toContain('[migrate-path] WARNING')
		const push = run({ layout: 'src', cfg: 'image', prebuilt: false, release: 'npx drizzle-kit push --force' })
		expect(push.rc).toBe(0)
		expect(markers(push).migratePath).toEqual(['release-cmd'])
		expect(push.stdout).toContain('[migrate-path] WARNING: the powder.release.cmd label runs a schema push')
	})

	it('release step: a normal deploy runs the label command; a preview never does and still succeeds', () => {
		const normal = run({ layout: 'src', cfg: 'image', prebuilt: false, release: 'npx knex migrate:latest' })
		expect(normal.rc).toBe(0)
		expect(normal.stdout).toContain('[release] running powder.release.cmd')
		expect(normal.log).toMatch(/\[docker\] compose .* run .*powder-release/)
		const preview = run({ layout: 'src', cfg: 'image', prebuilt: false, release: 'npx knex migrate:latest', preview: true })
		expect(preview.rc).toBe(0)
		expect(preview.stdout).toContain('[release] skipped: preview deploys never run the release command')
		expect(preview.stdout).not.toContain('[release] running')
		expect(preview.log).not.toContain('powder-release')
		expect(preview.log).not.toContain('powder.release.cmd')
		expect(preview.up).toBe(true)
	})

	it('test-gate: absent without .powder/test.sh; prebuilt deploys check the synced context too', () => {
		const local = run({ layout: 'src', cfg: 'image', prebuilt: false })
		expect(local.rc).toBe(0)
		expect(markers(local).testGate).toBe('absent')
		const preAbsent = run({ layout: 'src', cfg: 'image', prebuilt: true })
		expect(preAbsent.rc).toBe(0)
		expect(markers(preAbsent).testGate).toBe('absent')
		const prePresent = run({ layout: 'src', cfg: 'image', prebuilt: true, files: ['src/.powder/test.sh'] })
		expect(prePresent.rc).toBe(0)
		expect(markers(prePresent).testGate).toBe('present')
	})

	it('test-gate present: the marker sits in the branch that runs the gate', () => {
		const s = buildDeployScript({
			workingDir: '/opt/apps/shop',
			configFile: '/opt/apps/shop/docker-compose.yml',
			service: 'shop',
			cf: composeFileArgs('/opt/apps/shop/docker-compose.yml'),
			declaredMode: 'auto',
			prebuilt: false,
			infra: [],
			wantBranch: 'main',
			wantSha: null,
			shaIsStrict: false,
			shaNonce: 'testnonce123',
		})
		expect(s).toContain(`if [ -f "$TG_DIR/.powder/test.sh" ]; then echo '__POWDER_STAB_testnonce123__ test-gate present'; `)
		expect(s).toContain(`skipped (opt-in test/typecheck gate; see /docs/deploys#steps-in-order)"; echo '__POWDER_STAB_testnonce123__ test-gate absent'; fi && `)
		// no nonce: the script is exactly the one without the deploy-setup checks
		const plain = buildDeployScript({
			workingDir: '/opt/apps/shop',
			configFile: '/opt/apps/shop/docker-compose.yml',
			service: 'shop',
			cf: composeFileArgs('/opt/apps/shop/docker-compose.yml'),
			declaredMode: 'auto',
			prebuilt: false,
			infra: [],
			wantBranch: 'main',
			wantSha: null,
			shaIsStrict: false,
		})
		expect(plain).not.toContain('__POWDER_STAB_')
		expect(plain).not.toContain('[migrate-path]')
	})

	it('a failed sync prints no marker (unknown)', () => {
		const r = run({ layout: 'src', cfg: 'image', prebuilt: false, fail: 'gitfetch', files: ['src/docker-compose.yml'] })
		expect(r.rc).not.toBe(0)
		expect(markers(r).composeDrift).toBeNull()
	})
})
