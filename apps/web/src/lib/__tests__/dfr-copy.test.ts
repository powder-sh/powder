// the compose rewrite checked the Dockerfile (dfr_src) and later read it with
// awk, and checked `<Dockerfile>.dockerignore` with [ -L ] before a cp that follows
// links. Both are now copied without following a link into powder's temp dir and
// only the copy is read.
import { spawnSync } from 'node:child_process'
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { protectExistingIgnoreShell } from '../app-runtime-files'
import { composeDockerfileRewriteShell, dockerfileRewriteFunctions } from '../build-cache'
import { writeFakeDocker } from './fixtures/fake-docker'

const NS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const root = mkdtempSync(join(tmpdir(), 'df-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const bin = join(root, 'bin')
mkdirSync(bin)
writeFakeDocker(bin, '#!/bin/bash\n# the base image ONBUILD check (dfr_bases): no triggers\nif [[ "$*" == *".Config.OnBuild"* ]]; then echo 0; exit 0; fi\n# image IDs and configs for the provenance check (dfr_prov)\nif [[ "$*" == *"{{.Id}}"* ]]; then echo "sha256:$(printf %s "${@: -1}" | cksum | cut -d" " -f1)"; exit 0; fi\nif [[ "$*" == *"{{json .Config}}"* ]]; then echo "{}"; exit 0; fi\nif [[ "$*" == *"range .RepoDigests"* ]]; then r="${@: -1}"; r="${r%%@*}"; case "${r##*/}" in *:*) r="${r%:*}";; esac; echo "$r@sha256:0000000000000000000000000000000000000000000000000000000000000000"; exit 0; fi\nif [ "$1" = pull ]; then exit 0; fi\nif [[ "$*" == *" config" ]]; then cat "$CFG"; exit 0; fi\nexit 1\n')

// SWAP_AT=n: right after the n-th dfr_src call returns, the Dockerfile (or with
// SWAP_IGNORE=1 its .dockerignore) is replaced by a link to the secret, as a
// container with a writable bind of the context could.
const RACE = `eval "orig_$(declare -f dfr_src)"; dfr_src() { orig_dfr_src "$@"; __rr=$?; __n=$(( $(cat "$CNT" 2>/dev/null || echo 0) + 1 )); echo "$__n" > "$CNT"; if [ "$__n" = "\${SWAP_AT:-0}" ]; then __t="$TARGET"; rm -f "$__t"; ln -s "$SECRET" "$__t"; fi; return $__rr; }; `

function run(opts: { swapAt?: number; ignore?: boolean; linkDf?: boolean }) {
	const dir = mkdtempSync(join(root, 'c-'))
	mkdirSync(join(dir, 'src'))
	const secret = join(dir, 'secret')
	writeFileSync(secret, 'FROM secret-marker-image\n')
	if (opts.linkDf) {
		mkdirSync(join(dir, 'src', 'docker'))
		writeFileSync(
			join(dir, 'src', 'docker', 'prod'),
			'FROM node:22\nRUN --mount=type=cache,target=/root/.npm npm ci\n',
		)
		symlinkSync('docker/prod', join(dir, 'src', 'Dockerfile'))
	} else {
		writeFileSync(
			join(dir, 'src', 'Dockerfile'),
			'FROM node:22\nRUN --mount=type=cache,target=/root/.npm npm ci\n',
		)
	}
	writeFileSync(join(dir, 'src', 'Dockerfile.dockerignore'), 'node_modules\n')
	const cfg = join(dir, 'cfg.yml')
	writeFileSync(
		cfg,
		`name: shop\nservices:\n  app:\n    build:\n      context: ${dir}/src\n      dockerfile: Dockerfile\n    image: shop:latest\n`,
	)
	const out = join(dir, 'out')
	mkdirSync(out)
	const script = `DFR_NS=${NS}; DFR_APP=shop; DFR_DIR=${JSON.stringify(out)}; DFR_MODE=enforce; DFR_PULL=1; DFR_OWN=""; ${dockerfileRewriteFunctions('shop')}${RACE}${composeDockerfileRewriteShell("-f 'x.yml'", protectExistingIgnoreShell)}echo "OK"`
	const r = spawnSync('bash', ['-c', script], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			CFG: cfg,
			CNT: join(dir, 'cnt'),
			SECRET: secret,
			SWAP_AT: String(opts.swapAt ?? 0),
			TARGET: join(dir, 'src', opts.ignore ? 'Dockerfile.dockerignore' : 'Dockerfile'),
		},
	})
	const files = readdirSync(out)
	const read = files.map((f) => {
		try {
			// the test itself must not follow a link the script left (or refused)
			if (!lstatSync(join(out, f)).isFile()) return ''
			return readFileSync(join(out, f), 'utf8')
		} catch {
			return ''
		}
	})
	return { code: r.status, log: r.stdout + r.stderr, files, all: read.join('\n') }
}

describe('dfr reads only a verified copy', () => {
	it('a normal Dockerfile: same messages as before, rewritten, no leftover copy', () => {
		const r = run({})
		expect(r.code, r.log).toBe(0)
		expect(r.log).toContain('OK')
		expect(r.log).toMatch(
			/\[build-cache\] 1 cache mount\(s\) in \S+\/src\/Dockerfile isolated to this app/,
		)
		expect(r.files).toContain('1.Dockerfile')
		expect(r.files).toContain('1.Dockerfile.dockerignore')
		expect(r.files).not.toContain('1.src')
	})

	it('a tracked in-context link still passes', () => {
		const r = run({ linkDf: true })
		expect(r.code, r.log).toBe(0)
		expect(r.all).toContain('npm ci')
	})

	it('a Dockerfile swapped for a link after the check is never read', () => {
		// call 1: the compose loop's dfr_src, call 2: the one inside dfr_copy
		const r = run({ swapAt: 2 })
		expect(r.code).not.toBe(0)
		expect(r.log).toContain('not a regular file')
		expect(r.log + r.all).not.toContain('secret-marker')
	})

	it('a .dockerignore swapped for a link is refused, its target never read', () => {
		const r = run({ swapAt: 1, ignore: true })
		expect(r.code).not.toBe(0)
		expect(r.log).toContain('Dockerfile.dockerignore is a symlink')
		expect(r.log + r.all).not.toContain('secret-marker')
	})
})
