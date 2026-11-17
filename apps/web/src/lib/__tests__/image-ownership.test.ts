import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { dockerfileAuthorityShell, dockerfileRewriteFunctions } from '../build-cache'
import { composeViolations, dockerfileImageAuthority, ownedBuildRepos } from '../compose-safety'
import {
	DOCKERFILE_REFS_OK,
	DOCKERFILE_REFS_PROBE,
	deployGuardContext,
	IMAGE_LIST_OK,
	IMAGE_LIST_PROBE,
	FIXED_PROBE_SEP,
	parseComposeProbe,
	parseDockerfileRefsProbe,
	parseImageListProbe,
} from '../deploy/compose-check'
import { serverImageFacts, imageOwnershipRefusal, ownershipRepo } from '../image-ownership'
import { writeFakeDocker } from './fixtures/fake-docker'

// the local image store is a shared trust domain. ONE authority (image-ownership.ts)
// decides whose a repo is: owned by app X iff X's compose builds it and no other compose
// project on the server built or runs it. A name a build writes is refused when another
// project owns it, another app's Dockerfile reads it, or it is a Docker Hub namespace name
// not named after the app; the on-server Dockerfile check exempts only owned repos
// (DFR_OWNED), and a non-own image a build reads must come from powder's own anonymous
// pull (dfr_prov). Invented names only.

const root = mkdtempSync(join(tmpdir(), 'own-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const victimServer = {
	containers: [
		{
			name: 'zorbweb',
			project: 'zorbweb',
			image: 'zorbweb-web:latest',
			state: 'running',
			service: 'web',
		},
		{
			name: 'zorbweb-jobs',
			project: 'zorbweb',
			image: 'quuxco/jobs:latest',
			state: 'running',
			service: 'jobs',
		},
	],
	details: [
		{
			name: 'zorbweb',
			project: 'zorbweb',
			image: 'zorbweb-web:latest',
			imageId: 'sha256:aa',
			ports: [],
		},
		{
			name: 'zorbweb-jobs',
			project: 'zorbweb',
			image: 'quuxco/jobs:latest',
			imageId: 'sha256:bb',
			ports: [],
		},
	],
	imageProjects: {},
}

function ctxFor(input: Record<string, unknown>, app = 'plinkapp') {
	return deployGuardContext({ resolved: {}, raw: null, hash: 'x', ...input } as never, {
		appName: app,
		workingDir: `/opt/apps/${app}`,
		composeFiles: [`/opt/apps/${app}/docker-compose.yml`],
		serverId: null,
		routeHosts: null,
		otherApps: ['zorbweb', 'gritapp'],
	})
}

const doc = (services: Record<string, unknown>) => ({ name: 'plinkapp', services })
const codes = (d: unknown, c = ctxFor(victimServer)) => composeViolations(d, c).map((v) => v.code)

describe('own-name borrowing (another project runs the repo)', () => {
	it('a build tag of a repo another project runs is refused, and the repo is not owned', () => {
		const d = doc({
			plinkapp: { container_name: 'plinkapp', image: 'plinkapp:latest', build: { context: '.' } },
			evil: { image: 'quuxco/jobs:mine', build: { context: '.' } },
		})
		const v = composeViolations(d, ctxFor(victimServer))
		const hit = v.find((x) => x.code === 'image_owner')
		expect(hit?.message).toContain(
			'another compose project on this server built or runs the repository quuxco/jobs (zorbweb)',
		)
		expect(ownedBuildRepos(d, ctxFor(victimServer))).toEqual(['plinkapp'])
		expect(dockerfileImageAuthority(ctxFor(victimServer), d).owned).toEqual(['plinkapp'])
	})
	it('build.tags too, and docker.io / library spellings are the same repo', () => {
		const d = doc({
			plinkapp: {
				container_name: 'plinkapp',
				build: { context: '.', tags: ['docker.io/quuxco/jobs:x'] },
			},
		})
		expect(codes(d)).toContain('image_owner')
	})
	it("a build-only service's labelled image (no container) still has an owner", () => {
		const srv = {
			...victimServer,
			localImages: [{ repos: ['zorbweb-migrate:latest'], project: 'zorbweb' }],
		}
		const d = doc({
			plinkapp: {
				container_name: 'plinkapp',
				image: 'zorbweb-migrate:v2',
				build: { context: '.' },
			},
		})
		expect(codes(d, ctxFor(srv))).toContain('image_owner')
		// a dangling copy keeps its repo through RepoDigests
		const dangling = {
			...victimServer,
			localImages: [{ repos: [`gone/thing@sha256:${'1'.repeat(64)}`], project: 'goneapp' }],
		}
		expect(
			imageOwnershipRefusal(
				'gone/thing:latest',
				{ appName: 'plinkapp', project: 'plinkapp' },
				ctxFor(dangling).serverImages,
			),
		).toContain('(goneapp)')
	})
	it('the own project running its own repo is not a conflict', () => {
		const srv = {
			...victimServer,
			containers: [
				...victimServer.containers,
				{
					name: 'plinkapp',
					project: 'plinkapp',
					image: 'ghcr.io/acmeorg/plinkapp:latest',
					state: 'running',
				},
			],
			details: [
				...victimServer.details,
				{
					name: 'plinkapp',
					project: 'plinkapp',
					image: 'ghcr.io/acmeorg/plinkapp:latest',
					imageId: 'sha256:cc',
					ports: [],
				},
			],
		}
		const d = doc({
			plinkapp: {
				container_name: 'plinkapp',
				image: 'ghcr.io/acmeorg/plinkapp:latest',
				build: { context: '.' },
			},
		})
		expect(codes(d, ctxFor(srv))).toEqual([])
		expect(ownedBuildRepos(d, ctxFor(srv))).toEqual(['ghcr.io/acmeorg/plinkapp'])
	})
	it('never exemptable', () => {
		const c = { ...ctxFor(victimServer), exempt: ['image_owner', 'image'] }
		const d = doc({
			plinkapp: { container_name: 'plinkapp', image: 'quuxco/jobs:mine', build: { context: '.' } },
		})
		expect(composeViolations(d, c).map((v) => v.code)).toContain('image_owner')
	})
})

describe('base shadowing', () => {
	for (const img of [
		'alpine/git:latest',
		'docker.io/alpine/git:latest',
		'oven/bun:1-alpine',
		'index.docker.io/somens/tool:3',
	]) {
		it(`a Docker Hub namespace name is refused: ${img}`, () => {
			const d = doc({
				plinkapp: { container_name: 'plinkapp', build: { context: '.' } },
				tools: { image: img, build: { context: './tools' } },
			})
			expect(codes(d)).toContain('image_owner')
		})
	}
	it('a namespace named after the app passes; a registry host passes', () => {
		for (const img of [
			'plinkapp/tool:1',
			'plinkapp-x/tool:1',
			'ghcr.io/acmeorg/plinkapp-tools:1',
		]) {
			const d = doc({
				plinkapp: { container_name: 'plinkapp', image: img, build: { context: '.' } },
			})
			expect(codes(d), img).toEqual([])
		}
	})
	it("a name another app's Dockerfile reads is refused (the server's base list)", () => {
		const srv = {
			...victimServer,
			dockerfileRefs: [
				{ app: 'zorbweb', ref: 'ghcr.io/acmeorg/basekit:2' },
				{ app: 'plinkapp', ref: 'node:22-alpine' },
			],
		}
		const d = doc({
			plinkapp: {
				container_name: 'plinkapp',
				image: 'ghcr.io/acmeorg/basekit:9',
				build: { context: '.' },
			},
		})
		const v = composeViolations(d, ctxFor(srv))
		expect(v.find((x) => x.code === 'image_owner')?.message).toContain(
			'a Dockerfile of another app on this server reads ghcr.io/acmeorg/basekit as an image (zorbweb)',
		)
		// the app's own Dockerfiles never count
		expect(ctxFor(srv).serverImages?.readers?.node).toEqual(['plinkapp'])
	})
	it("another app naming THIS app's own image in a Dockerfile does not take it away", () => {
		const srv = {
			...victimServer,
			details: [
				...victimServer.details,
				{
					name: 'plinkapp',
					project: 'plinkapp',
					image: 'ghcr.io/acmeorg/plinkimg:latest',
					imageId: 'sha256:cc',
					ports: [],
				},
			],
			dockerfileRefs: [
				{ app: 'zorbweb', ref: 'ghcr.io/acmeorg/plinkimg:latest' },
				{ app: 'zorbweb', ref: 'plinkapp-web' },
			],
		}
		const own = doc({
			plinkapp: {
				container_name: 'plinkapp',
				image: 'ghcr.io/acmeorg/plinkimg:latest',
				build: { context: '.' },
			},
		})
		expect(codes(own, ctxFor(srv))).toEqual([])
		const def = doc({ web: { container_name: 'plinkapp', build: { context: '.' } } })
		expect(codes(def, ctxFor(srv))).toEqual([])
	})
	it('the server data off: only the namespace rule runs', () => {
		expect(
			imageOwnershipRefusal(
				'quuxco/jobs:x',
				{ appName: 'plinkapp', project: 'plinkapp' },
				undefined,
			),
		).toContain('Docker Hub namespace')
		expect(
			imageOwnershipRefusal(
				'ghcr.io/acmeorg/x:1',
				{ appName: 'plinkapp', project: 'plinkapp' },
				undefined,
			),
		).toBeNull()
	})
	it('ownershipRepo canonical form', () => {
		expect(ownershipRepo('docker.io/library/Node:22@sha256:ab')).toBe('node')
		expect(ownershipRepo('registry-1.docker.io/alpine/git')).toBe('alpine/git')
		expect(ownershipRepo('localhost:5000/x/y:1')).toBe('localhost:5000/x/y')
		expect(serverImageFacts({ containers: [{ project: '', image: 'stray:1' }] }).users).toEqual({})
	})
})

describe('server probe sections', () => {
	it('the image list and the Dockerfile refs need their end marker', () => {
		const line = `sha256:aa\t["quuxco/jobs:latest"]\t["quuxco/jobs@sha256:${'1'.repeat(64)}"]\t{"Labels":{"com.docker.compose.project":"zorbweb"}}`
		expect(parseImageListProbe(`${line}\n`)).toBeUndefined()
		expect(parseImageListProbe(`${line}\n${IMAGE_LIST_OK}\n`)).toEqual([
			{ repos: ['quuxco/jobs:latest', `quuxco/jobs@sha256:${'1'.repeat(64)}`], project: 'zorbweb' },
		])
		expect(
			parseImageListProbe(
				`sha256:bb\tnull\t["x@sha256:${'2'.repeat(64)}"]\tnull\n${IMAGE_LIST_OK}\n`,
			),
		).toEqual([{ repos: [`x@sha256:${'2'.repeat(64)}`], project: '' }])
		expect(parseDockerfileRefsProbe('zorbweb\tnode:22\n')).toBeUndefined()
		expect(
			parseDockerfileRefsProbe(
				`zorbweb\tnode:22\nbad name\tx\nok\tbad ref\n${DOCKERFILE_REFS_OK}\n`,
			),
		).toEqual([{ app: 'zorbweb', ref: 'node:22' }])
	})
	it('the compose probe reads 14 sections', () => {
		const S = `\n${FIXED_PROBE_SEP}\n`
		const parts = [
			'h',
			'{"name":"plinkapp","services":{}}',
			'',
			'c\ti\tp\trunning',
			'',
			'',
			'',
			'',
			'',
			'',
			'',
			'',
			`sha256:aa\t["quuxco/jobs:1"]\tnull\tnull\n${IMAGE_LIST_OK}`,
			`zorbweb\talpine/git:latest\n${DOCKERFILE_REFS_OK}`,
		]
		const p = parseComposeProbe(parts.join(S))
		expect(p?.localImages).toEqual([{ repos: ['quuxco/jobs:1'], project: '' }])
		expect(p?.dockerfileRefs).toEqual([{ app: 'zorbweb', ref: 'alpine/git:latest' }])
	})
	it('the deploy probe runs both sections after the volume labels (the proxy section last)', () => {
		const src = readFileSync(join(__dirname, '..', 'deploy', 'compose-check.ts'), 'utf8')
		expect(src).toMatch(
			/\$\{volumeProjectProbe\}; \$\{sep\}; \{ \$\{IMAGE_LIST_PROBE\}; \} 2>\/dev\/null; \$\{sep\}; \{ \$\{DOCKERFILE_REFS_PROBE\}; \} 2>\/dev\/null; \$\{sep\}; \{ \$\{DOCKER_PROXY_PROBE\}; \} 2>\/dev\/null`/,
		)
	})
	it('DOCKERFILE_REFS_PROBE reads every app folder with the deploy awk (stages and ARGs resolved, links skipped)', () => {
		const apps = join(root, 'apps')
		mkdirSync(join(apps, 'zorbweb', 'src', 'deploy'), { recursive: true })
		mkdirSync(join(apps, 'gritapp', 'node_modules', 'x'), { recursive: true })
		writeFileSync(
			join(apps, 'zorbweb', 'src', 'Dockerfile'),
			'ARG B=alpine/git:latest\nFROM ${B} AS b\nFROM b\nCOPY --from=quuxco/jobs:2 /a /a\n',
		)
		writeFileSync(
			join(apps, 'zorbweb', 'src', 'deploy', 'worker.Dockerfile'),
			'FROM node:22-alpine\n',
		)
		writeFileSync(join(apps, 'gritapp', 'node_modules', 'x', 'Dockerfile'), 'FROM hidden:1\n')
		writeFileSync(join(root, 'secret.Dockerfile'), 'FROM leaked:1\n')
		spawnSync('ln', ['-s', join(root, 'secret.Dockerfile'), join(apps, 'gritapp', 'Dockerfile')])
		const r = spawnSync('sh', ['-c', DOCKERFILE_REFS_PROBE.replaceAll('/opt/apps', apps)], {
			encoding: 'utf8',
		})
		expect(parseDockerfileRefsProbe(r.stdout)?.sort((a, b) => a.ref.localeCompare(b.ref))).toEqual([
			{ app: 'zorbweb', ref: 'alpine/git:latest' },
			{ app: 'zorbweb', ref: 'node:22-alpine' },
			{ app: 'zorbweb', ref: 'quuxco/jobs:2' },
		])
	})
	it('IMAGE_LIST_PROBE lists every image (dangling too) and ends with its marker', () => {
		const bin = join(root, 'ilbin')
		mkdirSync(bin)
		writeFakeDocker(bin, `#!/bin/bash\nif [ "$1 $2" = "image ls" ]; then printf 'sha256:aa\\nsha256:bb\\nsha256:aa\\n'; exit 0; fi\nif [ "$1 $2" = "image inspect" ]; then for i in "\${@:5}"; do case "$i" in sha256:aa) printf '%s\\t["quuxco/jobs:latest"]\\tnull\\t{"Labels":{"com.docker.compose.project":"zorbweb"}}\\n' "$i";; sha256:bb) printf '%s\\tnull\\t["gone/x@sha256:${'3'.repeat(64)}"]\\tnull\\n' "$i";; esac; done; exit 0; fi\nexit 1\n`)
		const r = spawnSync('sh', ['-c', IMAGE_LIST_PROBE], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		})
		expect(parseImageListProbe(r.stdout)).toEqual([
			{ repos: ['quuxco/jobs:latest'], project: 'zorbweb' },
			{ repos: [`gone/x@sha256:${'3'.repeat(64)}`], project: '' },
		])
	})
})

// ── the on-server Dockerfile check ────────────────────────────────────────────────────
const NS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const bin = join(root, 'bin')
mkdirSync(bin)
// LOCAL: refs on the server (a local copy: ID sha256:l<cksum>), REMOTE: refs a pull fetches
// (after a pull: ID sha256:p<cksum>), LABELLED: local copies with a compose project label.
writeFakeDocker(bin, `#!/bin/bash
echo "$*" >> "$LOG"
ref="\${@: -1}"
has() { case " $1 " in *" $2 "*) return 0;; esac; return 1; }
pulled() { grep -qxF -- "$1" "$PULLED" 2>/dev/null; }
dig="sha256:$(printf 'a%.0s' {1..64})"
if [ "$1" = pull ]; then if has "$REMOTE" "$ref"; then r="\${ref%%@*}"; case "\${r##*/}" in *:*) r="\${r%:*}";; esac; echo "$ref" >> "$PULLED"; echo "$r@$dig $ref" >> "$PULLED.map"; echo "\${ref##*/}: Pulling from x"; echo "Digest: $dig"; echo "Status: Downloaded newer image for $ref"; exit 0; fi; exit 1; fi
if [ "$1 $2" = "image inspect" ]; then
  # repo@digest of a pull resolves to the pulled tag's content; RETAGGED: the tag
  # was moved to another image right after the pull
  m=$(awk -v k="$ref" '$1 == k { print $2 }' "$PULLED.map" 2>/dev/null | tail -n 1)
  if [ -n "$m" ]; then ref="$m"; elif [[ "$*" == *"{{.Id}}"* ]] && has "$RETAGGED" "$ref"; then echo "sha256:hostile"; exit 0; fi
  if ! has "$LOCAL" "$ref" && ! pulled "$ref"; then exit 1; fi
  if [[ "$*" == *"{{.Id}}"* ]]; then if pulled "$ref"; then echo "sha256:p$(printf %s "$ref" | cksum | cut -d' ' -f1)"; else echo "sha256:l$(printf %s "$ref" | cksum | cut -d' ' -f1)"; fi; exit 0; fi
  if [[ "$*" == *"{{json .Config}}"* ]]; then if has "$LABELLED" "$ref" && ! pulled "$ref"; then echo '{"Labels":{"com.docker.compose.project":"zorbweb"}}'; else echo '{}'; fi; exit 0; fi
  if [[ "$*" == *".Config.OnBuild"* ]]; then echo 0; exit 0; fi
  if [[ "$*" == *"range .RepoDigests"* ]]; then r="\${ref%%@*}"; case "\${r##*/}" in *:*) r="\${r%:*}";; esac; if pulled "$ref"; then echo "$r@sha256:$(printf 'a%.0s' {1..64})"; else echo "$r@sha256:$(printf 'e%.0s' {1..64})"; fi; exit 0; fi
  if [[ "$*" == *RepoDigests* ]]; then echo 1; exit 0; fi
  exit 0
fi
exit 0
`)
const cks = (s: string) =>
	spawnSync('sh', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', s], {
		encoding: 'utf8',
	}).stdout.trim()

let n = 0
type Opt = {
	mode?: 'enforce' | 'warn'
	pull?: 0 | 1
	own?: string
	authority?: Parameters<typeof dockerfileAuthorityShell>[0]
	local?: string
	remote?: string
	labelled?: string
	retagged?: string
	rec?: string
}
function run(df: string, o: Opt = {}) {
	const dir = join(root, `d${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), df)
	const log = join(dir, 'log')
	writeFileSync(log, '')
	const rec = join(dir, 'rec')
	writeFileSync(
		rec,
		(o.rec ?? '')
			.split(' ')
			.filter(Boolean)
			.map((r) => `sha256:l${cks(r)}\n`)
			.join(''),
	)
	const auth = o.authority ?? {
		self: 'plinkapp',
		foreign: ['quuxco/jobs', 'zorbweb-web'],
		others: ['zorbweb'],
		loginHosts: [],
		owned: [],
	}
	const script = `DFR_NS=${NS}; DFR_APP=plinkapp; DFR_DIR=$(mktemp -d); DFR_MODE=${o.mode ?? 'enforce'}; DFR_PULL=${o.pull ?? 0}; DFR_OWN='${o.own ?? ''}'; ${dockerfileAuthorityShell(auth)}DFR_PROV_FILE=${JSON.stringify(rec)}; ${dockerfileRewriteFunctions('plinkapp')}dfr_one ${JSON.stringify(join(dir, 'Dockerfile'))} ${JSON.stringify(join(dir, 'out'))} && dfr_bases; rc=$?; rm -rf "$DFR_DIR"; exit $rc`
	const r = spawnSync('bash', ['-c', script], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			LOG: log,
			PULLED: join(dir, 'pulled'),
			LOCAL: o.local ?? '',
			REMOTE: o.remote ?? '',
			LABELLED: o.labelled ?? '',
			RETAGGED: o.retagged ?? '',
		},
	})
	return {
		code: r.status,
		log: r.stdout + r.stderr,
		calls: readFileSync(log, 'utf8'),
		out: existsSync(join(dir, 'out')) ? readFileSync(join(dir, 'out'), 'utf8') : '',
		rec: readFileSync(rec, 'utf8'),
	}
}

describe('the own exemption needs ownership (DFR_OWNED)', () => {
	const df = 'FROM node:22-alpine\nCOPY --from=quuxco/jobs:latest /app /stolen\n'
	it('building quuxco/jobs:mine does not make quuxco/jobs:latest own', () => {
		// authority from the real compose check: the repo is not owned
		const d = doc({
			plinkapp: { container_name: 'plinkapp', image: 'quuxco/jobs:mine', build: { context: '.' } },
		})
		const a = dockerfileImageAuthority(ctxFor(victimServer), d)
		expect(a.owned).toEqual([])
		const r = run(df, {
			own: 'quuxco/jobs:mine',
			authority: a,
			local: 'node:22-alpine quuxco/jobs:latest',
			rec: 'node:22-alpine',
		})
		expect(r.code, r.log).not.toBe(0)
		expect(r.log).toContain(
			'it reads the local image quuxco/jobs:latest (an image another project built on this server)',
		)
	})
	it('FROM quuxco/jobs:latest AS v: refused in every mode (not own: inspected, never pulled by powder)', () => {
		for (const mode of ['enforce', 'warn'] as const) {
			const r = run('FROM quuxco/jobs:latest AS v\nFROM node:22-alpine\nCOPY --from=v /app /x\n', {
				mode,
				own: 'quuxco/jobs:mine',
				local: 'node:22-alpine quuxco/jobs:latest',
				rec: 'node:22-alpine',
			})
			expect(r.code, r.log).not.toBe(0)
			// enforce: the image rule refuses first; warn: it warns and the base check refuses
			expect(r.log).toContain(
				mode === 'enforce'
					? 'it reads the local image quuxco/jobs:latest'
					: 'the base image quuxco/jobs:latest: a local build may shadow the image quuxco/jobs:latest',
			)
		}
	})
	it('an owned repo is still exempt (written back unpinned, not inspected)', () => {
		const r = run('FROM plinkapp-base:latest\n', {
			own: 'plinkapp-base',
			authority: {
				self: 'plinkapp',
				foreign: [],
				others: [],
				loginHosts: [],
				owned: ['plinkapp-base'],
			},
			local: 'plinkapp-base:latest',
		})
		expect(r.code, r.log).toBe(0)
		expect(r.out).toContain('FROM plinkapp-base:latest')
		expect(r.calls).not.toMatch(/^pull /m)
		// mutation guard: the same repo in DFR_OWN but not owned is inspected and pulled
		const not = run('FROM plinkapp-base:latest\n', {
			own: 'plinkapp-base',
			local: 'plinkapp-base:latest',
		})
		expect(not.code, not.log).not.toBe(0)
		expect(not.calls).toMatch(/^pull -- plinkapp-base:latest$/m)
	})
})

describe("a non-own image must be powder's own pull (dfr_prov)", () => {
	it('a shadowed base (local build of alpine/git): pulled anonymously over the tag, recorded, pinned to the registry digest', () => {
		const r = run('FROM alpine/git:latest\nRUN true\n', {
			local: 'alpine/git:latest',
			remote: 'alpine/git:latest',
			labelled: 'alpine/git:latest',
		})
		expect(r.code, r.log).toBe(0)
		expect(r.calls).toMatch(/^pull -- alpine\/git:latest$/m)
		expect(r.out).toContain(`FROM alpine/git@sha256:${'a'.repeat(64)}`)
		expect(r.out).not.toContain('e'.repeat(64))
		expect(r.rec).toContain(`sha256:p${cks('alpine/git:latest')}`)
	})
	it('records the ID of the digest the pull reported, not the tag read back after it', () => {
		const r = run('FROM alpine/git:latest\nRUN true\n', {
			local: 'alpine/git:latest',
			remote: 'alpine/git:latest',
			retagged: 'alpine/git:latest',
		})
		expect(r.code, r.log).toBe(0)
		expect(r.calls).toMatch(new RegExp(`^image inspect --format \\{\\{\\.Id\\}\\} -- alpine/git@sha256:${'a'.repeat(64)}$`, 'm'))
		expect(r.rec).toContain(`sha256:p${cks('alpine/git:latest')}`)
		expect(r.rec).not.toContain('hostile')
	})
	it('the pull fails: refused in every mode ("a local build may shadow the image")', () => {
		for (const mode of ['enforce', 'warn'] as const) {
			const r = run('FROM alpine/git:latest\n', { mode, local: 'alpine/git:latest' })
			expect(r.code, r.log).not.toBe(0)
			expect(r.log).toContain('a local build may shadow the image alpine/git:latest')
		}
	})
	it('a recorded, unlabelled local copy is used as is (no pull: POWDER_BUILD_PULL=0 holds)', () => {
		const r = run('FROM node:22-alpine\n', { local: 'node:22-alpine', rec: 'node:22-alpine' })
		expect(r.code, r.log).toBe(0)
		expect(r.calls).not.toMatch(/^pull /m)
	})
	it('a recorded ID with a compose label is pulled again (and refused when the pull fails)', () => {
		const r = run('FROM node:22-alpine\n', {
			local: 'node:22-alpine',
			rec: 'node:22-alpine',
			labelled: 'node:22-alpine',
		})
		expect(r.code, r.log).not.toBe(0)
		expect(r.calls).toMatch(/^pull -- node:22-alpine$/m)
	})
	it('a COPY --from image: pulled once and recorded; enforce refuses when it cannot be, warn warns', () => {
		const ok = run('FROM node:22-alpine\nCOPY --from=toolsorg/uv:1 /uv /uv\n', {
			local: 'node:22-alpine toolsorg/uv:1',
			remote: 'toolsorg/uv:1',
			rec: 'node:22-alpine',
		})
		expect(ok.code, ok.log).toBe(0)
		expect(ok.calls).toMatch(/^pull -- toolsorg\/uv:1$/m)
		const bad = run('FROM node:22-alpine\nCOPY --from=toolsorg/uv:1 /uv /uv\n', {
			local: 'node:22-alpine toolsorg/uv:1',
			rec: 'node:22-alpine',
		})
		expect(bad.code, bad.log).not.toBe(0)
		expect(bad.log).toContain(
			'it reads the local image toolsorg/uv:1 (a local build may shadow the image toolsorg/uv:1',
		)
		const warn = run('FROM node:22-alpine\nCOPY --from=toolsorg/uv:1 /uv /uv\n', {
			mode: 'warn',
			local: 'node:22-alpine toolsorg/uv:1',
			rec: 'node:22-alpine',
		})
		expect(warn.code, warn.log).toBe(0)
		expect(warn.log).toContain('WARN plinkapp dockerfile_image')
	})
	it('a digest ref names content: no pull when it is local', () => {
		const d = `node@sha256:${'d'.repeat(64)}`
		const r = run(`FROM ${d}\n`, { local: d })
		expect(r.code, r.log).toBe(0)
		expect(r.calls).not.toMatch(/^pull /m)
	})
})
