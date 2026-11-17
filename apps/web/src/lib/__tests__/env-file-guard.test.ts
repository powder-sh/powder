// env_file / label_file paths come from the JSON config, odd characters are
// refused, and every path component below the (resolved) app roots must not be a link,
// except a final link to the app's own /opt/apps/<app>.env.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { envFileLinkGuardShell } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'
import { writeFakeDocker } from './fixtures/fake-docker'

describe('env file guard (shell, temp tree shaped like the powder server)', () => {
	let root: string
	let vol: string
	let apps: string
	let bin: string
	let json: string
	let compose: string
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'envguard-')))
		// The powder server: /opt/apps is itself a link to a volume. Links ABOVE the root never count.
		vol = join(root, 'vol', 'apps')
		apps = join(root, 'apps')
		mkdirSync(join(vol, 'bf', 'data'), { recursive: true })
		symlinkSync(vol, apps)
		writeFileSync(join(vol, 'bf.env'), 'A=1\n')
		writeFileSync(join(vol, 'victim.env'), 'SECRET=1\n')
		writeFileSync(join(vol, 'bf', 'data', 'x.env'), 'X=1\n')
		// an operator-made .env -> the app's own env file
		symlinkSync(join(apps, 'bf.env'), join(vol, 'bf', '.env'))
		// tracked in-root dir symlink d2 -> data
		symlinkSync('data', join(vol, 'bf', 'd2'))
		// a link to the victim inside the app dir
		symlinkSync(join(vol, 'victim.env'), join(vol, 'bf', 'data', 'v.env'))
		// a folder outside the app that reaches into it
		symlinkSync(join(vol, 'bf', 'data'), join(root, 'side'))
		bin = join(root, 'bin')
		mkdirSync(bin)
		json = join(root, 'cfg.json')
		compose = join(root, 'compose.yml')
		writeFileSync(compose, 'services:\n  bf:\n    image: bf\n')
		// Fake docker: `ps -q` lists the ids in ps.txt, `inspect` prints the writable bind
		// sources in mounts.txt, any compose call prints the JSON config fixture.
		writeFileSync(join(root, 'ps.txt'), '')
		writeFileSync(join(root, 'mounts.txt'), '')
		writeFakeDocker(bin, `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(root, 'calls'))}\ncase "$1" in ps) cat ${JSON.stringify(join(root, 'ps.txt'))}; exit 0;; inspect) cat ${JSON.stringify(join(root, 'mounts.txt'))}; exit 0;; esac\ncat ${JSON.stringify(json)}\n`)
	})
	afterAll(() => rmSync(root, { recursive: true, force: true }))

	const guard = (paths: string[], wd = join(apps, 'bf'), extra: { volumes?: unknown[]; running?: string[] } = {}) => {
		writeFileSync(
			json,
			JSON.stringify(
				{
					name: 'bf',
					services: {
						bf: {
							env_file: paths.map((p) => ({ path: p, required: false })),
							image: 'bf',
							...(extra.volumes ? { volumes: extra.volumes } : {}),
						},
					},
				},
				null,
				2,
			),
		)
		writeFileSync(join(root, 'ps.txt'), extra.running?.length ? 'cid1\n' : '')
		writeFileSync(join(root, 'mounts.txt'), (extra.running ?? []).map((m) => `${m}\n`).join(''))
		const r = spawnSync('bash', ['-c', `set -e; ${envFileLinkGuardShell(`-f '${compose}'`, 'bf', wd, join(apps, 'bf.env'))} && echo PASSED`], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		})
		return { ok: r.status === 0 && r.stdout.toString().includes('PASSED'), out: r.stdout.toString() }
	}

	it('passes an operator-made .env -> own env link with /opt/apps itself a link', () => {
		const r = guard([join(apps, 'bf', '.env'), join(apps, 'bf.env')])
		expect(r.out).not.toContain('refusing')
		expect(r.ok).toBe(true)
	})
	it('passes the same paths written in their resolved (volume) form', () => {
		expect(guard([join(vol, 'bf', '.env'), join(vol, 'bf', 'data', 'x.env')]).ok).toBe(true)
	})
	it('passes a missing own env file and a missing file in the app dir', () => {
		expect(guard([join(apps, 'nope.env'), join(apps, 'bf', 'nope', 'x.env')]).ok).toBe(true)
	})
	it('passes another app dir file outside the roots that is not a link (cross-app reads stay the compose rules job)', () => {
		expect(guard([join(apps, 'victim.env')]).ok).toBe(true)
	})
	it('refuses a tracked in-root folder link (d2 -> data)', () => {
		const r = guard([join(apps, 'bf', 'd2', 'x.env')])
		expect(r.ok).toBe(false)
		expect(r.out).toContain('goes through the symlink')
	})
	it('refuses a final link to another app env inside the app dir', () => {
		expect(guard([join(apps, 'bf', 'data', 'v.env')]).ok).toBe(false)
	})
	it('refuses a folder outside the app that reaches into it through a link', () => {
		const r = guard([join(root, 'side', 'x.env')])
		expect(r.ok).toBe(false)
		expect(r.out).toContain('reaches into the app dir')
	})
	it('refuses odd characters, relative paths and dot components (hard)', () => {
		expect(guard([join(apps, 'bf', 'data', 'x\ty.env')]).out).toContain('characters outside')
		expect(guard([join(apps, 'bf', 'a b.env')]).ok).toBe(false)
		expect(guard(['bf/x.env']).out).toContain('not absolute')
		expect(guard([`${apps}/bf/../victim.env`]).out).toContain('. or .. component')
	})
	it('collapses double slashes before matching the root', () => {
		expect(guard([`${apps}//bf//d2/x.env`]).ok).toBe(false)
		expect(guard([`${apps}//bf/.env`]).ok).toBe(true)
	})
	it('runs under set -e without tripping on a false test', () => {
		expect(guard([join(apps, 'bf.env'), join(apps, 'bf', 'data', 'x.env')]).ok).toBe(true)
	})

	describe('no env file in a folder a container of the project can write', () => {
		const bind = (source: string, ro = false) => ({ type: 'bind', source, target: '/x', ...(ro ? { read_only: true } : {}), bind: { create_host_path: true } })
		it('refuses .env -> own env when the app dir is bound writable (new config)', () => {
			const r = guard([join(apps, 'bf', '.env')], undefined, { volumes: [bind(join(apps, 'bf'))] })
			expect(r.ok).toBe(false)
			expect(r.out).toContain('writable bind of')
		})
		it('allows the same bind read-only', () => {
			expect(guard([join(apps, 'bf', '.env')], undefined, { volumes: [bind(join(apps, 'bf'), true)] }).ok).toBe(true)
		})
		it('allows the own /opt/apps/<app>.env next to a writable .:/app bind (the common shape)', () => {
			expect(guard([join(apps, 'bf.env')], undefined, { volumes: [bind(join(apps, 'bf')), { type: 'volume', source: 'v', target: '/v' }] }).ok).toBe(true)
		})
		it('refuses an env file under the writable bind of a RUNNING container of the project (not-recreated sibling)', () => {
			const r = guard([join(apps, 'bf', 'data', 'x.env')], undefined, { running: [join(vol, 'bf', 'data')] })
			expect(r.ok).toBe(false)
			expect(r.out).toContain(join(vol, 'bf', 'data'))
		})
		it('resolves a bind source given through the /opt/apps link', () => {
			expect(guard([join(vol, 'bf', 'data', 'x.env')], undefined, { volumes: [bind(join(apps, 'bf', 'data'))] }).ok).toBe(false)
		})
		it('a file bind (docker.sock style) and a bind from a variable do not count', () => {
			expect(guard([join(apps, 'bf', 'data', 'x.env')], undefined, { volumes: [bind(join(apps, 'bf', 'data', 'x.env')), bind('${DATA}/x')] }).ok).toBe(true)
		})
		it('refuses a bind source it cannot read', () => {
			expect(guard([join(apps, 'bf.env')], undefined, { volumes: [bind('/opt/apps/bf/a"b')] }).out).toContain('cannot check the writable bind source')
		})
	})
})

describe('the deploy script re-runs the guard before every compose up attempt', () => {
	const s = buildDeployScript({
		workingDir: '/opt/apps/a',
		configFile: '/opt/apps/a/docker-compose.yml',
		service: 'a',
		cf: "-f '/opt/apps/a/docker-compose.yml'",
		declaredMode: 'build',
		prebuilt: false,
		infra: ['db'],
		wantBranch: null,
		wantSha: null,
		shaIsStrict: false,
	})
	const upBlock = s.slice(s.indexOf('step "docker compose up"'), s.indexOf('SWAPPED=1'))
	it('every `up` in the swap block is directly preceded by el_guard', () => {
		const ups = upBlock.split(/docker compose [^;]*? up -d/).length - 1
		expect(ups).toBe(5)
		// the infra up has the infra mount guard between (it reads the config the
		// env file guard just passed, and changes nothing on disk)
		expect(upBlock.match(/el_guard( \|\| exit 1;| &&) +(\{ IG_CFG=[\s\S]*?\[ "\$IG_RC" = 0 \] \|\| exit 1; \} \|\| exit 1; +)?\(?docker compose [^;]*? up -d/g)).toHaveLength(5)
	})
	it('a retry re-runs the guard before it removes anything', () => {
		expect(upBlock).toContain('"[retry] cleaning stale state and retrying up" && el_guard && bridge_stop')
	})
	it('a refusal on a retry stops every later attempt (runs under bash with stubs)', () => {
		// First up fails; the guard then refuses on the retry: no further up may run.
		const d = realpathSync(mkdtempSync(join(tmpdir(), 'retry-')))
		try {
			const body =
				`set -e; CALLS=${d}/calls; : > "$CALLS"; N=0; ` +
				`el_guard() { N=$((N+1)); echo guard >> "$CALLS"; if [ -f ${d}/refuse ]; then echo "env file guard: refusing, test"; exit 1; fi; touch ${d}/refuse; }; ` +
				`docker() { echo "docker $*" >> "$CALLS"; case "$*" in *" up "*) return 1;; esac; return 0; }; ` +
				`bridge_stop() { :; }; bridge_handoff() { :; }; sleep() { :; }; TARGETS=a; CP_PROJ=p; ` +
				`${upBlock.slice(upBlock.indexOf('el_guard && (docker compose'))}SWAPPED=1 && echo swapped`
			const r = spawnSync('bash', ['-c', body], { encoding: 'utf8' })
			const calls = readFileSync(join(d, 'calls'), 'utf8')
			expect(r.status).not.toBe(0)
			expect(r.stdout).not.toContain('swapped')
			expect(calls.match(/ up /g)).toHaveLength(1)
			expect(calls.split('guard').length - 1).toBe(2)
		} finally {
			rmSync(d, { recursive: true, force: true })
		}
	})
})
