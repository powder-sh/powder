import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({}))
import { buildBuilderScript } from '../builder'
import { testGateShell } from '../deploy/fragments'
import { writeFakeDocker } from './fixtures/fake-docker'

// the test-gate image is pulled as root with root's registry logins, so a
// digest-pinned image on a login registry must be the app's own (the login owner rule
// of the Dockerfile check), in every guard mode, before the pull. Invented names only.

const root = mkdtempSync(join(tmpdir(), 'tg-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const dc = join(root, 'dc')
mkdirSync(dc)
writeFileSync(join(dc, 'config.json'), '{"auths":{"ghcr.io":{"auth":"eDp5"},"registry.example.test":{}}}')
const PIN = `@sha256:${'d'.repeat(64)}`
let n = 0

function runGate(img: string, enforce: boolean, login: string[] = []) {
	const d = join(root, `g${++n}`)
	mkdirSync(join(d, 'ctx', '.powder'), { recursive: true })
	writeFileSync(join(d, 'ctx', '.powder', 'test.sh'), `#!/bin/sh\n# powder-test-image: ${img}\necho ok\n`)
	writeFakeDocker(d, `#!/bin/bash\necho "docker $*" >> '${join(d, 'log')}'\nif [ "$1 $2" = "image inspect" ]; then case "$*" in *RepoDigests*) echo 'docker.io/library/node${PIN}';; *) echo '{}';; esac; fi\nexit 0\n`)
	const frag = testGateShell({ dir: `'${join(d, 'ctx')}'`, label: '/opt/apps/demoapp|demoapp', run: '', tag: '[tg]', enforce, app: 'demoapp', loginSelf: 'demoapp', loginHosts: login })
	const r = spawnSync('bash', ['-c', `set -e; ${frag.split('/root/.docker/config.json').join(`${dc}/config.json`)}`], { encoding: 'utf8', env: { ...process.env, PATH: `${d}:${process.env.PATH}` } })
	let log = ''
	try {
		log = readFileSync(join(d, 'log'), 'utf8')
	} catch {}
	return { status: r.status, out: r.stdout + r.stderr, log }
}

describe('test-gate image and the registry login owner rule', () => {
	it("another project's image on a login registry is refused before any pull, in every mode", () => {
		for (const enforce of [false, true]) {
			for (const img of [`ghcr.io/victimorg/payroll${PIN}`, `ghcr.io/victimorg/payroll:1${PIN}`, `registry.example.test/team/other${PIN}`]) {
				const r = runGate(img, enforce)
				expect(r.status, `${img} ${r.out}`).not.toBe(0)
				expect(r.out).toContain('refused in every guard mode')
				expect(r.log, img).not.toContain('docker pull')
			}
		}
		// a host only the deploy's probe reported (the build server may differ)
		const probed = runGate(`registry.probe.test/team/other${PIN}`, false, ['registry.probe.test'])
		expect(probed.status).not.toBe(0)
	})
	it("public images and the app's own repo pass the check (e.g. node:22-alpine)", () => {
		for (const img of ['node:22-alpine', `docker.io/library/node${PIN}`, `ghcr.io/exampleorg/demoapp${PIN}`, `quay.example.test/team/other${PIN}`]) {
			const r = runGate(img, true)
			expect(r.out, img).not.toContain('refused in every guard mode')
			expect(r.log, img).toContain('docker pull')
		}
	})
	it('the builder passes the app and the probed login hosts to the gate', () => {
		const s = buildBuilderScript({
			dir: '/tmp/b/x-src-demoapp',
			keyPath: '/tmp/k',
			repoUrl: 'git@github.com:o/r.git',
			branch: 'main',
			sha: null,
			image: 'demoapp',
			uniq: 'demoapp:1',
			ctx: '/tmp/b/src',
			df: '/tmp/b/src/Dockerfile',
			buildArgs: '',
			app: 'demoapp',
			dockerfileAuthority: { self: 'demoapp', foreign: [], others: [], loginHosts: ['registry.probe.test'] },
		})
		expect(s).toContain("DFR_SELF='demoapp' DFR_LOGIN=\"registry.probe.test $(")
	})
})
