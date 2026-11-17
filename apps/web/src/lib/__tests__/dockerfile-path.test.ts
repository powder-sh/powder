import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { protectExistingIgnoreShell } from '../app-runtime-files'
import { composeDockerfileRewriteShell, dockerfileRewriteFunctions } from '../build-cache'
import { buildBuilderScript } from '../builder'
import { composeViolations, isHighSeverity } from '../compose-safety'
import { buildDeployScript } from '../deploy/script'
import { writeFakeDocker } from './fixtures/fake-docker'

// a relative build.dockerfile with `..` (or a symlink) made powder read a
// file outside the app as root (the cache-id rewrite) and hand it to the build.

const NS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const root = mkdtempSync(join(tmpdir(), 'df-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const bin = join(root, 'bin')
mkdirSync(bin)
writeFakeDocker(bin, '#!/bin/bash\n# the base image ONBUILD check (dfr_bases): no triggers\nif [[ "$*" == *".Config.OnBuild"* ]]; then echo 0; exit 0; fi\n# image IDs and configs for the provenance check (dfr_prov)\nif [[ "$*" == *"{{.Id}}"* ]]; then echo "sha256:$(printf %s "${@: -1}" | cksum | cut -d" " -f1)"; exit 0; fi\nif [[ "$*" == *"{{json .Config}}"* ]]; then echo "{}"; exit 0; fi\nif [[ "$*" == *"range .RepoDigests"* ]]; then r="${@: -1}"; r="${r%%@*}"; case "${r##*/}" in *:*) r="${r%:*}";; esac; echo "$r@sha256:0000000000000000000000000000000000000000000000000000000000000000"; exit 0; fi\nif [ "$1" = pull ]; then exit 0; fi\nif [[ "$*" == *" config" ]]; then cat "$CFG"; exit 0; fi\nexit 1\n')

describe('compose guard: build.dockerfile', () => {
	const ctx = { appName: 'shop', projectDir: '/opt/apps/shop' }
	const doc = (dockerfile: string, context = './src') => ({
		services: { shop: { image: 'shop:latest', build: { context, dockerfile } } },
	})
	const build = (d: string, c?: string) =>
		composeViolations(doc(d, c), ctx).filter((v) => v.code === 'build')

	it('refuses a relative dockerfile that climbs out of the app (high severity)', () => {
		const v = build('../../other/.env')
		expect(v.length).toBe(1)
		expect(v[0] && isHighSeverity(v[0])).toBe(true)
		expect(build('../../../etc/shadow', '/opt/apps/shop/src').length).toBe(1)
		expect(build('sub/../../x').length).toBe(1)
	})
	it('passes the standard and monorepo shapes', () => {
		expect(build('Dockerfile')).toEqual([])
		expect(build('apps/web/Dockerfile')).toEqual([])
		expect(build('Dockerfile', '/opt/apps/shop/src')).toEqual([])
		expect(build('/opt/apps/shop/src/Dockerfile')).toEqual([])
	})
})

describe('rewrite shell: the source must be a regular file inside the context', () => {
	function run(setup: (dir: string) => string, mode = 'warn') {
		const dir = mkdtempSync(join(root, 'c-'))
		mkdirSync(join(dir, 'src'))
		writeFileSync(join(dir, 'secret'), 'FROM x\n')
		const df = setup(dir)
		const cfg = join(dir, 'cfg.yml')
		writeFileSync(
			cfg,
			`name: shop\nservices:\n  app:\n    build:\n      context: ${dir}/src\n      dockerfile: ${df}\n    image: shop:latest\n`,
		)
		const script = `DFR_NS=${NS}; DFR_APP=shop; DFR_DIR=$(mktemp -d); DFR_MODE=${mode}; DFR_PULL=1; DFR_OWN=""; ${dockerfileRewriteFunctions('shop')}${composeDockerfileRewriteShell("-f 'x.yml'", protectExistingIgnoreShell)}echo "OK"`
		const r = spawnSync('bash', ['-c', script], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CFG: cfg },
		})
		return { code: r.status, log: r.stdout + r.stderr }
	}

	it('refuses ../ out of the context in every mode', () => {
		for (const mode of ['warn', 'enforce']) {
			const r = run(() => '../secret', mode)
			expect(r.code).not.toBe(0)
			expect(r.log).toContain('outside the build context')
		}
	})
	it('refuses a symlink pointing outside the context', () => {
		const r = run((d) => {
			symlinkSync(join(d, 'secret'), join(d, 'src', 'Dockerfile'))
			return 'Dockerfile'
		})
		expect(r.code).not.toBe(0)
		expect(r.log).toContain('outside the build context')
	})
	it('refuses a source that is not a regular file', () => {
		const r = run((d) => {
			mkdirSync(join(d, 'src', 'Dockerfile'))
			return 'Dockerfile'
		})
		expect(r.code).not.toBe(0)
		expect(r.log).toContain('not a regular file')
	})
	it('passes a Dockerfile in the context, also via an inside symlink', () => {
		expect(
			run((d) => {
				writeFileSync(join(d, 'src', 'Dockerfile'), 'FROM x\n')
				return 'Dockerfile'
			}).code,
		).toBe(0)
		expect(
			run((d) => {
				mkdirSync(join(d, 'src', 'docker'))
				writeFileSync(join(d, 'src', 'docker', 'prod'), 'FROM x\n')
				symlinkSync('docker/prod', join(d, 'src', 'Dockerfile'))
				return 'Dockerfile'
			}).code,
		).toBe(0)
	})
})

describe('builder and preflight run the same check', () => {
	it('builder checks the Dockerfile against the clone context before the rewrite', () => {
		const s = buildBuilderScript({
			dir: '/opt/builds/s-shop',
			keyPath: '/opt/builds/s-shop.k',
			repoUrl: 'git@github.com:o/r.git',
			branch: 'main',
			sha: null,
			image: 'shop:latest',
			uniq: 'shop:latest-b1',
			ctx: '/opt/builds/s-shop/src',
			df: '/opt/builds/s-shop/src/../x',
			buildArgs: '',
			cacheNamespace: NS,
			app: 'shop',
		})
		expect(s).toContain(`dfr_src '/opt/builds/s-shop/src/../x' '/opt/builds/s-shop/src' && dfr_one`)
	})
	it('deploy preflight refuses a Dockerfile outside the context', () => {
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
		expect(s).toContain('dfr_src "$PF_DFP" "$PF_CTX" ||')
	})
})
