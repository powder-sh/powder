import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { protectExistingIgnoreShell } from '../app-runtime-files'
import { addSourceRefusal, composeDockerfileRewriteShell, dockerfileAuthorityShell, dockerfileRewriteFunctions, runNamespaceArgName } from '../build-cache'
import { buildBuilderScript } from '../builder'
import { writeFakeDocker } from './fixtures/fake-docker'

// bypass cases: ADD sources hidden by quotes / escapes, image refs steered by
// build args or left unresolved, the reserved name over a continuation, heredoc markers
// this parser cannot read exactly. Invented names only.

const NS = 'e5f60718293a4b5c6d7e8f90a1b2c3d4'
const root = mkdtempSync(join(tmpdir(), 'ev-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const bin = join(root, 'bin')
mkdirSync(bin)
// docker stub: `image inspect` fails (no local image); `compose ... config` prints $CFG
writeFakeDocker(bin, '#!/bin/bash\n# the base image ONBUILD check (dfr_bases): no triggers\nif [[ "$*" == *".Config.OnBuild"* ]]; then echo 0; exit 0; fi\n# image IDs and configs for the provenance check (dfr_prov)\nif [[ "$*" == *"{{.Id}}"* ]]; then echo "sha256:$(printf %s "${@: -1}" | cksum | cut -d" " -f1)"; exit 0; fi\nif [[ "$*" == *"{{json .Config}}"* ]]; then echo "{}"; exit 0; fi\nif [[ "$*" == *"range .RepoDigests"* ]]; then r="${@: -1}"; r="${r%%@*}"; case "${r##*/}" in *:*) r="${r%:*}";; esac; echo "$r@sha256:0000000000000000000000000000000000000000000000000000000000000000"; exit 0; fi\nif [ "$1" = pull ]; then exit 0; fi\nif [[ "$*" == *" config" ]]; then cat "$CFG"; exit 0; fi\nexit 1\n')
const dc = join(root, 'dc')
mkdirSync(dc)
writeFileSync(join(dc, 'config.json'), '{"auths":{"ghcr.io":{"auth":"eDp5"}}}')
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
// the probe reads root's config at its fixed path; point that path at the test dir.
const atDc = (s: string, d: string) => s.split('/root/.docker/config.json').join(`${d}/config.json`)

let n = 0
function rewrite(df: string, o: { args?: string; mode?: string; login?: string[]; dc?: string } = {}) {
	const dir = join(root, `c${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), df)
	let argf = "''"
	if (o.args !== undefined) {
		writeFileSync(join(dir, 'args'), o.args)
		argf = JSON.stringify(join(dir, 'args'))
	}
	const script = `DFR_NS=${NS}; DFR_APP=demoapp; DFR_DIR=$(mktemp -d); DFR_MODE=${o.mode ?? 'enforce'}; DFR_PULL=1; DFR_OWN=''; ${dockerfileAuthorityShell({ self: 'demoapp', foreign: [], others: [], loginHosts: o.login ?? ['ghcr.io'] })}${dockerfileRewriteFunctions('demoapp')}dfr_one ${JSON.stringify(join(dir, 'Dockerfile'))} ${JSON.stringify(join(dir, 'out'))} '' ${argf}`
	const r = spawnSync('bash', ['-c', atDc(script, o.dc ?? dc)], { encoding: 'utf8', env })
	return { code: r.status, log: r.stdout + r.stderr, out: existsSync(join(dir, 'out')) ? readFileSync(join(dir, 'out'), 'utf8') : '' }
}

describe('ADD sources BuildKit unquotes or unescapes', () => {
	const BAD = [
		"ADD 'https:'//example.invalid/x /x",
		'ADD https\\:\\/\\/example.invalid/x /x',
		'ADD ["https:\\/\\/example.invalid/x", "/x"]',
		'ADD ["https\\u003a//example.invalid/x", "/x"]',
		'ADD ["htt\\u0070s://example.invalid/x", "/x"]',
		'ADD ["github.com\\/example-org\\/r", "/x"]',
		'ADD git\\@git.example.invalid:o/r /x',
		"ADD 'git'@git.example.invalid:o/r /x",
		"ADD gi't@git.example.invalid:o/r' /x",
		'ADD "https://example.invalid/x" /x',
	]
	it('refuses every quoted / escaped source', () => {
		for (const line of BAD) {
			const r = rewrite(`FROM node:22-alpine\n${line}\n`)
			expect(r.code, line).not.toBe(0)
			expect(r.log, line).toMatch(/refusing .*ADD source/)
		}
	})
	it('passes plain sources, the JSON form, heredoc markers (quoted too)', () => {
		for (const line of ['ADD ["package.json", "yarn.lock", "/app/"]', 'ADD [ "a.txt" , "/a" ]', 'ADD <<"EOT" /etc/motd\nhi\nEOT', "ADD <<'EOT' /etc/motd\nhi\nEOT", 'ADD ./vendor.tar.gz /opt/']) {
			const r = rewrite(`FROM node:22-alpine\n${line}\n`)
			expect(r.code, `${line}\n${r.log}`).toBe(0)
		}
	})
	it('the TS rule and the awk agree, plain and JSON form', () => {
		const table: Array<[string, boolean]> = [
			["'https:'//e.invalid/x", false],
			['https\\:\\/\\/e.invalid/x', false],
			['git\\@h.invalid:p', false],
			['"plain.txt"', false],
			['plain.txt', false],
			['<<"EOT"', false],
			['["https:\\/\\/e.invalid/x",', true],
			['["https\\u003a//e.invalid/x",', true],
			['["https://e.invalid/x",', true],
			['["plain.txt",', true],
			["['plain.txt',", true],
		]
		for (const [src, json] of table) {
			const line = json ? `ADD ${src} "/dst"]` : `ADD ${src} /dst/`
			const r = rewrite(`FROM x\n${line}\n`)
			expect(r.log.includes('ADD source'), src).toBe(addSourceRefusal(src, json) !== null)
		}
	})
})

describe('image refs from variables and build args', () => {
	it('a build arg overrides the ARG default in FROM / COPY --from / RUN --mount from=', () => {
		const args = 'BASE=ghcr.io/example-org/payroll:1\n'
		expect(rewrite('ARG BASE=alpine\nFROM ${BASE}\nRUN true\n').code).toBe(0)
		expect(rewrite('ARG BASE=alpine\nFROM ${BASE}\nRUN true\n', { args }).code).not.toBe(0)
		expect(rewrite('ARG BASE\nFROM $BASE\n', { args }).code).not.toBe(0)
		expect(rewrite('ARG BASE=alpine\nFROM node:22\nCOPY --from=$BASE /a /a\n', { args }).code).not.toBe(0)
		expect(rewrite('ARG BASE=alpine\nFROM node:22\nRUN --mount=type=bind,from=${BASE},target=/s true\n', { args }).code).not.toBe(0)
		expect(rewrite('ARG BASE=alpine\nFROM ${BASE}\n', { args: 'BASE=node:22-alpine\n' }).code).toBe(0)
	})
	it('an unresolved ref is refused with a registry login known, even when the build pulls', () => {
		for (const df of ['ARG BASE\nFROM $BASE\n', 'FROM node:22\nCOPY --from=${X} /a /a\n', 'FROM node:22\nRUN --mount=type=bind,from=$X,target=/s true\n']) {
			const r = rewrite(df)
			expect(r.code, df).not.toBe(0)
			expect(r.log, df).toContain('uses a variable with no ARG default or build arg')
		}
	})
	it('with a registry login, an unresolved ref and a login-rule ref are refused in warn mode too', () => {
		for (const df of ['ARG BASE\nFROM $BASE\n', 'FROM node:22\nCOPY --from=${X} /a /a\n', 'FROM ghcr.io/example-org/payroll:1\n', 'FROM node:22\nRUN --mount=type=bind,from=ghcr.io/example-org/payroll:1,target=/s true\n']) {
			const r = rewrite(df, { mode: 'warn' })
			expect(r.code, df).not.toBe(0)
			expect(r.log, df).toContain('refused in every guard mode')
			expect(r.log, df).not.toContain('[compose-guard] WARN')
		}
		expect(rewrite('ARG BASE=alpine\nFROM ${BASE}\n', { mode: 'warn', args: 'BASE=ghcr.io/example-org/payroll:1\n' }).code).not.toBe(0)
		// the pre-existing local-image findings stay a WARN in warn mode
		const local = rewrite(`FROM sha256:${'c'.repeat(64)}\n`, { mode: 'warn' })
		expect(local.code, local.log).toBe(0)
		expect(local.log).toContain('[compose-guard] WARN demoapp dockerfile_image')
		// the app's own repo still passes in warn mode
		expect(rewrite('FROM ghcr.io/example-org/demoapp:base\n', { mode: 'warn' }).code).toBe(0)
	})
	it('without a registry login an unresolved ref passes in warn mode (the build pulls)', () => {
		const none = join(root, 'dc-none')
		mkdirSync(none, { recursive: true })
		writeFileSync(join(none, 'config.json'), '{}')
		expect(rewrite('FROM alpine\nARG X\nCOPY --from=$X /a /b\n', { mode: 'warn', login: [], dc: none }).code).toBe(0)
		expect(rewrite('FROM alpine\nARG X\nCOPY --from=$X /a /b\n', { mode: 'warn', dc: none }).code).not.toBe(0)
		// an unresolved FROM is refused in every mode (its base cannot be inspected and pinned)
		const r = rewrite('ARG BASE\nFROM $BASE\n', { mode: 'warn', login: [], dc: none })
		expect(r.code).not.toBe(0)
		expect(r.log).toContain('FROM image ref that does not resolve')
	})
	it('compose path: each service build.args reaches the check, and no args file is left behind', () => {
		const dir = join(root, 'compose')
		mkdirSync(join(dir, 'src'), { recursive: true })
		writeFileSync(join(dir, 'src', 'Dockerfile'), 'ARG BASE=alpine\nFROM ${BASE}\nRUN true\n')
		const cfg = (base: string) => {
			const f = join(root, `cfg${++n}.yml`)
			writeFileSync(f, `name: demoapp\nservices:\n  demoapp:\n    build:\n      context: ${dir}/src\n      dockerfile: Dockerfile\n      args:\n        BASE: ${base}\n        OTHER: "x y"\n    image: demoapp:latest\n`)
			return f
		}
		const run = (base: string) => {
			const out = join(root, `dfr${++n}`)
			const script = `DFR_NS=${NS}; DFR_APP=demoapp; DFR_DIR=${JSON.stringify(out)}; mkdir -m 700 "$DFR_DIR"; DFR_MODE=enforce; DFR_PULL=1; DFR_OWN=""; ${dockerfileAuthorityShell({ self: 'demoapp', foreign: [], others: [], loginHosts: ['ghcr.io'] })}${dockerfileRewriteFunctions('demoapp')}${composeDockerfileRewriteShell("-f 'x.yml'", protectExistingIgnoreShell)}echo OK`
			const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...env, CFG: cfg(base) } })
			return { r, files: existsSync(out) ? readdirSync(out) : [] }
		}
		const bad = run('ghcr.io/example-org/payroll:1')
		expect(bad.r.stdout).toContain('build refused by the Dockerfile check')
		const good = run('node:22-alpine')
		expect(good.r.stdout, good.r.stdout).toContain('OK')
		expect(good.files.filter((f) => f.endsWith('.args'))).toEqual([])
	})
	it('builder path: facts.args are written for the check', () => {
		const s = buildBuilderScript({
			dir: '/opt/builds/s-demoapp',
			keyPath: '/tmp/k',
			repoUrl: 'git@github.com:example-org/demoapp.git',
			branch: 'main',
			sha: null,
			image: 'demoapp:latest',
			uniq: 'demoapp:latest-b1',
			ctx: '/opt/builds/s-demoapp/src',
			df: '/opt/builds/s-demoapp/src/Dockerfile',
			buildArgs: "--build-arg 'BASE=ghcr.io/example-org/payroll:1'",
			args: { BASE: 'ghcr.io/example-org/payroll:1', 'bad key': 'x' },
		})
		expect(s).toContain(`printf '%s\\n' 'BASE=ghcr.io/example-org/payroll:1' > "$DFR_DIR/args"`)
		expect(s).toContain(`dfr_one '/opt/builds/s-demoapp/src/Dockerfile' "$DFR_DIR/Dockerfile" '' "$DFR_DIR/args"`)
		expect(s).not.toContain('bad key')
		// the builder runs the same dfr_one: the every-mode refusals apply there too
		expect(s).toContain('(refused in every guard mode)')
	})
})

describe('reserved name and heredoc markers', () => {
	it('refuses POWDER_NS split over a continuation', () => {
		expect(rewrite('FROM alpine\nARG POWDER_\\\nNS_abc=1\nRUN true\n').log).toContain('POWDER_NS is reserved')
	})
	it('refuses a heredoc marker it cannot read exactly; a FROM after a plain heredoc gets its ARG', () => {
		expect(rewrite("FROM alpine\nRUN <<'E O F\\'\nE\nE O F\\\nFROM\\\n alpine AS two\nRUN true\n").log).toContain('heredoc marker')
		const r = rewrite('FROM alpine\nRUN <<EOF\necho \\\nEOF\nFROM alpine AS b\nRUN true\n')
		expect(r.code, r.log).toBe(0)
		expect(r.out).toContain(`FROM __POWDER_BASE_2__ AS b\nARG ${runNamespaceArgName(NS)}=1\n`)
	})
})
