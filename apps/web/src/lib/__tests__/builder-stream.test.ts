import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
	buildBuilderScript,
	builderDockerfilePath,
	builtShaMarkerFor,
	loadedNameVariants,
	parseBuiltSha,
	targetImageLoadShell,
} from '../builder'
import { writeFakeDocker } from './fixtures/fake-docker'

// the dedicated builder path. Invented names.

const root = mkdtempSync(join(tmpdir(), 'builder-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Runs the target load shell with a stub docker whose `load` prints `loadOut`. */
function load(loadOut: string, loadRc = 0) {
	const dir = mkdtempSync(join(root, 'l-'))
	const bin = join(dir, 'bin')
	mkdirSync(bin)
	writeFileSync(join(dir, 'out'), loadOut)
	writeFakeDocker(bin, `#!/bin/bash\necho "$*" >> ${JSON.stringify(join(dir, 'calls'))}\ncase "$1" in load) cat > /dev/null; cat ${JSON.stringify(join(dir, 'out'))}; exit ${loadRc};; esac\nexit 0\n`)
	const r = spawnSync('bash', ['-c', targetImageLoadShell('demoapp:latest-b123', 'powder-stage/demoapp:dep_123')], {
		input: Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
		encoding: 'utf8',
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
	})
	let calls = ''
	try {
		calls = readFileSync(join(dir, 'calls'), 'utf8')
	} catch {}
	return { code: r.status, out: r.stdout + r.stderr, calls }
}

describe('the target accepts only the expected tag from docker load', () => {
	it('loads, retags and removes the unique tag when the tar names only it', () => {
		for (const name of ['demoapp:latest-b123', 'docker.io/library/demoapp:latest-b123']) {
			const r = load(`Loaded image: ${name}\n`)
			expect(r.code, r.out).toBe(0)
			expect(r.calls).toContain("tag demoapp:latest-b123 powder-stage/demoapp:dep_123")
			expect(r.calls).toContain('rmi demoapp:latest-b123')
		}
	})

	it('refuses and untags any other name the tar carries (another app, postgres), before the retag', () => {
		const r = load('Loaded image: demoapp:latest-b123\nLoaded image: postgres:16\nLoaded image: otherapp:latest\n')
		expect(r.code).toBe(1)
		expect(r.out).toContain('the tar also named postgres:16 otherapp:latest')
		expect(r.calls).toContain('rmi -- postgres:16')
		expect(r.calls).toContain('rmi -- otherapp:latest')
		expect(r.calls).toContain('rmi -- demoapp:latest-b123')
		expect(r.calls).not.toContain('tag ')
	})

	it('refuses when the unique tag was not loaded, and passes a failing load through', () => {
		const none = load('Loaded image ID: sha256:abc\n')
		expect(none.code).toBe(1)
		expect(none.out).toContain('did not report demoapp:latest-b123')
		const bad = load('Error processing tar file\n', 3)
		expect(bad.code).toBe(3)
		expect(bad.calls).not.toContain('tag ')
	})

	it('an untagged image (unique tag myapp-b<id>) is reported with :latest and accepted', () => {
		expect(loadedNameVariants('demoapp-b123')).toEqual([
			'demoapp-b123',
			'docker.io/library/demoapp-b123',
			'demoapp-b123:latest',
			'docker.io/library/demoapp-b123:latest',
		])
		expect(loadedNameVariants('example-org/demoapp-b9')).toContain('docker.io/example-org/demoapp-b9:latest')
		expect(loadedNameVariants('registry.example.com:5000/demoapp-b9')).toEqual(['registry.example.com:5000/demoapp-b9', 'registry.example.com:5000/demoapp-b9:latest'])
		// a tagged unique tag gets no :latest twin
		expect(loadedNameVariants('demoapp:latest-b123').some((v) => v.endsWith(':latest'))).toBe(false)
		const dir = mkdtempSync(join(root, 'u-'))
		const bin = join(dir, 'bin')
		mkdirSync(bin)
		writeFakeDocker(bin, `#!/bin/bash\necho "$*" >> ${JSON.stringify(join(dir, 'calls'))}\ncase "$1" in load) cat > /dev/null; echo "Loaded image: demoapp-b123:latest"; exit 0;; esac\nexit 0\n`)
		const r = spawnSync('bash', ['-c', targetImageLoadShell('demoapp-b123', 'powder-stage/demoapp:dep_123')], {
			input: Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		})
		expect(r.status, r.stdout + r.stderr).toBe(0)
		expect(readFileSync(join(dir, 'calls'), 'utf8')).toContain('tag demoapp-b123 powder-stage/demoapp:dep_123')
	})

	it('a name that only starts like the unique tag is not it', () => {
		const r = load('Loaded image: demoapp:latest-b1234\n')
		expect(r.code).toBe(1)
		expect(loadedNameVariants('ghcr.io/example-org/demoapp:1-b9')).toEqual(['ghcr.io/example-org/demoapp:1-b9'])
		expect(loadedNameVariants('example-org/demoapp:1-b9')).toEqual(['example-org/demoapp:1-b9', 'docker.io/example-org/demoapp:1-b9'])
	})
})

describe('the built-sha marker carries a nonce', () => {
	const sha = 'a'.repeat(40)
	const other = 'b'.repeat(40)
	it('reads only the nonced marker; a plain line and other nonces are ignored', () => {
		const nonce = 'f00dfeed1234abcd'
		expect(parseBuiltSha(`[builder] built-sha ${other}\n`, nonce)).toBeNull()
		expect(parseBuiltSha(`${builtShaMarkerFor('0000000000000000')} ${other}\n`, nonce)).toBeNull()
		expect(parseBuiltSha(`x ${builtShaMarkerFor(nonce)} ${other}\n`, nonce)).toBeNull()
		expect(parseBuiltSha(`${builtShaMarkerFor(nonce)} ${sha}\n[builder] built-sha ${other}\n`, nonce)).toBe(sha)
		expect(parseBuiltSha(`${builtShaMarkerFor(nonce)} ${sha}\n`, 'short')).toBeNull()
	})
	it('the builder script prints the marker with the nonce it was given', () => {
		const s = buildBuilderScript({
			dir: '/opt/builds/s1-demoapp-demoapp',
			keyPath: '/opt/builds/s1-demoapp-demoapp.k.x',
			repoUrl: 'git@github.com:example-org/demoapp.git',
			branch: 'main',
			sha: null,
			image: 'demoapp:latest',
			uniq: 'demoapp:latest-b1',
			ctx: '/opt/builds/s1-demoapp-demoapp/src',
			df: '/opt/builds/s1-demoapp-demoapp/src/Dockerfile',
			buildArgs: '',
			shaNonce: 'f00dfeed1234abcd',
		})
		expect(s).toContain('echo "__POWDER_BUILT_SHA_f00dfeed1234abcd__ $__bs"')
	})
	it('runBuilderPhase parses with the nonce (no plain built-sha regex left)', () => {
		const src = readFileSync(join(__dirname, '..', 'builder.ts'), 'utf8')
		expect(src).toContain('parseBuiltSha(res.stdout, shaNonce)')
		expect(src).not.toMatch(/match\(\/\\\[builder\\\] built-sha/)
	})
})

describe('builder facts come from the checked compose; the dockerfile stays inside', () => {
	const ctx = '/opt/builds/s1-demoapp-demoapp/src/api'
	const srcRoot = '/opt/builds/s1-demoapp-demoapp/src'
	it('maps an absolute dockerfile inside the context, refuses one outside it', () => {
		expect(builderDockerfilePath('/opt/apps/demoapp/src/api/Dockerfile', '/opt/apps/demoapp/src/api', ctx, srcRoot)).toEqual({ df: `${ctx}/Dockerfile` })
		for (const d of ['/etc/passwd', '/opt/apps/otherapp/src/Dockerfile', '/opt/apps/demoapp/src/apix/Dockerfile', '/opt/apps/demoapp/src/api/../../../otherapp/Dockerfile'])
			expect(builderDockerfilePath(d, '/opt/apps/demoapp/src/api', ctx, srcRoot), d).toHaveProperty('refuse')
	})
	it('a relative dockerfile may use ../ inside the checkout but not past it', () => {
		expect(builderDockerfilePath('Dockerfile', '/opt/apps/demoapp/src/api', ctx, srcRoot)).toEqual({ df: `${ctx}/Dockerfile` })
		expect(builderDockerfilePath('../Dockerfile.api', '/opt/apps/demoapp/src/api', ctx, srcRoot)).toEqual({ df: `${srcRoot}/Dockerfile.api` })
		expect(builderDockerfilePath('../../Dockerfile', '/opt/apps/demoapp/src/api', ctx, srcRoot)).toHaveProperty('refuse')
	})
	it('the deploy passes the guard-checked compose args to resolveComposeBuildFacts', () => {
		const run = readFileSync(join(__dirname, '..', 'deploy', 'run.ts'), 'utf8')
		expect(run).toContain('resolveComposeBuildFacts(server, configFile, service, guardCf)')
		const b = readFileSync(join(__dirname, '..', 'builder.ts'), 'utf8')
		expect(b).toMatch(/const parsed = await readComposeConfig\(server, cf\)/)
		expect(b).toContain("if ('refuse' in dfr) throw new Error(`builder: ${dfr.refuse}`)")
	})
})
