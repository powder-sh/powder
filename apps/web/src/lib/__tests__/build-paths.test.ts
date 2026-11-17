// what a build reads must be a path no writable bind covers (at or above it,
// any compose project, any state), every link hop on the way is checked, the build uses
// exactly the path that was checked (pinned in powder's override, re-verified before each
// build), the target-commit link check counts build paths, and a build service whose
// Dockerfile is missing refuses the deploy. Invented names only.
import { execFileSync, spawnSync } from 'node:child_process'
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildLockShell } from '../build-lock'
import { composeDockerfileRewriteShell, dockerfileRewriteFunctions } from '../build-cache'
import { composeViolations, neverExemptable } from '../compose-safety'
import { bindLinkGuardShell } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'
import { gitHardenShellFunctions } from '../git-harden'
import { targetLinkGuardShell, targetLinkSourcesShell } from '../target-links'
import { writeFakeDocker } from './fixtures/fake-docker'

const bind = (source: string, ro = false) => ({
	type: 'bind',
	source,
	target: '/x',
	...(ro ? { read_only: true } : {}),
	bind: { create_host_path: true },
})

describe('bind guard on build paths (fake docker, temp tree)', () => {
	let root: string
	let apps: string
	let wd: string
	let bin: string
	let json: string
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'bp-')))
		apps = join(root, 'apps')
		wd = join(apps, 'lantern')
		mkdirSync(join(wd, 'src', 'data', 'sub'), { recursive: true })
		mkdirSync(join(wd, 'src', 'real2'), { recursive: true })
		mkdirSync(join(wd, 'src', 'docker', 'inner'), { recursive: true })
		writeFileSync(join(wd, 'src', 'Dockerfile'), 'FROM scratch\n')
		writeFileSync(join(wd, 'src', 'docker', 'inner', 'Dockerfile'), 'FROM scratch\n')
		// a tracked two-hop chain that never touches a writable bind
		symlinkSync('inner/Dockerfile', join(wd, 'src', 'docker', 'Dockerfile.hop'))
		symlinkSync('docker/Dockerfile.hop', join(wd, 'src', 'Dockerfile.chain'))
		bin = join(root, 'bin')
		mkdirSync(bin)
		json = join(root, 'cfg.json')
		writeFileSync(join(root, 'ps.txt'), '')
		writeFileSync(join(root, 'mounts.txt'), '')
		writeFakeDocker(bin, `#!/bin/sh\ncase "$1" in ps) cat ${JSON.stringify(join(root, 'ps.txt'))}; exit 0;; volume) exit 0;; inspect) case "$*" in *'"volume"'*) exit 0;; esac; cat ${JSON.stringify(join(root, 'mounts.txt'))}; exit 0;; esac\ncat ${JSON.stringify(json)}\n`)
	})
	afterAll(() => rmSync(root, { recursive: true, force: true }))

	const guard = (services: Record<string, unknown>, running: string[] = []) => {
		writeFileSync(json, JSON.stringify({ name: 'lantern', services }, null, 2))
		writeFileSync(join(root, 'ps.txt'), running.length ? 'cid1\n' : '')
		writeFileSync(join(root, 'mounts.txt'), running.map((m) => `${m}\n`).join(''))
		const r = spawnSync(
			'bash',
			[
				'-c',
				`set -e; ${bindLinkGuardShell(`-f '${join(wd, 'docker-compose.yml')}'`, 'lantern', wd, apps)} && echo PASSED`,
			],
			{ env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
		)
		const out = r.stdout.toString() + r.stderr.toString()
		return { ok: r.status === 0 && out.includes('PASSED'), out }
	}
	const ctx = (c: string, extra: Record<string, unknown> = {}) => ({
		image: 'lantern-side',
		build: { context: c, dockerfile: 'Dockerfile', ...extra },
	})

	it('variant a: a sibling build context inside a writable bind of the app is refused', () => {
		const r = guard({
			lantern: { image: 'lantern', volumes: [bind(join(wd, 'src', 'data'))] },
			side: ctx(join(wd, 'src', 'data', 'sub')),
		})
		expect(r.ok).toBe(false)
		expect(r.out).toContain('the build path')
		expect(r.out).toContain(`inside ${join(wd, 'src', 'data')}`)
	})
	it("variant a: the same context equal to a writable bind, or inside another project's writable bind (any state), is refused", () => {
		expect(
			guard({
				lantern: { image: 'lantern', volumes: [bind(join(wd, 'src', 'data'))] },
				side: ctx(join(wd, 'src', 'data')),
			}).ok,
		).toBe(false)
		expect(guard({ side: ctx(join(wd, 'src', 'data', 'sub')) }, [join(wd, 'src', 'data')]).ok).toBe(
			false,
		)
		// an additional context too
		expect(
			guard(
				{
					side: ctx(join(wd, 'src'), {
						additional_contexts: { extra: join(wd, 'src', 'data', 'sub') },
					}),
				},
				[join(wd, 'src', 'data')],
			).ok,
		).toBe(false)
	})
	it('passes the common shape: context ./src, a writable data bind elsewhere, a read-only bind over the context', () => {
		const r = guard({
			lantern: {
				image: 'lantern',
				volumes: [bind(join(wd, 'data')), bind(join(wd, 'src', 'public'), true)],
				build: { context: join(wd, 'src'), dockerfile: 'Dockerfile' },
			},
		})
		expect(r.out).not.toContain('refusing')
		expect(r.ok).toBe(true)
	})
	it('a writable bind strictly inside a build context is refused (this config or another project, any state); read-only passes', () => {
		const r = guard({
			lantern: {
				image: 'lantern',
				volumes: [bind(join(wd, 'src', 'data'))],
				build: { context: join(wd, 'src'), dockerfile: 'Dockerfile' },
			},
		})
		expect(r.ok).toBe(false)
		expect(r.out).toContain(`the writable bind ${join(wd, 'src', 'data')}`)
		expect(r.out).toContain(`inside the build path ${join(wd, 'src')}`)
		expect(
			guard(
				{
					lantern: {
						image: 'lantern',
						build: { context: join(wd, 'src'), dockerfile: 'Dockerfile' },
					},
				},
				[join(wd, 'src', 'data', 'sub')],
			).ok,
		).toBe(false)
		// an additional context too
		expect(
			guard({ side: ctx(join(wd, 'data'), { additional_contexts: { extra: join(wd, 'src') } }) }, [
				join(wd, 'src', 'data'),
			]).ok,
		).toBe(false)
		const ro = guard({
			lantern: {
				image: 'lantern',
				volumes: [bind(join(wd, 'src', 'data'), true)],
				build: { context: join(wd, 'src'), dockerfile: 'Dockerfile' },
			},
		})
		expect(ro.out).not.toContain('refusing')
		expect(ro.ok).toBe(true)
	})
	it("the /new layout passes: context = the app dir with writable pgdata / kvdata (powder's protected .dockerignore); anything else there, or pgdata in a sub-context, is refused", () => {
		const newApp = {
			lantern: { image: 'lantern', build: { context: wd, dockerfile: 'src/Dockerfile' } },
			db: { image: 'postgres:17', volumes: [bind(join(wd, 'pgdata'))] },
			kv: { image: 'redis:7', volumes: [bind(join(wd, 'kvdata'))] },
		}
		const ign = join(wd, '.dockerignore')
		// no .dockerignore of powder's: refused
		expect(guard(newApp).ok).toBe(false)
		// powder's file (protected entries last): passes
		writeFileSync(
			ign,
			'# Written by powder\n.deploy-key\ndocker-compose.yml\npgdata/\nkvdata/\n*.env\n.env*\n.git\n.powder-*\n',
		)
		try {
			const r = guard(newApp)
			expect(r.out).not.toContain('refusing')
			expect(r.ok).toBe(true)
			// a later !negation re-includes the data: refused
			writeFileSync(ign, 'pgdata/\nkvdata/\n!pgdata/x\n')
			expect(guard(newApp).ok).toBe(false)
			// the ignore file as a link: refused
			rmSync(ign)
			writeFileSync(join(wd, 'ign.real'), 'pgdata/\nkvdata/\n')
			symlinkSync('ign.real', ign)
			expect(guard(newApp).ok).toBe(false)
		} finally {
			rmSync(ign, { force: true })
			rmSync(join(wd, 'ign.real'), { force: true })
		}
		expect(
			guard({
				lantern: { image: 'lantern', build: { context: wd, dockerfile: 'src/Dockerfile' } },
				db: { image: 'postgres:17', volumes: [bind(join(wd, 'uploads'))] },
			}).ok,
		).toBe(false)
		expect(
			guard({
				lantern: {
					image: 'lantern',
					build: { context: join(wd, 'src'), dockerfile: 'Dockerfile' },
				},
				db: { image: 'postgres:17', volumes: [bind(join(wd, 'src', 'pgdata'))] },
			}).ok,
		).toBe(false)
	})
	it('src/ layout: a sibling or additional context that is the app dir is refused, even with a valid .dockerignore and the pgdata bind', () => {
		mkdirSync(join(wd, 'src', '.git'))
		writeFileSync(join(wd, '.dockerignore'), 'pgdata/\nkvdata/\n')
		try {
			const r = guard({
				lantern: {
					image: 'lantern',
					build: {
						context: join(wd, 'src'),
						dockerfile: 'Dockerfile',
						additional_contexts: { x: wd },
					},
				},
				db: { image: 'postgres:16', volumes: [bind(join(wd, 'pgdata'))] },
			})
			expect(r.ok).toBe(false)
			expect(r.out).toContain(`the build path ${wd} is the app dir itself`)
			expect(guard({ side: ctx(wd) }).ok).toBe(false)
			// the standard src/ shape still passes
			expect(
				guard({
					lantern: {
						image: 'lantern',
						build: { context: join(wd, 'src'), dockerfile: 'Dockerfile' },
					},
					db: { image: 'postgres:16', volumes: [bind(join(wd, 'pgdata'))] },
				}).ok,
			).toBe(true)
		} finally {
			rmSync(join(wd, 'src', '.git'), { recursive: true })
			rmSync(join(wd, '.dockerignore'))
		}
	})
	it('variant b: a tracked link to data/c with a planted second hop (data/c -> ../real2) is refused', () => {
		symlinkSync('data/c', join(wd, 'src', 'ctx2'))
		symlinkSync('../real2', join(wd, 'src', 'data', 'c'))
		try {
			const r = guard({
				lantern: { image: 'lantern', volumes: [bind(join(wd, 'src', 'data'))] },
				side: ctx(join(wd, 'src', 'ctx2')),
			})
			expect(r.ok).toBe(false)
			expect(r.out).toContain(`symlink ${join(wd, 'src', 'data', 'c')}`)
			// the bind held by another project's container (any state): same refusal
			expect(guard({ side: ctx(join(wd, 'src', 'ctx2')) }, [join(wd, 'src', 'data')]).ok).toBe(
				false,
			)
		} finally {
			rmSync(join(wd, 'src', 'ctx2'))
			rmSync(join(wd, 'src', 'data', 'c'))
		}
	})
	it('variant b: the tracked link to a real folder inside the writable bind is refused too (checked on the resolved path)', () => {
		mkdirSync(join(wd, 'src', 'data', 'c'))
		symlinkSync('data/c', join(wd, 'src', 'ctx2'))
		try {
			expect(
				guard({
					lantern: { image: 'lantern', volumes: [bind(join(wd, 'src', 'data'))] },
					side: ctx(join(wd, 'src', 'ctx2')),
				}).ok,
			).toBe(false)
		} finally {
			rmSync(join(wd, 'src', 'ctx2'))
			rmSync(join(wd, 'src', 'data', 'c'), { recursive: true })
		}
	})
	it('a tracked chain of in-repo links outside every writable bind still passes; one that leaves the app does not', () => {
		const r = guard({
			lantern: {
				image: 'lantern',
				volumes: [bind(join(wd, 'data'))],
				build: { context: join(wd, 'src'), dockerfile: 'Dockerfile.chain' },
			},
		})
		expect(r.out).not.toContain('refusing')
		expect(r.ok).toBe(true)
		symlinkSync('../../..', join(wd, 'src', 'docker', 'up'))
		try {
			expect(guard({ side: ctx(join(wd, 'src', 'docker', 'up')) }).ok).toBe(false)
		} finally {
			rmSync(join(wd, 'src', 'docker', 'up'))
		}
	})
})

describe('build path pins and the missing Dockerfile (Dockerfile check shell)', () => {
	let root: string
	let wd: string
	let bin: string
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'pin-')))
		wd = join(root, 'apps', 'lantern')
		mkdirSync(join(wd, 'src', 'real'), { recursive: true })
		mkdirSync(join(wd, 'src', 'assets'), { recursive: true })
		writeFileSync(join(wd, 'src', 'real', 'Dockerfile'), 'FROM scratch\n')
		symlinkSync('real', join(wd, 'src', 'ctx'))
		bin = join(root, 'bin')
		mkdirSync(bin)
		// docker: `compose ... config` prints the YAML fixture, everything else answers empty.
		writeFakeDocker(bin, `#!/bin/sh\ncase "$1" in compose) cat ${JSON.stringify(join(root, 'cfg.yml'))}; exit 0;; esac\nexit 1\n`)
	})
	afterAll(() => rmSync(root, { recursive: true, force: true }))

	const run = (yml: string, after = '') => {
		writeFileSync(join(root, 'cfg.yml'), yml)
		const dir = mkdtempSync(join(root, 'dfr-'))
		const sh = `set -e; DFR_DIR=${dir}; DFR_NS=0123456789abcdef0123; DFR_APP=lantern; DFR_MODE=enforce; DFR_PULL=0; DFR_OWN="lantern"; DFR_OWNED=lantern; DFR_FOREIGN=; DFR_OTHERS=; DFR_SELF=lantern; DFR_LOGIN=; DFR_PROV_FILE=/dev/null; CP_PROJ=lantern; ${dockerfileRewriteFunctions('lantern')}${composeDockerfileRewriteShell('-f x.yml', (f) => `true ${f}`)}echo DFR_OK; ${after}`
		const r = spawnSync('bash', ['-c', sh], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		})
		return { out: r.stdout.toString() + r.stderr.toString(), status: r.status, dir }
	}
	const svc = (name: string, context: string, extra = '') =>
		`  ${name}:\n    build:\n      context: ${context}\n      dockerfile: Dockerfile\n${extra}    image: ${name}\n`

	it('pins build.context and every absolute additional context to the resolved path in the override', () => {
		const r = run(
			`name: lantern\nservices:\n${svc('lantern', join(wd, 'src', 'ctx'), `      additional_contexts:\n        assets: ${join(wd, 'src', 'assets')}\n        base: docker-image://alpine\n`)}`,
		)
		expect(r.out).toContain('DFR_OK')
		const ov = readFileSync(join(r.dir, 'override.yml'), 'utf8')
		expect(ov).toContain(`      context: ${join(wd, 'src', 'real')}\n`)
		expect(ov).toContain(
			`      additional_contexts:\n        assets: ${join(wd, 'src', 'assets')}\n`,
		)
		expect(ov).not.toContain('docker-image')
		expect(readFileSync(join(r.dir, 'pins'), 'utf8')).toBe(
			`${join(wd, 'src', 'ctx')}\t${join(wd, 'src', 'real')}\n${join(wd, 'src', 'assets')}\t${join(wd, 'src', 'assets')}\n`,
		)
	})
	it('dfr_pinchk passes while the paths hold and refuses once a checked path resolves elsewhere', () => {
		const ok = run(
			`name: lantern\nservices:\n${svc('lantern', join(wd, 'src', 'ctx'))}`,
			'dfr_pinchk && echo PIN_OK',
		)
		expect(ok.out).toContain('PIN_OK')
		mkdirSync(join(wd, 'src', 'other'), { recursive: true })
		const moved = run(
			`name: lantern\nservices:\n${svc('lantern', join(wd, 'src', 'ctx'))}`,
			`rm ${join(wd, 'src', 'ctx')} && ln -s other ${join(wd, 'src', 'ctx')} && { dfr_pinchk && echo PIN_OK || echo PIN_REFUSED; }; rm ${join(wd, 'src', 'ctx')}; ln -s real ${join(wd, 'src', 'ctx')}`,
		)
		expect(moved.out).toContain('PIN_REFUSED')
		expect(moved.out).toContain(
			`the build path ${join(wd, 'src', 'ctx')} resolved to ${join(wd, 'src', 'real')}`,
		)
	})
	it('a sibling build service with no Dockerfile refuses the deploy (fail closed)', () => {
		const r = run(
			`name: lantern\nservices:\n${svc('lantern', join(wd, 'src', 'ctx'))}${svc('worker', join(wd, 'src', 'assets'))}`,
		)
		expect(r.status).not.toBe(0)
		expect(r.out).not.toContain('DFR_OK')
		expect(r.out).toContain('refusing: service worker has no Dockerfile')
	})
	it('a Dockerfile that is a folder refuses too', () => {
		mkdirSync(join(wd, 'src', 'assets', 'Dockerfile'), { recursive: true })
		try {
			const r = run(`name: lantern\nservices:\n${svc('worker', join(wd, 'src', 'assets'))}`)
			expect(r.status).not.toBe(0)
			expect(r.out).toContain('not a regular file')
		} finally {
			rmSync(join(wd, 'src', 'assets', 'Dockerfile'), { recursive: true })
		}
	})
})

describe('build path pin wiring and target-link sources', () => {
	const script = buildDeployScript({
		workingDir: '/opt/apps/lantern',
		configFile: '/opt/apps/lantern/docker-compose.yml',
		service: 'lantern',
		cf: '-f /opt/apps/lantern/docker-compose.yml',
		declaredMode: 'auto',
		prebuilt: false,
		stageImage: null,
		infra: [],
		wantBranch: null,
		wantSha: null,
		shaIsStrict: false,
		composeGuardEnforce: true,
	})
	it('el_guard re-verifies the pins; the deployed and every sibling build run el_guard right before compose build', () => {
		expect(script).toContain('dfr_pinchk || exit 1; }; ')
		// the main build runs as pb_build under font_retry, right after el_guard
		expect(script).toContain('el_guard &&   font_retry pb_build; ')
		const main = script.indexOf(`pb_build() { flock -w "$(left 300)" ${buildLockShell()}`)
		expect(main).toBeGreaterThan(0)
		expect(script.indexOf('el_guard &&   font_retry pb_build; ')).toBeGreaterThan(main)
		expect(script.slice(main, main + 600)).toContain(
			"docker compose -f /opt/apps/lantern/docker-compose.yml $DFR_F $LB_F $STAGE_F build 'lantern'",
		)
		const side = script.indexOf(`if el_guard && flock -w "$(left 300)" ${buildLockShell()}`)
		expect(side).toBeGreaterThan(0)
		expect(script.slice(side, side + 600)).toContain(
			'docker compose -f /opt/apps/lantern/docker-compose.yml $DFR_F $LB_F build "$LB_S"',
		)
		expect(script).toContain('TG_DIR=$(dfr_pinned "$TG_DIR")')
	})
	it('targetLinkSourcesShell and the target-commit compose read count build paths (C lines)', () => {
		const s = targetLinkSourcesShell('-f /opt/apps/lantern/docker-compose.yml')
		expect(s).toContain("sed -n 's/^[BCSO] //p'")
		expect(s).not.toContain("sed -n 's/^[BSO] //p'")
	})
	it('rule (i): a sync may not turn a build context of the current compose into a link', () => {
		const GIT_ENV = {
			...process.env,
			GIT_AUTHOR_NAME: 't',
			GIT_AUTHOR_EMAIL: 't@t',
			GIT_COMMITTER_NAME: 't',
			GIT_COMMITTER_EMAIL: 't@t',
		}
		const git = (dir: string, ...a: string[]) =>
			execFileSync('git', ['-C', dir, ...a], { env: GIT_ENV, stdio: 'pipe' })
				.toString()
				.trim()
		const top = realpathSync(mkdtempSync(join(tmpdir(), 'tl-')))
		const w = join(top, 'lantern')
		mkdirSync(join(w, 'web'), { recursive: true })
		mkdirSync(join(w, 'lib'), { recursive: true })
		writeFileSync(join(w, 'web', 'Dockerfile'), 'FROM scratch\n')
		writeFileSync(join(w, 'lib', 'Dockerfile'), 'FROM scratch\n')
		writeFileSync(
			join(w, 'docker-compose.yml'),
			'services:\n  lantern:\n    image: lantern\n    build:\n      context: ./web\n',
		)
		git(w, 'init', '-q', '-b', 'main')
		git(w, 'add', '-A')
		git(w, 'commit', '-q', '-m', 'a')
		const base = git(w, 'rev-parse', 'HEAD')
		rmSync(join(w, 'web'), { recursive: true })
		symlinkSync('lib', join(w, 'web'))
		git(w, 'add', '-A')
		git(w, 'commit', '-q', '-m', 'b')
		const target = git(w, 'rev-parse', 'HEAD')
		git(w, 'checkout', '-q', '-f', base)
		// docker: no containers, no volumes; `compose config` prints this compose as JSON.
		const bin = join(top, 'bin')
		mkdirSync(bin)
		const cfgJson = JSON.stringify(
			{
				name: 'lantern',
				services: {
					lantern: {
						image: 'lantern',
						build: { context: join(w, 'web'), dockerfile: 'Dockerfile' },
					},
				},
			},
			null,
			2,
		)
		writeFileSync(join(top, 'cfg.json'), cfgJson)
		writeFakeDocker(bin, `#!/bin/sh\ncase "$1" in compose) cat ${JSON.stringify(join(top, 'cfg.json'))}; exit 0;; esac\nexit 0\n`)
		const srcs = targetLinkSourcesShell(`-f ${join(w, 'docker-compose.yml')}`)
		const sh = targetLinkGuardShell({ dir: w, target, binds: true })
		const r = spawnSync(
			'bash',
			['-c', `${gitHardenShellFunctions()}${srcs}${sh} && echo CHECK_PASSED`],
			{
				encoding: 'utf8',
				env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` },
			},
		)
		expect(r.stdout).not.toContain('CHECK_PASSED')
		expect(r.stdout + r.stderr).toContain('replaces the mount source web')
		rmSync(top, { recursive: true, force: true })
	})
})

describe('the compose rule build_bind (TS twin of the on-server check)', () => {
	const wd = '/opt/apps/lantern'
	const check = (
		volumes: unknown[],
		build: unknown = { context: './src', dockerfile: 'Dockerfile' },
	) =>
		composeViolations(
			{ name: 'lantern', services: { lantern: { image: 'lantern', build, volumes } } },
			{
				appName: 'lantern',
				workingDir: wd,
				projectDir: wd,
				protectedPaths: [`${wd}/docker-compose.yml`, `${wd}/.deploy-key`, `${wd}/src/.git`],
				otherApps: [],
			} as unknown as Parameters<typeof composeViolations>[1],
		).filter((v) => v.code === 'build_bind')
	it('refuses a writable bind inside the context or an additional context, never exemptable', () => {
		const v = check(['./src/data:/data'])
		expect(v).toHaveLength(1)
		expect(v[0]?.value).toBe(`${wd}/src/data`)
		const first = v[0]
		if (!first) throw new Error('no finding')
		expect(
			neverExemptable(first, { appName: 'lantern' } as unknown as Parameters<
				typeof neverExemptable
			>[1]),
		).toBe(true)
		expect(check([{ type: 'bind', source: `${wd}/src/data`, target: '/d' }])).toHaveLength(1)
		expect(
			check(['./assets/up:/up'], { context: './src', additional_contexts: { assets: './assets' } }),
		).toHaveLength(1)
	})
	it('the /new layout: pgdata / kvdata right in a context that is the app dir pass, elsewhere in a context they do not', () => {
		expect(
			check(['./pgdata:/var/lib/postgresql/data', `${wd}/kvdata:/data`], {
				context: '.',
				dockerfile: 'Dockerfile',
			}),
		).toHaveLength(0)
		expect(check(['./uploads:/u'], { context: '.', dockerfile: 'Dockerfile' })).toHaveLength(1)
		expect(check(['./src/pgdata:/d'])).toHaveLength(1)
	})
	it('src/ layout: a build path that is the app dir is a build_bind finding; the pgdata exception does not apply', () => {
		const v = check(['./pgdata:/var/lib/postgresql/data'], {
			context: './src',
			additional_contexts: { x: '.' },
		})
		expect(v.map((x) => x.value)).toContain(wd)
		expect(v.map((x) => x.value)).toContain(`${wd}/pgdata`)
		expect(
			check([], { context: './src', additional_contexts: { x: '.' } }).map((x) => x.value),
		).toEqual([wd])
	})
	it('passes read-only binds inside, writable binds outside, and the build short form', () => {
		expect(
			check([
				'./src/data:/data:ro',
				{ type: 'bind', source: './src/x', target: '/x', read_only: true },
			]),
		).toHaveLength(0)
		expect(check(['./data:/data', '/opt/apps/lantern-uploads:/u'])).toHaveLength(0)
		expect(check(['./data:/data'], './src')).toHaveLength(0)
		expect(check(['./src/data:/data'], './src')).toHaveLength(1)
	})
})
