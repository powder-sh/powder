import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { syntaxAllowed } from '../build-cache'
import {
	type ComposeGuardContext,
	LOW_SEVERITY_CODES,
	composeViolations,
	isHighSeverity,
} from '../compose-safety'
import { dockerfileFor } from '../framework-detect'

// warn mode enforces only high-severity codes on a changed compose. An allow-list
// of high codes would miss root-on-host and cross-app keys, so every
// code is high unless it is on the explicit LOW_SEVERITY_CODES list.

const SRC = readFileSync(join(__dirname, '../compose-safety.ts'), 'utf8')

/** Every rule code compose-safety.ts can emit, read from its source. */
function emittedCodes(): Set<string> {
	const codes = new Set<string>()
	for (const m of SRC.matchAll(/add\(\s*s,\s*'([a-z_]+)'/g)) codes.add(m[1] ?? '')
	for (const m of SRC.matchAll(/code:\s*'([a-z_]+)'/g)) codes.add(m[1] ?? '')
	for (const m of SRC.matchAll(/^\t([a-z_]+): DENY,/gm)) codes.add(m[1] ?? '') // add(s, k, ...)
	for (const k of ['secret', 'config']) codes.add(k) // checkTopLevelFiles: code: kind
	return codes
}

const ctx: ComposeGuardContext = { appName: 'myapp', projectDir: '/opt/apps/myapp' }
const svc = (def: Record<string, unknown>) => ({
	name: 'myapp',
	services: { myapp: { image: 'myapp:latest', ...def } },
})
const codes = (def: Record<string, unknown>) => composeViolations(svc(def), ctx).map((v) => v.code)

describe('severity is high by default', () => {
	it('every code the guard can emit is high or on the explicit low list', () => {
		const all = emittedCodes()
		expect(all.size).toBeGreaterThan(30)
		for (const code of all) {
			if (LOW_SEVERITY_CODES.has(code)) expect(isHighSeverity({ code, message: '' })).toBe(false)
			else expect(isHighSeverity({ code, message: '' }), code).toBe(true)
		}
		// the low list names only codes that exist (no stale entries)
		for (const code of LOW_SEVERITY_CODES) expect(all.has(code), code).toBe(true)
		expect(isHighSeverity({ code: 'a_code_added_later', message: '' })).toBe(true)
	})
	it('the control-byte and runtime codes are high', () => {
		for (const code of [
			'device_cgroup_rules',
			'use_api_socket',
			'cgroup',
			'cgroup_parent',
			'runtime',
			'gpus',
			'isolation',
			'storage_opt',
			'blkio_config',
			'credential_spec',
			'provider',
			'external_links',
			'traefik_tcp',
			'traefik_url',
			'network',
			'image',
			'image_name',
		])
			expect(isHighSeverity({ code, message: '' }), code).toBe(true)
	})
	it('DENY keys produce their own (high) code', () => {
		for (const k of ['device_cgroup_rules', 'use_api_socket', 'runtime', 'gpus', 'cgroup_parent']) {
			const c = codes({ [k]: k === 'use_api_socket' ? true : ['x'] })
			expect(c, k).toContain(k)
		}
	})
})

describe('Traefik service URL / address labels', () => {
	it('flags loadbalancer server url and address (http, tcp, udp)', () => {
		for (const l of [
			'traefik.http.services.myapp.loadbalancer.server.url=http://victim:3000',
			'traefik.http.services.myapp.loadbalancer.servers[0].url=http://10.0.0.1',
			'traefik.tcp.services.myapp.loadbalancer.server.address=victim:5432',
			'traefik.udp.services.myapp.loadbalancer.server.address=victim:53',
		])
			expect(codes({ labels: [l] }), l).toContain('traefik_url')
		expect(
			codes({ labels: ['traefik.http.services.myapp.loadbalancer.server.port=3000'] }),
		).not.toContain('traefik_url')
	})
})

describe('built images named like Docker / BuildKit or powder images', () => {
	const built = (image: string) => codes({ image, build: { context: '.' } })
	it('flags docker/, moby/ and powder names, with or without docker.io / library', () => {
		for (const ref of [
			'docker/dockerfile:1',
			'docker.io/docker/dockerfile:1.4',
			'index.docker.io/docker/dockerfile',
			'moby/buildkit:latest',
			'docker.io/moby/buildkit',
			'powder:latest',
			'powder-worker',
			'docker.io/library/powder:latest',
			'powder-postgres:16',
		])
			expect(built(ref), ref).toContain('image_name')
		expect(codes({ build: { context: '.', tags: ['docker/dockerfile:1'] } })).toContain(
			'image_name',
		)
	})
	it('the app own image names still pass', () => {
		expect(built('myapp:latest')).not.toContain('image_name')
		expect(built('myapp-web:deploy-3')).not.toContain('image_name')
		expect(built('ghcr.io/acme/myapp:1')).not.toContain('image_name')
	})
	it('a compose project named powder does not make powder images own', () => {
		const v = composeViolations(
			{ name: 'powder', services: { web: { image: 'powder:latest', build: { context: '.' } } } },
			ctx,
		).map((x) => x.code)
		expect(v).toContain('image_name')
	})
})

// Powder's own Dockerfiles pin the frontend by digest, and the
// allow-list takes the digest form and still the plain tag form apps use.
describe('syntax frontend pins', () => {
	it('docker/web.Dockerfile and the generated Dockerfiles pin docker/dockerfile by digest', () => {
		const web = readFileSync(join(__dirname, '../../../../../docker/web.Dockerfile'), 'utf8')
		const first = web.split('\n')[0] ?? ''
		expect(first).toMatch(/^# syntax=docker\/dockerfile:1@sha256:[0-9a-f]{64}$/)
		expect(syntaxAllowed(first.replace('# syntax=', ''))).toBe(true)
		const gen = dockerfileFor(
			{ id: 'node', displayName: 'node', defaultContainerPort: 3000 },
			'npm',
			'myapp',
		)
		const line = gen.split('\n')[0] ?? ''
		expect(line).toMatch(/^# syntax=docker\/dockerfile:1\.4@sha256:[0-9a-f]{64}$/)
		expect(syntaxAllowed(line.replace('# syntax=', ''))).toBe(true)
	})
	it('the tag form still passes', () => {
		for (const v of [
			'docker/dockerfile:1',
			'docker/dockerfile:1.4',
			'docker.io/docker/dockerfile:1',
		])
			expect(syntaxAllowed(v), v).toBe(true)
	})
})
