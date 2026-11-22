import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { protectExistingIgnoreShell } from '../app-runtime-files'
import {
	cacheNamespace,
	composeDockerfileRewriteShell,
	dockerfileRewriteFunctions,
	OS_PATCH_WEEK_SH,
	osPatchWeek,
	rewrittenCacheId,
	runNamespaceArgName,
	withOsPatchWeek,
} from '../build-cache'
import { buildBuilderScript } from '../builder'
import { buildDeployScript } from '../deploy/script'
import { dockerfileFor } from '../framework-detect'
import { writeFakeDocker } from './fixtures/fake-docker'

// BuildKit shares cache mounts by id across every build on a daemon. Every
// Dockerfile powder builds gets its cache mounts rewritten to per-app salted ids.

const NS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const root = mkdtempSync(join(tmpdir(), 'bc-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// Stub docker: `image inspect` answers RepoDigests counts from $IMGS ("ref=n,ref=n").
const bin = join(root, 'bin')
mkdirSync(bin)
writeFakeDocker(bin, `#!/bin/bash
# the base image ONBUILD check (dfr_bases): no triggers
if [[ "$*" == *".Config.OnBuild"* ]]; then echo 0; exit 0; fi
# image IDs and configs for the provenance check (dfr_prov)
if [[ "$*" == *"{{.Id}}"* ]]; then echo "sha256:$(printf %s "\${@: -1}" | cksum | cut -d" " -f1)"; exit 0; fi
if [[ "$*" == *"{{json .Config}}"* ]]; then echo "{}"; exit 0; fi
if [[ "$*" == *"range .RepoDigests"* ]]; then r="\${@: -1}"; r="\${r%%@*}"; case "\${r##*/}" in *:*) r="\${r%:*}";; esac; echo "$r@sha256:0000000000000000000000000000000000000000000000000000000000000000"; exit 0; fi
if [ "$1 $2" = "image inspect" ]; then ref="\${@: -1}"; IFS=',' read -ra kv <<< "$IMGS"; for p in "\${kv[@]}"; do if [ "\${p%=*}" = "$ref" ]; then echo "\${p##*=}"; exit 0; fi; done; exit 1; fi
if [[ "$*" == *" config" ]]; then cat "$CFG"; exit 0; fi
exit 0
`)

let n = 0
function rewrite(dockerfile: string, env: Record<string, string> = {}, app = 'shop') {
	const dir = join(root, `c${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), dockerfile)
	const script = `DFR_NS=${env.NS ?? NS}; DFR_APP=${app}; DFR_DIR=$(mktemp -d); DFR_MODE=${env.MODE ?? 'enforce'}; DFR_PULL=${env.PULL ?? '0'}; DFR_OWN=${JSON.stringify(env.OWN ?? '')}; DFR_OWNED=${JSON.stringify(env.OWNED ?? '*')}; ${dockerfileRewriteFunctions(app)}dfr_one ${JSON.stringify(join(dir, 'Dockerfile'))} ${JSON.stringify(join(dir, 'out'))}`
	const r = spawnSync('bash', ['-c', script], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, IMGS: env.IMGS ?? '' },
	})
	const out = existsSync(join(dir, 'out')) ? readFileSync(join(dir, 'out'), 'utf8') : ''
	return { code: r.status, log: r.stdout + r.stderr, out }
}

const id = (key: string, app = 'shop') => `id=${rewrittenCacheId(NS, app, key)}`

describe('cache mount rewrite (server-side awk)', () => {
	it('gives a mount without an id its own salted id, keyed by the target', () => {
		const r = rewrite('FROM node:22\nRUN --mount=type=cache,target=/root/.npm npm ci\n')
		expect(r.code).toBe(0)
		expect(r.out).toContain(`RUN --mount=type=cache,${id('/root/.npm')},target=/root/.npm npm ci`)
	})

	it('replaces a repo-chosen id (another app could pick the same one)', () => {
		const r = rewrite(
			'FROM node:22\nRUN --mount=type=cache,target=/root/.npm,id=victim-npm npm ci\n',
		)
		expect(r.code).toBe(0)
		expect(r.out).not.toContain('victim-npm')
		expect(r.out).toContain(`--mount=type=cache,${id('victim-npm')},target=/root/.npm npm ci`)
	})

	it('two apps naming the same cache get different ids; one app keeps a stable id', () => {
		const a = rewrite('FROM x\nRUN --mount=type=cache,target=/root/.npm true\n', {}, 'shop')
		const b = rewrite('FROM x\nRUN --mount=type=cache,target=/root/.npm true\n', {}, 'blog')
		const a2 = rewrite('FROM x\nRUN --mount=type=cache,target=/root/.npm true\n', {}, 'shop')
		expect(a.out).not.toBe(b.out)
		expect(a.out).toBe(a2.out)
		expect(cacheNamespace('salt', 's1', 'shop')).not.toBe(cacheNamespace('salt', 's1', 'blog'))
		expect(cacheNamespace('salt', 's1', 'shop')).not.toBe(cacheNamespace('salt', 's2', 'shop'))
	})

	it('rewrites multi-line RUN flags and heredoc forms, leaves secret mounts alone', () => {
		const df = [
			'# syntax=docker/dockerfile:1.7',
			'FROM node:22 AS deps',
			'RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \\',
			'    --mount=type=secret,id=envfile,target=/app/.env.local,mode=0400 \\',
			'    --mount=type=cache,target=/app/.next/cache \\',
			'    pnpm build',
			'RUN --mount=type=cache,target=/x <<EOF',
			'echo hi',
			'EOF',
			'',
		].join('\n')
		const r = rewrite(df)
		expect(r.code).toBe(0)
		expect(r.out).toContain(
			`--mount=type=cache,${id('pnpm-store')},target=/root/.local/share/pnpm/store \\`,
		)
		expect(r.out).toContain('--mount=type=secret,id=envfile,target=/app/.env.local,mode=0400 \\')
		expect(r.out).toContain(
			`--mount=type=cache,${id('/app/.next/cache')},target=/app/.next/cache \\`,
		)
		expect(r.out).toContain(`RUN --mount=type=cache,${id('/x')},target=/x <<EOF\necho hi\nEOF`)
		expect(r.log).toContain('3 cache mount(s)')
	})

	it("rewrites powder's own generated Dockerfiles too (their ids were guessable)", () => {
		const gen = dockerfileFor({ id: 'next', defaultContainerPort: 3000 } as never, 'pnpm', 'shop')
		const r = rewrite(gen)
		expect(r.code).toBe(0)
		expect(r.out).not.toMatch(/id=shop-(pnpm-store|next-cache)/)
		expect(r.out).toContain(id('shop-pnpm-store'))
	})

	it('refuses what it cannot rewrite safely', () => {
		expect(rewrite('FROM x\nRUN --mount="type=cache,target=/x" true\n').code).not.toBe(0)
		expect(rewrite('FROM x\nRUN --mount=type=$T,id=victim,target=/x true\n').code).not.toBe(0)
		// the id would be joined onto the flag by the line continuation
		const split1 = rewrite('FROM x\nRUN --mount=type=cache,\\\nid=victim,target=/x true\n')
		expect(split1.code).not.toBe(0)
		expect(split1.log).toContain('continued over a line break')
		const split2 = rewrite('FROM x\nRUN --mo\\\nunt=type=cache,id=victim,target=/x true\n')
		expect(split2.code).not.toBe(0)
		expect(split2.log).toContain('split over a line continuation')
		expect(
			rewrite('# escape=`\nFROM x\nRUN --mo`\nunt=type=cache,id=victim,target=/x true\n').code,
		).not.toBe(0)
	})
})

describe('comments and shell text are not flags', () => {
	it('a comment ending in a backtick next to --mount= text passes (an Expo app Dockerfile header)', () => {
		const df = [
			'# EXPO_PUBLIC_* values are inlined into the static bundle at build time',
			'# (read while `expo export` runs). The secret mount in `--mount=type=secret`',
			'# exposes .env.local to the builder stage only; runtime env comes too late',
			'# for them. Build with:',
			'#',
			'#   DOCKER_BUILDKIT=1 docker build \\',
			'#     --secret id=envfile,src=/srv/app/.env.local \\',
			'#     -t web:latest .',
			'',
			'FROM node:22-alpine AS deps',
			'RUN --mount=type=secret,id=envfile,target=/app/.env.local,mode=0400 yarn build',
			'',
		].join('\n')
		for (const MODE of ['enforce', 'warn']) {
			const r = rewrite(df, { MODE, PULL: '1' })
			expect(r.code, r.log).toBe(0)
			// the only changes are the per-app namespace ARG after the FROM and
			// the base image pin token dfr_bases replaces
			expect(r.out).toBe(df.replace('FROM node:22-alpine AS deps\n', `FROM __POWDER_BASE_1__ AS deps\nARG ${runNamespaceArgName(NS)}=1\n`))
		}
	})

	it('comments are never refused or rewritten, also inside a continuation', () => {
		const df =
			'FROM x\n# RUN --mount="type=cache,id=x" `\nRUN --mount=type=cache,target=/a \\\n    # --mount=type=$T,id=v \\\n    true\n'
		const r = rewrite(df)
		expect(r.code, r.log).toBe(0)
		expect(r.out).toContain('# RUN --mount="type=cache,id=x" `')
		expect(r.out).toContain('# --mount=type=$T,id=v \\')
		expect(r.out).toContain(id('/a'))
	})

	it('backticks and backslashes in a --mount spec; escape=` is refused', () => {
		// a backtick or backslash inside a --mount spec is refused whatever the
		// escape directive says (the frontend version decides which one BuildKit drops)
		expect(rewrite('FROM x\nRUN --mount=type=cache,target=/a` true\n').code).not.toBe(0)
		expect(rewrite('# escape=`\nFROM x\nRUN --mount=type=cache,target=/a\\ true\n').code).not.toBe(
			0,
		)
		// escape=` itself is refused now (the escape char is always \)
		expect(
			rewrite('# escape=`\nFROM x\nRUN --mount=type=cache,target=/a `\n  true\n').code,
		).not.toBe(0)
		expect(
			rewrite('# escape=`\nFROM x\nRUN --mount=type=cache,`\nid=victim,target=/x true\n').code,
		).not.toBe(0)
	})

	it('--mount= text in the command is shell text: no refusal, a cache spec still gets its own id', () => {
		const r = rewrite(
			'FROM x\nRUN echo "--mount=type=$T,id=x" && echo \'--mount=type=secret,id=a\'\n',
		)
		expect(r.code, r.log).toBe(0)
		const q = rewrite('FROM x\nRUN echo "--mount=type=cache,id=victim,target=/x"\n')
		expect(q.code, q.log).toBe(0)
		expect(q.out).not.toContain('id=victim')
		// a quoted RUN flag (BuildKit unquotes it) is still refused
		expect(rewrite('FROM x\nRUN --mount="type=cache,id=victim,target=/x" true\n').code).not.toBe(0)
		// ONBUILD RUN flags are flags too
		expect(rewrite('FROM x\nONBUILD RUN --mount="type=cache,id=v,target=/x" true\n').code).not.toBe(
			0,
		)
	})
})

describe("images the Dockerfile reads (another app's local build)", () => {
	const df =
		'ARG BASE=node:22\nFROM ${BASE} AS b\nCOPY --from=blog:latest /app /app\nRUN --mount=type=bind,from=api,target=/s true\nFROM b\n'
	const imgs = 'node:22=1,blog:latest=0,api=0,shop:latest=0'

	it('enforce + pull off: refuses a local-only image of another app (FROM, COPY --from, mount from=)', () => {
		const r = rewrite(df, { IMGS: imgs })
		expect(r.code).not.toBe(0)
		expect(r.log).toContain('reads the local image blog:latest')
		expect(r.log).toContain('reads the local image api')
		expect(r.log).not.toContain('node:22,')
	})
	it('warn mode logs a compose-guard WARN and builds', () => {
		const r = rewrite(df, { IMGS: imgs, MODE: 'warn' })
		expect(r.code).toBe(0)
		expect(r.log).toContain('[compose-guard] WARN shop dockerfile_image')
	})
	// the check runs whatever the pull mode (a build that skips --pull, or a
	// sibling build, would read the local image); registry images and own images pass.
	it('pull on: the local-image check still runs; registry and own images pass', () => {
		const r = rewrite(df, { IMGS: imgs, PULL: '1' })
		expect(r.code).not.toBe(0)
		expect(r.log).toContain('reads the local image blog:latest')
		expect(rewrite(df, { IMGS: imgs, PULL: '1', MODE: 'warn' }).code).toBe(0)
		expect(
			rewrite('FROM node:22\nCOPY --from=redis:7 /x /x\n', {
				IMGS: 'node:22=1,redis:7=2',
				PULL: '1',
			}).code,
		).toBe(0)
		expect(
			rewrite('FROM shop:deploy-1\n', { IMGS: 'shop:deploy-1=0', OWN: 'shop:latest', PULL: '1' })
				.code,
		).toBe(0)
		// first deploy: nothing local yet
		expect(rewrite('FROM shop:deploy-1\n', { IMGS: '', OWN: 'shop:latest', PULL: '1' }).code).toBe(
			0,
		)
	})
	it("the app's own images are fine", () => {
		expect(
			rewrite('FROM shop:deploy-1\n', { IMGS: 'shop:deploy-1=0', OWN: 'shop:latest' }).code,
		).toBe(0)
		expect(rewrite('FROM shop:deploy-1\n', { IMGS: 'shop:deploy-1=0' }).code).not.toBe(0)
	})
})

describe('wiring', () => {
	it('compose path: every service with a build section gets a rewritten Dockerfile via the override', () => {
		const dir = join(root, 'compose')
		mkdirSync(join(dir, 'src', 'worker'), { recursive: true })
		writeFileSync(join(dir, 'src', 'Dockerfile'), 'FROM x\nRUN --mount=type=cache,target=/a true\n')
		writeFileSync(
			join(dir, 'src', 'worker', 'Dockerfile'),
			'FROM x\nRUN --mount=type=cache,id=other-app,target=/b true\n',
		)
		writeFileSync(join(dir, 'src', 'Dockerfile.dockerignore'), '!.deploy-key\n')
		const cfg = join(root, 'cfg.yml')
		writeFileSync(
			cfg,
			`name: shop\nservices:\n  app:\n    build:\n      context: ${dir}/src\n      dockerfile: Dockerfile\n    image: shop:latest\n  worker:\n    build:\n      context: ${dir}/src/worker\n      dockerfile: Dockerfile\n  db:\n    image: postgres:16\n`,
		)
		const script = `set -e; DFR_NS=${NS}; DFR_APP=shop; DFR_DIR=$(mktemp -d); DFR_MODE=enforce; DFR_PULL=1; DFR_OWN=""; CP_PROJ=shop; ${dockerfileRewriteFunctions('shop')}${composeDockerfileRewriteShell("-f 'x.yml'", protectExistingIgnoreShell)}cat "$DFR_DIR/override.yml"; echo "F=$DFR_F"; cat "$DFR_DIR"/1.Dockerfile "$DFR_DIR"/2.Dockerfile "$DFR_DIR"/1.Dockerfile.dockerignore`
		const r = spawnSync('bash', ['-c', script], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CFG: cfg },
		})
		expect(r.status).toBe(0)
		expect(r.stdout).toMatch(
			// each service's build.context is pinned to its resolved path too
			// and carries this week's OS_PATCH_WEEK build arg
			/services:\n {2}app:\n {4}build:\n {6}dockerfile: \/.*\/1\.Dockerfile\n {6}args:\n {8}OS_PATCH_WEEK: "\d{4}-W\d{2}"\n {6}context: \/.*\/src\n {2}worker:\n {4}build:\n {6}dockerfile: \/.*\/2\.Dockerfile\n {6}args:\n {8}OS_PATCH_WEEK: "\d{4}-W\d{2}"\n {6}context: \/.*\/src\/worker\n/,
		)
		expect(r.stdout).toMatch(/F=-f \/.*\/override\.yml/)
		expect(r.stdout).toContain(id('/a'))
		expect(r.stdout).toContain(id('other-app'))
		expect(r.stdout).not.toContain('id=other-app')
		// the repo's <Dockerfile>.dockerignore travels along with powder's entries last
		expect(r.stdout.trimEnd().split('\n').pop()).toBe('.powder-*')
		// the repo's own files are untouched
		expect(readFileSync(join(dir, 'src', 'worker', 'Dockerfile'), 'utf8')).toContain('id=other-app')
	})

	it('deploy script: the check runs before the build and every build/up/run carries the override', () => {
		const s = buildDeployScript({
			workingDir: '/opt/apps/shop',
			configFile: '/opt/apps/shop/docker-compose.yml',
			service: 'app',
			cf: "-f '/opt/apps/shop/docker-compose.yml'",
			declaredMode: 'auto',
			prebuilt: false,
			infra: null,
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
			cacheNamespace: NS,
		})
		expect(s.indexOf('step "dockerfile check"')).toBeGreaterThan(0)
		expect(s.indexOf('step "dockerfile check"')).toBeLessThan(s.indexOf('docker compose build'))
		expect(s).toContain(`DFR_NS='${NS}'`)
		for (const m of s.matchAll(/docker compose ([^|;]*?) (build|up|run) /g))
			expect(m[1]).toContain('$DFR_F')
		// no namespace: a random one is made on the server, never a shared one
		const cold = buildDeployScript({
			workingDir: '/opt/apps/shop',
			configFile: '/opt/apps/shop/docker-compose.yml',
			service: 'app',
			cf: '',
			declaredMode: 'auto',
			prebuilt: false,
			infra: null,
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
		})
		expect(cold).toContain('DFR_NS=$(od -An -N16 -tx1 /dev/urandom')
	})

	it('builder: docker build reads the rewritten copy, not the repo Dockerfile', () => {
		const s = buildBuilderScript({
			dir: '/opt/builds/s-shop',
			keyPath: '/opt/builds/s-shop.k',
			repoUrl: 'git@github.com:o/r.git',
			branch: 'main',
			sha: null,
			image: 'shop:latest',
			uniq: 'shop:latest-b1',
			ctx: '/opt/builds/s-shop/src',
			df: '/opt/builds/s-shop/src/Dockerfile',
			buildArgs: '',
			cacheNamespace: NS,
			app: 'shop',
		})
		expect(s).toContain(`dfr_one '/opt/builds/s-shop/src/Dockerfile' "$DFR_DIR/Dockerfile"`)
		expect(s).toMatch(/docker build [^&]*-f "\$DFR_DIR\/Dockerfile"/)
		expect(s).not.toContain("-f '/opt/builds/s-shop/src/Dockerfile'")
		expect(spawnSync('bash', ['-n', '-c', s]).status).toBe(0)
	})
})

// Pinned or unchanged base images keep an `apt-get upgrade` layer cached forever.
// powder passes OS_PATCH_WEEK=<ISO week> to every build, so a Dockerfile that
// declares the ARG before its upgrade line refreshes that layer once a week.
describe('OS patch week build arg', () => {
	const REPO = join(__dirname, '../../../../..')

	it('osPatchWeek is the ISO 8601 week in UTC', () => {
		expect(osPatchWeek(new Date('2026-11-19T12:00:00Z'))).toBe('2026-W47')
		expect(osPatchWeek(new Date('2026-11-22T23:59:59Z'))).toBe('2026-W47') // Sunday
		expect(osPatchWeek(new Date('2026-11-23T00:00:00Z'))).toBe('2026-W48') // Monday
		expect(osPatchWeek(new Date('2021-01-01T00:00:00Z'))).toBe('2020-W53')
		expect(osPatchWeek(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01')
		expect(osPatchWeek(new Date('2027-01-04T00:00:00Z'))).toBe('2027-W01')
	})

	it('the shell snippet prints the same week as osPatchWeek, and empty when date fails', () => {
		const ok = spawnSync('bash', ['-c', `set -eu; ${OS_PATCH_WEEK_SH}; printf %s "$OS_PATCH_WEEK"`], { encoding: 'utf8' })
		expect(ok.status).toBe(0)
		expect(ok.stdout).toBe(osPatchWeek())
		const noDate = join(root, 'nodate')
		mkdirSync(noDate, { recursive: true })
		writeFileSync(join(noDate, 'date'), '#!/bin/sh\necho garbage; exit 1\n', { mode: 0o755 })
		const bad = spawnSync('bash', ['-c', `set -eu; ${OS_PATCH_WEEK_SH}; printf '[%s]' "$OS_PATCH_WEEK"`], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${noDate}:${process.env.PATH}` },
		})
		expect(bad.status).toBe(0)
		expect(bad.stdout).toBe('[]')
	})

	it('builder path: powder sets the week, over any compose value', () => {
		const d = new Date('2026-11-19T00:00:00Z')
		expect(withOsPatchWeek({ A: '1' }, d)).toEqual({ A: '1', OS_PATCH_WEEK: '2026-W47' })
		expect(withOsPatchWeek({ OS_PATCH_WEEK: 'never' }, d)).toEqual({ OS_PATCH_WEEK: '2026-W47' })
	})

	it('compose path: the Dockerfile check sees the week as a build arg; no week, no arg', () => {
		const dir = join(root, 'patchweek')
		mkdirSync(join(dir, 'src'), { recursive: true })
		// an image ref only the build arg resolves: the check refuses it as unresolved
		// unless it knows the value the build passes
		writeFileSync(join(dir, 'src', 'Dockerfile'), 'ARG OS_PATCH_WEEK\nFROM node:${OS_PATCH_WEEK}\nRUN true\n')
		const cfg = join(root, 'patchweek.yml')
		writeFileSync(cfg, `name: pw\nservices:\n  app:\n    build:\n      context: ${dir}/src\n      dockerfile: Dockerfile\n    image: pw:latest\n`)
		const run = (path: string) =>
			spawnSync(
				'bash',
				['-c', `DFR_NS=${NS}; DFR_APP=pw; DFR_DIR=$(mktemp -d); DFR_MODE=enforce; DFR_PULL=0; DFR_OWN=""; CP_PROJ=pw; ${dockerfileRewriteFunctions('pw')}${composeDockerfileRewriteShell("-f 'x.yml'", protectExistingIgnoreShell)}cat "$DFR_DIR/override.yml"`],
				{ encoding: 'utf8', env: { ...process.env, PATH: path, CFG: cfg, IMGS: `node:${osPatchWeek()}=1` } },
			)
		const withWeek = run(`${bin}:${process.env.PATH}`)
		expect(withWeek.stdout).not.toContain('no ARG default or build arg')
		expect(withWeek.stdout).toContain(`OS_PATCH_WEEK: "${osPatchWeek()}"`)
		const noDate = join(root, 'nodate2')
		mkdirSync(noDate, { recursive: true })
		writeFileSync(join(noDate, 'date'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
		const without = run(`${noDate}:${bin}:${process.env.PATH}`)
		expect(without.stdout).toContain('no ARG default or build arg')
		expect(without.stdout).not.toContain('OS_PATCH_WEEK:')
	})

	it("powder's own build: every OS upgrade layer is keyed on the week, and every self-deploy path passes it", () => {
		const df = readFileSync(join(REPO, 'docker/web.Dockerfile'), 'utf8').split('\n')
		const upgrades = df.flatMap((l, i) => (/\b(apt-get|apk) upgrade\b/.test(l) && !l.startsWith('#') ? [i] : []))
		expect(upgrades.length).toBeGreaterThan(0)
		for (const i of upgrades) {
			expect(df[i]).toContain('${OS_PATCH_WEEK')
			const stageStart = df.slice(0, i).findLastIndex((l) => /^FROM /.test(l))
			expect(df.slice(stageStart, i).some((l) => /^ARG OS_PATCH_WEEK\b/.test(l))).toBe(true)
		}
		for (const f of ['bin/self-deploy.sh', 'bin/install.sh'])
			expect(readFileSync(join(REPO, f), 'utf8')).toContain(`OS_PATCH_WEEK_SH='${OS_PATCH_WEEK_SH}'`)
		const sd = readFileSync(join(REPO, 'bin/self-deploy.sh'), 'utf8')
		expect(sd).toContain('OS_PATCH_WEEK=$OS_PATCH_WEEK $DC build powder')
		expect(sd).toContain('OS_PATCH_WEEK=$OS_PATCH_WEEK $DC build worker')
		expect(readFileSync(join(REPO, 'bin/install.sh'), 'utf8')).toContain('POWDER_BUILD_CACHE_ID|OS_PATCH_WEEK) continue')
	})

	// powder's push gate copies the tree without docker-compose.yml (.powder/test.sh):
	// only this compose check skips there; a full checkout and bin/self-deploy.sh run it.
	const COMPOSE = join(REPO, 'docker-compose.yml')
	it.skipIf(!existsSync(COMPOSE))("powder's own compose file passes the week to both builds", () => {
		const compose = readFileSync(COMPOSE, 'utf8')
		expect(compose.match(/OS_PATCH_WEEK: \$\{OS_PATCH_WEEK:-\}/g)?.length).toBe(2)
	})
})
