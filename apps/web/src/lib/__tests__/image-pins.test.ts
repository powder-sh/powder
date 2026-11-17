// powder's own base images and the Traefik that bootstrap starts are
// pinned by registry digest; Docker comes from its apt repository with the key's
// fingerprint checked; the opt-in convenience script is hash-printed and can be
// checked against POWDER_GET_DOCKER_SHA256.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathWithout } from './hermetic'
import {
	DOCKER_APT_KEY_FINGERPRINT,
	TRAEFIK_IMAGE,
	installDockerCommand,
	installDockerScriptCommand,
} from '../server-bootstrap'

const ROOT = resolve(__dirname, '../../../../..')
const DIGEST = /@sha256:[0-9a-f]{64}\b/

describe('image pins', () => {
	it('every external FROM in docker/web.Dockerfile is digest-pinned', () => {
		const df = readFileSync(join(ROOT, 'docker/web.Dockerfile'), 'utf8')
		const froms = [...df.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1] ?? '')
		const stages = new Set([...df.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1] ?? ''))
		const external = froms.filter((f) => !stages.has(f))
		expect(external.length).toBeGreaterThan(0)
		for (const f of external) expect(f, f).toMatch(DIGEST)
	})
	it('the bootstrap Traefik is digest-pinned in both the TS plan and the shell script', () => {
		expect(TRAEFIK_IMAGE).toMatch(/^traefik:v\d+\.\d+@sha256:[0-9a-f]{64}$/)
		const sh = readFileSync(join(ROOT, 'bin/server-bootstrap.sh'), 'utf8')
		expect(sh).toContain(` ${TRAEFIK_IMAGE} --entrypoints`)
		expect(sh).not.toMatch(/ traefik:v[\d.]+ /)
	})
})

describe('docker convenience script check', () => {
	const runStep = (sum: string | null) => {
		const dir = mkdtempSync(join(tmpdir(), 'gd-'))
		writeFileSync(join(dir, 'curl'), '#!/bin/sh\nprintf "echo RAN_SCRIPT" > "$4"\n', {
			mode: 0o755,
		})
		writeFileSync(join(dir, 'sh'), '#!/bin/bash\necho RAN_SCRIPT\n', { mode: 0o755 })
		const cmd = installDockerScriptCommand().replace(
			'command -v docker',
			'command -v no-such-docker-binary',
		)
		const env = {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			...(sum ? { POWDER_GET_DOCKER_SHA256: sum } : {}),
		}
		try {
			return { out: execFileSync('/bin/bash', ['-c', cmd], { env }).toString(), rc: 0 }
		} catch (e) {
			const err = e as { status: number; stdout: Buffer }
			return { out: err.stdout.toString(), rc: err.status }
		}
	}
	it('prints the sha256 and runs when no expected hash is set', () => {
		const r = runStep(null)
		expect(r.out).toMatch(/get\.docker\.com script sha256: [0-9a-f]{64}/)
		expect(r.out).toContain('RAN_SCRIPT')
	})
	it('refuses a script that does not match POWDER_GET_DOCKER_SHA256', () => {
		const r = runStep('0'.repeat(64))
		expect(r.rc).toBe(1)
		expect(r.out).toContain('does not match POWDER_GET_DOCKER_SHA256')
		expect(r.out).not.toContain('RAN_SCRIPT')
	})
})

describe("docker apt repository install", () => {
	const FPR = DOCKER_APT_KEY_FINGERPRINT
	const key = (...fprs: string[]) =>
		fprs.map((f) => `pub:-:4096:1:8D81803C0EBFCD88:1487788586:::-:::scESA::::::23::0:\nfpr:::::::::${f}:\nuid:-::::1487788586::A:::Docker Release (CE deb) <docker@docker.com>::::::::::0:\nsub:-:4096:1:7EA0A9C3F273FCD8:1487792064:::-:::s::::::23:\nfpr:::::::::D3306A018370199E527AE7317EA0A9C3F273FCD8:`).join('\\n')
	const runStep = (os: string, gpgOut: string) => {
		const dir = mkdtempSync(join(tmpdir(), 'da-'))
		const bin = join(dir, 'bin')
		mkdirSync(bin)
		mkdirSync(join(dir, 'etc/apt/sources.list.d'), { recursive: true })
		writeFileSync(join(dir, 'etc/os-release'), os)
		const log = join(dir, 'calls')
		const stub = (name: string, body: string) =>
			writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> ${log}\n${body}\n`, { mode: 0o755 })
		stub('apt-get', 'exit 0')
		stub('apt-cache', "printf ' docker-ce | 5:30.0.1-1~ubuntu.24.04~noble | https://download.docker.com/linux/ubuntu noble/stable amd64 Packages\\n docker-ce | 5:29.1.3-1~ubuntu.24.04~noble | https://download.docker.com/linux/ubuntu noble/stable amd64 Packages\\n'")
		stub('curl', 'printf "KEY" > "$4"')
		stub('gpg', `printf '${gpgOut}\\n'`)
		stub('dpkg', 'echo amd64')
		const cmd = installDockerCommand()
			.replace('command -v docker', 'command -v no-such-docker-binary')
			.replaceAll('/etc/', `${dir}/etc/`)
		const env = { ...process.env, PATH: `${bin}:${pathWithout(['docker'])}` }
		let out: string
		let rc = 0
		try {
			out = execFileSync('/bin/bash', ['-c', cmd], { env }).toString()
		} catch (e) {
			const err = e as { status: number; stdout: Buffer }
			out = err.stdout.toString()
			rc = err.status
		}
		const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
		return { out, rc, calls, dir }
	}
	const UBUNTU = 'ID=ubuntu\nVERSION_CODENAME=noble\n'
	it('trusts the key only with the pinned fingerprint, then installs the newest 29.x', () => {
		const r = runStep(UBUNTU, key(FPR))
		expect(r.rc, r.out).toBe(0)
		expect(r.out).toContain(`fingerprint ${FPR} matches`)
		expect(r.calls).toContain('curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o ')
		expect(readFileSync(join(r.dir, 'etc/apt/keyrings/docker.asc'), 'utf8')).toBe('KEY')
		expect(readFileSync(join(r.dir, 'etc/apt/sources.list.d/docker.list'), 'utf8')).toBe(
			`deb [arch=amd64 signed-by=${r.dir}/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n`,
		)
		expect(r.calls).toContain(
			'apt-get install -y -q docker-ce=5:29.1.3-1~ubuntu.24.04~noble docker-ce-cli=5:29.1.3-1~ubuntu.24.04~noble containerd.io docker-buildx-plugin docker-compose-plugin',
		)
		expect(r.calls).not.toContain('5:30.')
		expect(r.calls).not.toContain('get.docker.com')
	})
	it('refuses a key with another fingerprint, installing nothing', () => {
		const r = runStep(UBUNTU, key('0'.repeat(40)))
		expect(r.rc).toBe(1)
		expect(r.out).toContain('not trusting it')
		expect(existsSync(join(r.dir, 'etc/apt/keyrings/docker.asc'))).toBe(false)
		expect(r.calls).not.toContain('docker-ce')
	})
	it('refuses a key file with a second primary key next to the pinned one', () => {
		const r = runStep(UBUNTU, key(FPR, 'A'.repeat(40)))
		expect(r.rc).toBe(1)
		expect(r.out).toContain('not trusting it')
		expect(existsSync(join(r.dir, 'etc/apt/keyrings/docker.asc'))).toBe(false)
	})
	it('refuses a distro other than Debian or Ubuntu before touching anything', () => {
		const r = runStep('ID=fedora\nVERSION_ID=41\n', key(FPR))
		expect(r.rc).toBe(1)
		expect(r.out).toContain('Debian and Ubuntu only (this server: fedora)')
		expect(r.out).toContain('--docker-script')
		expect(r.calls).toBe('')
	})
})
