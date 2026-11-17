import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({}))
import { buildBuilderScript } from '../builder'
import { testGateShell } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'
import { writeFakeDocker } from './fixtures/fake-docker'

const script = buildBuilderScript({
	dir: '/tmp/b',
	keyPath: '/tmp/k',
	repoUrl: 'git@github.com:o/r.git',
	branch: 'main',
	sha: null,
	image: 'o/r',
	uniq: 'o-r:1',
	ctx: '/tmp/b/src',
	df: '/tmp/b/src/Dockerfile',
	buildArgs: '',
})

const DIGEST = `docker.io/library/node@sha256:${'c'.repeat(64)}`

/** Run the shared test-gate fragment under bash with a stub docker that logs its argv. */
function runGate(
	firstLine: string,
	o: {
		labels?: string
		mem?: string | null
		enforce?: boolean
		pullFails?: boolean
		netFails?: boolean
		digest?: string
	} = {},
) {
	const d = mkdtempSync(join(tmpdir(), 'tg-'))
	mkdirSync(join(d, 'ctx', '.powder'), { recursive: true })
	writeFileSync(join(d, 'ctx', '.powder', 'test.sh'), `#!/bin/sh\n${firstLine}\necho ok\n`)
	writeFileSync(join(d, 'labels'), o.labels ?? '{}')
	writeFakeDocker(d, `#!/bin/bash\necho "docker $*" >> '${join(d, 'log')}'\n` +
			`if [ "$1" = pull ] && [ "${o.pullFails ? 1 : 0}" = 1 ]; then exit 1; fi\n` +
			`if [ "$1 $2" = "network create" ] && [ "$3" = --label ] && [ "${o.netFails ? 1 : 0}" = 1 ]; then exit 1; fi\n` +
			`if [ "$1 $2" = "image inspect" ]; then case "$*" in *RepoDigests*) echo '${o.digest ?? DIGEST}';; *) cat '${join(d, 'labels')}';; esac; fi\nexit 0\n`)
	const frag = testGateShell({
		dir: `'${join(d, 'ctx')}'`,
		label: '/opt/apps/x|x',
		run: '',
		tag: '[tg]',
		mem: o.mem ?? null,
		enforce: o.enforce,
		app: 'x',
	})
	const r = spawnSync('bash', ['-c', `set -e; ${frag}`], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${d}:${process.env.PATH}` },
	})
	let log = ''
	try {
		log = readFileSync(join(d, 'log'), 'utf8')
	} catch {}
	return { status: r.status, out: r.stdout, log }
}

describe('test gate image + isolation (builder and local share one fragment)', () => {
	it('builder and deploy script both use the shared gate', () => {
		const deploy = buildDeployScript({
			workingDir: '/opt/apps/x',
			configFile: '/opt/apps/x/docker-compose.yml',
			service: 'x',
			cf: '',
			declaredMode: 'build',
			prebuilt: false,
			infra: [],
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
		})
		for (const s of [script, deploy]) {
			expect(s).toContain('--pull=never')
			expect(s).toContain('--network "$TG_NET"')
			expect(s).toContain('--cap-drop NET_RAW')
			expect(s).toContain('--label traefik.enable=false')
			expect(s).toContain('powder.testgate=')
			expect(s).toContain('memory cap')
		}
		expect(script).toMatch(/trap '.*powder\.testgate=builder\|\/tmp\/b.*' EXIT/)
		expect(deploy).toMatch(/tg_stop; if \[ "\$rc" -ne 0 \]/)
	})
	it("the image allow-list is enforced by default: another app's local tag and non-node images are refused", () => {
		for (const enforce of [false, true]) {
			for (const img of [
				'victim:latest',
				'victim',
				'python:3.12',
				'ghcr.io/x/y:latest',
				'node:22-alpine;touch /tmp/x',
			]) {
				const r = runGate(`# powder-test-image: ${img}`, { enforce })
				expect(r.status, `${img} enforce=${enforce}`).toBe(1)
				expect(r.out).toContain('refusing powder-test-image')
				expect(r.log).not.toContain('docker run')
				expect(r.log).not.toContain('docker pull')
			}
		}
		// A leading dash never reaches docker as a flag: it falls back to the default.
		const dash = runGate('# powder-test-image: --privileged')
		expect(dash.log).toContain('docker pull node:22-alpine')
	})
	it('node:22-alpine and digest-pinned images pass by default', () => {
		for (const img of [
			'# powder-test-image: node:22-alpine',
			`# powder-test-image: node@sha256:${'d'.repeat(64)}`,
		]) {
			const r = runGate(img)
			expect(r.status, img).toBe(0)
			expect(r.log).toContain('docker run')
		}
	})
	it('pulls exactly once and runs the pulled digest, isolated, labelled and cleaned up', () => {
		for (const img of [
			'',
			'# powder-test-image: node:20-slim',
			// on a login registry (ghcr.io) only the app's own repo (app x) passes
			`# powder-test-image: ghcr.io/o/x:1@sha256:${'a'.repeat(64)}`,
		]) {
			const r = runGate(img)
			expect(r.status, img).toBe(0)
			expect(r.log.match(/^docker pull /gm)?.length).toBe(1)
			expect(r.log).toMatch(
				/docker run --rm --pull=never --network powder-testgate-[0-9a-f]{12} --pids-limit 2048 --security-opt no-new-privileges --cap-drop NET_RAW .*--label traefik\.enable=false --label com\.docker\.compose\.project= --label com\.docker\.compose\.service= --label powder\.testgate=\/opt\/apps\/x\|x .*node@sha256:c{64} sh -lc/,
			)
			expect(r.log).toContain('docker ps -aq --filter label=powder.testgate=/opt/apps/x|x')
			// a fresh network per run, created and removed
			const net = r.log.match(
				/network create --label powder\.testgate=\/opt\/apps\/x\|x (powder-testgate-[0-9a-f]{12})/,
			)?.[1]
			expect(net).toBeTruthy()
			expect(r.log).toContain('network ls -q --filter label=powder.testgate=/opt/apps/x|x')
		}
	})
	// a failed per-run network refuses the run; there is no shared fallback network.
	it('per-run network create fails: refused, no test container runs', () => {
		const r = runGate('', { netFails: true })
		expect(r.status).not.toBe(0)
		expect(r.out).toContain('refusing: cannot create the test network')
		expect(r.log).not.toMatch(/docker run /)
		expect(r.log).not.toMatch(/--network powder-testgate( |$)/m)
	})
	it('pull fails and the tag has a local RepoDigest: refused in every mode (a RepoDigest is no proof of a pull)', () => {
		for (const enforce of [false, true]) {
			const r = runGate('', { pullFails: true, enforce })
			expect(r.status, `enforce=${enforce}`).toBe(1)
			expect(r.out).toContain('refusing: the pull of node:22-alpine failed and no local copy can be trusted')
			expect(r.log).not.toContain('docker run')
		}
	})
	it('pull fails and no digest: refused in every mode (a poisoned local tag never runs)', () => {
		for (const enforce of [false, true]) {
			const r = runGate('', { pullFails: true, digest: '', enforce })
			expect(r.status, `enforce=${enforce}`).toBe(1)
			expect(r.out).toContain('refusing: the pull of node:22-alpine failed')
			expect(r.log).not.toContain('docker run')
		}
	})
	it('pull fails, digest-pinned image whose local copy carries compose labels: refused', () => {
		const pin = `node@sha256:${'c'.repeat(64)}`
		const r = runGate(`# powder-test-image: ${pin}`, { pullFails: true, labels: '{"Labels":{"com.docker.compose.project":"zorbweb"}}' })
		expect(r.status).toBe(1)
		expect(r.log).not.toContain('docker run')
	})
	it('pull fails and the local digest is of ANOTHER repository: refused', () => {
		const r = runGate('', { pullFails: true, digest: `victim@sha256:${'e'.repeat(64)}` })
		expect(r.status).toBe(1)
		expect(r.log).not.toContain('docker run')
		const nodeish = runGate('', { pullFails: true, digest: `evil/node@sha256:${'e'.repeat(64)}` })
		expect(nodeish.status).toBe(1)
	})
	it('pull fails, digest-pinned image: runs only the exact pinned digest', () => {
		const pin = `node@sha256:${'c'.repeat(64)}`
		const ok = runGate(`# powder-test-image: ${pin}`, { pullFails: true })
		expect(ok.status).toBe(0)
		expect(ok.log).toMatch(/docker run .*node@sha256:c{64} sh -lc/)
		const other = runGate(`# powder-test-image: node@sha256:${'d'.repeat(64)}`, { pullFails: true })
		expect(other.status).toBe(1)
		expect(other.log).not.toContain('docker run')
	})
	it('routing / compose labels on the image: WARN (neutralised on the run); enforce refuses', () => {
		for (const l of [
			'{"traefik.http.routers.x.rule":"Host(`dashboard.example.com`)"}',
			'{"com.docker.compose.project":"victim"}',
		]) {
			const w = runGate('', { labels: l })
			expect(w.status).toBe(0)
			expect(w.out).toContain('[compose-guard] WARN x testgate_labels')
			const e = runGate('', { labels: l, enforce: true })
			expect(e.status).toBe(1)
			expect(e.log).not.toContain('docker run')
		}
	})
	it('memory: uncapped by default, POWDER_TESTGATE_MEM caps it (logged)', () => {
		const none = runGate('')
		expect(none.out).toContain('memory cap: none')
		expect(none.log).not.toContain('--memory')
		const withCap = runGate('', { mem: '3g' })
		expect(withCap.out).toContain('memory cap: 3g')
		expect(withCap.log).toMatch(/docker run .*--memory 3g --memory-swap 3g/)
	})
})
