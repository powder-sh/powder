import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildBuilderScript } from '../builder'
import { composeDockerfileRewriteShell, DFR_BASES_FN, dockerfileAuthorityShell, dockerfileImageRefReport, dockerfileRewriteFunctions } from '../build-cache'
import { writeFakeDocker } from './fixtures/fake-docker'

// a base image's ONBUILD triggers run in the child build unchecked (a COPY --from
// of another app's local image with POWDER_BUILD_PULL=0, cache mounts without this app's
// namespace). Every FROM image that is not this app's own build is inspected before the
// build (pulled first when --pull is on or it is not on the server) and refused in EVERY
// guard mode when `.Config.OnBuild` is not empty. Invented names only.

const NS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const root = mkdtempSync(join(tmpdir(), 'onbuild-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const bin = join(root, 'bin')
mkdirSync(bin)
// LOCAL: refs on the server; REMOTE: refs a pull can fetch; ONB: ref=count (.Config.OnBuild
// length); every call is logged.
writeFakeDocker(bin, `#!/bin/bash
echo "$*" >> "$LOG"
ref="\${@: -1}"
has() { case " $1 " in *" $2 "*) return 0;; esac; return 1; }
if [ "$1" = pull ]; then if has "$REMOTE" "$ref"; then echo "$ref" >> "$PULLED"; exit 0; fi; exit 1; fi
if [ "$1 $2" = "image inspect" ]; then
  if ! has "$LOCAL" "$ref" && ! grep -qxF -- "$ref" "$PULLED" 2>/dev/null; then exit 1; fi
  # image IDs (local copy vs powder's pull) and compose labels (LABELLED, local copies only)
  if [[ "$*" == *"{{.Id}}"* ]]; then if grep -qxF -- "$ref" "$PULLED" 2>/dev/null; then echo "sha256:p$(printf %s "$ref" | cksum | cut -d' ' -f1)"; else echo "sha256:l$(printf %s "$ref" | cksum | cut -d' ' -f1)"; fi; exit 0; fi
  if [[ "$*" == *"{{json .Config}}"* ]]; then if has "$LABELLED" "$ref" && ! grep -qxF -- "$ref" "$PULLED" 2>/dev/null; then echo '{"Labels":{"com.docker.compose.project":"zorbweb"}}'; else echo '{}'; fi; exit 0; fi
  if [[ "$*" == *".Config.OnBuild"* ]]; then n=0; for p in $ONB; do [ "\${p%=*}" = "$ref" ] && n="\${p##*=}"; done; echo "$n"; exit 0; fi
  if [[ "$*" == *"range .RepoDigests"* ]]; then has "$NODIG" "$ref" && exit 0; r="\${ref%%@*}"; case "\${r##*/}" in *:*) r="\${r%:*}";; esac; echo "other/repo@sha256:\$(printf 'c%.0s' {1..64}) $r@sha256:\$(printf 'b%.0s' {1..64}) "; exit 0; fi
  if [[ "$*" == *RepoDigests* ]]; then echo 1; exit 0; fi
  exit 0
fi
exit 0
`)
let n = 0

// rec = the local images powder pulled earlier (their IDs are in the provenance
// record); default: every LOCAL image. owned: DFR_OWNED (default '*', no ownership list).
type Opt = { mode?: 'enforce' | 'warn'; pull?: 0 | 1; own?: string; owned?: string; local?: string; remote?: string; onb?: string; nodig?: string; args?: string; rec?: string; labelled?: string }
function run(df: string, o: Opt = {}) {
	const dir = join(root, `d${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), df)
	const log = join(dir, 'log')
	writeFileSync(log, '')
	writeFileSync(join(dir, 'args'), o.args ?? '')
	const rec = join(dir, 'rec')
	writeFileSync(rec, (o.rec ?? o.local ?? '').split(' ').filter(Boolean).map((r) => `sha256:l${cksum(r)}\n`).join(''))
	const script = `DFR_NS=${NS}; DFR_APP=demoapp; DFR_DIR=$(mktemp -d); DFR_MODE=${o.mode ?? 'warn'}; DFR_PULL=${o.pull ?? 0}; DFR_OWN='${o.own ?? ''}'; ${dockerfileAuthorityShell({ self: 'demoapp', foreign: [], others: ['zorbweb'], loginHosts: [] })}DFR_OWNED='${o.owned ?? '*'}'; DFR_PROV_FILE=${JSON.stringify(rec)}; ${dockerfileRewriteFunctions('demoapp')}dfr_one ${JSON.stringify(join(dir, 'Dockerfile'))} ${JSON.stringify(join(dir, 'out'))} '' ${JSON.stringify(join(dir, 'args'))} && dfr_bases; rc=$?; [ ! -e "$DFR_DIR/bases" ] || echo LEFTOVER; rm -rf "$DFR_DIR"; exit $rc`
	const r = spawnSync('bash', ['-c', script], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: log, PULLED: join(dir, 'pulled'), LOCAL: o.local ?? '', REMOTE: o.remote ?? '', ONB: o.onb ?? '', NODIG: o.nodig ?? '', LABELLED: o.labelled ?? '' },
	})
	const out = existsSync(join(dir, 'out')) ? readFileSync(join(dir, 'out'), 'utf8') : ''
	return { code: r.status, log: r.stdout + r.stderr, calls: readFileSync(log, 'utf8'), out, rec: readFileSync(rec, 'utf8') }
}

/** POSIX cksum of a string (the stub's image ID), via the same tool. */
function cksum(s: string): string {
	return spawnSync('sh', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', s], { encoding: 'utf8' }).stdout.trim()
}

describe('no FROM image with ONBUILD triggers (dfr_bases)', () => {
	it('a base without triggers passes, read locally with pull off (no pull)', () => {
		const r = run('FROM nodeish:22-alpine AS deps\nRUN true\nFROM deps\n', { local: 'nodeish:22-alpine' })
		expect(r.code, r.log).toBe(0)
		// pinned to the digest of its own repo, AS kept; the stage FROM untouched
		expect(r.out).toMatch(new RegExp(`^FROM nodeish@sha256:${B64} AS deps\\n`))
		expect(r.out).toContain('\nFROM deps\n')
		expect(r.out).not.toContain('__POWDER_BASE_')
		expect(r.calls).not.toMatch(/^pull /m)
		expect(r.calls).toContain('.Config.OnBuild')
		expect(r.log).not.toContain('LEFTOVER')
	})
	for (const mode of ['enforce', 'warn'] as const) {
		it(`a base with ONBUILD triggers is refused (${mode} mode)`, () => {
			const r = run('FROM trapbase:1\nRUN true\n', { mode, local: 'trapbase:1', onb: 'trapbase:1=2' })
			expect(r.code, r.log).not.toBe(0)
			expect(r.log).toContain('the base image trapbase:1 has 2 ONBUILD trigger(s)')
			expect(r.log).toContain('refused in every guard mode')
			expect(r.log).not.toContain('LEFTOVER')
		})
	}
	it('every FROM is checked; stage names and COPY --from images are not bases', () => {
		const r = run('FROM nodeish:22 AS a\nFROM a AS b\nCOPY --from=trapbase:1 /x /y\nFROM trapbase:2\n', { local: 'nodeish:22 trapbase:1 trapbase:2', onb: 'trapbase:1=3 trapbase:2=1' })
		expect(r.code, r.log).not.toBe(0)
		expect(r.log).toContain('trapbase:2 has 1 ONBUILD')
		expect(r.log).not.toContain('trapbase:1 has')
		expect(r.calls).not.toMatch(/OnBuild.* a$/m)
	})
	it('FROM <name> AS <name> inspects the local image of that name', () => {
		const r = run('FROM trapweb AS trapweb\nRUN true\n', { local: 'trapweb', onb: 'trapweb=1' })
		expect(r.code, r.log).not.toBe(0)
		expect(r.log).toContain('the base image trapweb has 1 ONBUILD')
	})
	it("this app's own build is not checked", () => {
		const r = run('FROM demoapp-base:latest\nRUN true\n', { own: 'demoapp-base', local: 'demoapp-base:latest', onb: 'demoapp-base:latest=4' })
		expect(r.code, r.log).toBe(0)
		expect(r.calls).not.toContain('.Config.OnBuild')
	})
	it('pull on: the base is pulled (without logins) before it is inspected, also when it is local', () => {
		const ok = run('FROM nodeish:22\n', { pull: 1, local: 'nodeish:22', remote: 'nodeish:22' })
		expect(ok.code, ok.log).toBe(0)
		expect(ok.calls).toMatch(/^pull -- nodeish:22$/m)
		const bad = run('FROM trapbase:1\n', { pull: 1, remote: 'trapbase:1', onb: 'trapbase:1=1' })
		expect(bad.code, bad.log).not.toBe(0)
		expect(bad.log).toContain('trapbase:1 has 1 ONBUILD')
	})
	it('a base that is neither local nor pullable is refused (cannot be checked)', () => {
		const r = run('FROM ghostbase:9\n', {})
		expect(r.code, r.log).not.toBe(0)
		expect(r.log).toContain('the base image ghostbase:9: cannot pull ghostbase:9 anonymously')
		const p = run('FROM ghostbase:9\n', { pull: 1, local: 'ghostbase:9' })
		expect(p.code, p.log).not.toBe(0)
	})
	it('not local, pull off: pulled, then inspected', () => {
		const r = run('FROM nodeish:24\n', { remote: 'nodeish:24' })
		expect(r.code, r.log).toBe(0)
		expect(r.calls).toMatch(/^pull -- nodeish:24$/m)
	})
	it('scratch only: nothing to check', () => {
		const r = run('FROM scratch\nCOPY x /x\n')
		expect(r.code, r.log).toBe(0)
		expect(r.calls).not.toContain('.Config.OnBuild')
	})
})

const B64 = 'b'.repeat(64)

describe('the build reads the inspected image (digest pin), and only the server platform', () => {
	it('a name:tag@digest input stays as written; a digest-only ref too', () => {
		const d = `nodeish:22@sha256:${'d'.repeat(64)}`
		const r = run(`FROM ${d} AS base\nFROM base\n`, { local: d })
		expect(r.code, r.log).toBe(0)
		expect(r.out).toMatch(new RegExp(`^FROM ${d.replace(/[.]/g, '\\.')} AS base\\n`))
	})
	it('a base with no registry digest of its repo is refused (another project\'s local build)', () => {
		const r = run('FROM localbuilt:1\n', { local: 'localbuilt:1', nodig: 'localbuilt:1' })
		expect(r.code, r.log).not.toBe(0)
		expect(r.log).toContain('has no registry digest')
	})
	it("this app's own image is written back as it is (unpinned)", () => {
		const r = run('FROM demoapp-base:latest AS b\nRUN true\n', { own: 'demoapp-base', local: 'demoapp-base:latest' })
		expect(r.code, r.log).toBe(0)
		expect(r.out).toMatch(/^FROM demoapp-base:latest AS b\n/)
	})
	it('a continued FROM with --platform=$BUILDPLATFORM is written back as one pinned line, without the flag', () => {
		const r = run('FROM --platform=$BUILDPLATFORM \\\n  nodeish:22 \\\n  AS b\nRUN true\n', { local: 'nodeish:22' })
		expect(r.code, r.log).toBe(0)
		expect(r.out).toMatch(new RegExp(`^FROM nodeish@sha256:${B64} AS b\\n`))
		expect(r.out).not.toContain('--platform')
	})
	it('refuses a value for an automatic platform ARG (ARG default or build arg); a bare ARG passes', () => {
		for (const n of ['TARGETPLATFORM', 'targetarch', 'BUILDPLATFORM', 'BuildOS', 'BUILDARCH', 'BUILDVARIANT', 'TARGETOS', 'TARGETVARIANT']) {
			const r = run(`ARG ${n}=linux/arm64\nFROM --platform=$${n} nodeish:22\n`, { mode: 'warn', local: 'nodeish:22' })
			expect(r.code, n).not.toBe(0)
			expect(r.log, n).toContain(`build platform ARG ${n}`)
			const st = run(`FROM nodeish:22\nARG ${n}=x\nRUN true\n`, { mode: 'warn', local: 'nodeish:22' })
			expect(st.code, `${n} stage`).not.toBe(0)
			const ba = run('FROM --platform=$TARGETPLATFORM nodeish:22\n', { mode: 'warn', local: 'nodeish:22', args: `${n}=linux/arm64\n` })
			expect(ba.code, `${n} build arg`).not.toBe(0)
			expect(ba.log).toContain(`build arg for the build platform ARG ${n}`)
		}
		const ok = run('ARG TARGETARCH\nFROM --platform=$TARGETPLATFORM nodeish:22\nARG TARGETARCH\nRUN echo $TARGETARCH\n', { local: 'nodeish:22' })
		expect(ok.code, ok.log).toBe(0)
		expect(run('FROM nodeish:22\nARG TARGETARCHX=1\n', { local: 'nodeish:22' }).code).toBe(0)
	})
	it('the TS twin reports the same platform ARG refusals', async () => {
		const { PLATFORM_ARG_RE } = await import('../build-cache')
		expect(PLATFORM_ARG_RE.test('targetPlatform')).toBe(true)
		const t = dockerfileImageRefReport('ARG TARGETOS=linux\nFROM nodeish:22\nARG BUILDARCH\n', { TARGETARCH: 'arm64' }).filter((l) => l.includes('build platform ARG'))
		expect(t).toEqual([
			"REFUSE a build arg for the build platform ARG TARGETARCH is not supported (powder checks the base image variant of this server's platform)",
			"REFUSE a value for the build platform ARG TARGETOS is not supported (powder checks the base image variant of this server's platform; a bare ARG TARGETOS without a default is fine): TARGETOS=linux",
		])
	})
	it('refuses FROM --platform= other than the build platform variables, in every mode', () => {
		for (const mode of ['enforce', 'warn'] as const)
			for (const f of ['--platform=linux/arm64', '--platform=$OTHER', '--platform', '--foo=bar']) {
				const r = run(`FROM ${f} nodeish:22\n`, { mode, local: 'nodeish:22' })
				expect(r.code, `${mode} ${f}`).not.toBe(0)
				expect(r.log).toContain('FROM flag other than --platform=$BUILDPLATFORM')
			}
		for (const f of ['--platform=$BUILDPLATFORM', '--platform=${BUILDPLATFORM}', '--platform=$TARGETPLATFORM', '--platform=${TARGETPLATFORM}'])
			expect(run(`FROM ${f} nodeish:22\n`, { local: 'nodeish:22' }).code, f).toBe(0)
	})
	it('an unresolved FROM is refused in every mode; the token name is reserved', () => {
		const r = run('ARG B\nFROM $B\n', { mode: 'warn' })
		expect(r.code).not.toBe(0)
		expect(r.log).toContain('FROM image ref that does not resolve')
		const t = run('FROM nodeish:22\nRUN echo __POWDER_BASE_1__\n', { local: 'nodeish:22' })
		expect(t.code).not.toBe(0)
		expect(t.log).toContain('__POWDER_BASE_ is reserved')
	})
	it('dfr_one alone leaves the token, so a build without dfr_bases fails', () => {
		const dir = join(root, `solo${++n}`)
		mkdirSync(dir)
		writeFileSync(join(dir, 'Dockerfile'), 'FROM nodeish:22\n')
		spawnSync('bash', ['-c', `DFR_NS=${NS}; DFR_APP=demoapp; DFR_DIR=$(mktemp -d); DFR_MODE=enforce; DFR_PULL=0; DFR_OWN=''; ${dockerfileAuthorityShell({ self: 'demoapp', foreign: [], others: [], loginHosts: [] })}${dockerfileRewriteFunctions('demoapp')}dfr_one ${JSON.stringify(join(dir, 'Dockerfile'))} ${JSON.stringify(join(dir, 'out'))}`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOG: join(dir, 'log') } })
		expect(readFileSync(join(dir, 'out'), 'utf8')).toMatch(/^FROM __POWDER_BASE_1__\n/)
	})
	it('the TS twin reports the same BASE and FROM-flag lines', () => {
		const df = 'FROM nodeish:22 AS a\nFROM a\nFROM --platform=linux/arm64 other:1\nARG B\nFROM ${B:-alpine:3}\n'
		const t = dockerfileImageRefReport(df).filter((l) => /^(BASE|REFUSE a FROM)/.test(l))
		expect(t).toEqual([
			'BASE 1 nodeish:22',
			"REFUSE a FROM flag other than --platform=$BUILDPLATFORM or --platform=$TARGETPLATFORM is not supported (powder checks the base image variant of this server's platform): --platform=linux/arm64",
			'BASE 2 other:1',
			'BASE 3 alpine:3',
		])
	})
})

describe('wiring', () => {
	it('the compose path and the builder run dfr_bases before the build', () => {
		const c = composeDockerfileRewriteShell("-f '/opt/apps/demoapp/docker-compose.yml'", (f) => `true ${f}`)
		expect(c).toContain('if [ "$DFR_BAD" = 0 ] && ! dfr_bases; then DFR_BAD=1; fi')
		expect(c.indexOf('dfr_bases')).toBeLessThan(c.indexOf('build refused by the Dockerfile check'))
		const b = buildBuilderScript({ dir: '/opt/builds/s-demoapp', keyPath: '/tmp/k', repoUrl: 'git@github.com:example-org/demoapp.git', branch: 'main', sha: null, image: 'demoapp:latest', uniq: 'demoapp:latest-b1', ctx: '/opt/builds/s-demoapp/src', df: '/opt/builds/s-demoapp/src/Dockerfile', buildArgs: '', app: 'demoapp' } as never)
		expect(b).toContain('&& dfr_bases && ')
		expect(b.indexOf('dfr_bases &&')).toBeLessThan(b.indexOf('font_retry plock 2400 '))
		expect(DFR_BASES_FN).not.toContain('DOCKER_CONFIG')
	})
})
