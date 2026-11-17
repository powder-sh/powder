import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bridgeShellFunctions, parseBridgeVerdict } from '../deploy/fragments'
import { needTool } from './need-tool'

// End-to-end check of the bridge prelude against the REAL docker CLI. Every other
// bridge test stubs `docker`, and a stub that prints `docker inspect -f` output
// without the CLI's trailing "\n" would hide an off-by-one in the label count.
// Here every `docker inspect` (container and image)
// runs the real binary against a fake Engine API on a unix socket, so the CLI's
// own template rendering and output framing are what the prelude parses. No daemon,
// no root: the socket is ours, and the CLI never sees the host's DOCKER_* or
// ~/.docker. Skipped where no docker CLI is installed.

// the host CLI path hermetic.ts saved before it put its guard `docker` on PATH;
// only ever pointed at the fake socket below (DOCKER_HOST) with an empty config
const DOCKER = needTool('bridge-real-docker-cli', !!process.env.POWDER_TEST_HOST_DOCKER, 'no docker CLI on PATH')
	? (process.env.POWDER_TEST_HOST_DOCKER as string)
	: ''
const NONCE = 'cli9'

function container(labels: Record<string, string>) {
	return {
		Id: 'oldid',
		Name: '/demo',
		Image: 'sha256:abc',
		State: { Running: true, Status: 'running', Health: { Status: 'healthy' } },
		Config: {
			Labels: labels,
			Env: ['NODE_ENV=production', 'PORT=3000'],
			Cmd: ['node', 'server.js'],
			Healthcheck: { Test: ['CMD', 'true'] },
			ExposedPorts: { '3000/tcp': {} },
		},
		HostConfig: { NetworkMode: 'web', ShmSize: 67108864, CapDrop: ['ALL'] },
		Mounts: [],
		// a real address: bridge_http curls it. With none, docker 29 prints `invalid IP`
		// (non-empty, so the stub curl answered) and docker 28 prints nothing (the wait
		// ran its full 60 s and the test timed out on a Mac with Docker Desktop's CLI).
		NetworkSettings: { Networks: { web: { IPAddress: '172.18.0.5' } } },
	}
}

let server: Server
let sock = ''
let labels: Record<string, string> = {}

beforeAll(async () => {
	if (!DOCKER) return
	sock = join(mkdtempSync(join(tmpdir(), 'dk-')), 'd.sock')
	server = createServer((req, res) => {
		res.setHeader('Api-Version', '1.47')
		res.setHeader('Content-Type', 'application/json')
		const url = req.url ?? ''
		if (url.endsWith('/_ping')) return res.end('OK')
		if (/\/containers\/[^/]+\/json/.test(url)) return res.end(JSON.stringify(container(labels)))
		if (/\/images\/[^/]+\/json/.test(url))
			return res.end(JSON.stringify({ Id: 'sha256:abc', Config: { Cmd: ['node', 'server.js'] } }))
		res.statusCode = 404
		res.end(JSON.stringify({ message: 'No such object' }))
	})
	await new Promise<void>((r) => server.listen(sock, r))
})
afterAll(() => server?.close())

async function runBridge(l: Record<string, string>) {
	labels = l
	const dir = mkdtempSync(join(tmpdir(), 'bridge-cli-'))
	// inspect goes to the real CLI; everything that would change state is stubbed
	writeFileSync(
		join(dir, 'docker'),
		`#!/bin/bash
case "$1" in
 inspect) DOCKER_HOST=unix://${sock} exec ${JSON.stringify(DOCKER)} "$@";;
 create) while [ $# -gt 0 ]; do if [ "$1" = --label-file ]; then cp "$2" ${dir}/created-labels; fi; if [ "$1" = --env-file ]; then cp "$2" ${dir}/created-env; fi; shift; done;;
 compose) case "$*" in *"ps -q"*) echo oldid;; esac;;
esac
exit 0
`,
		{ mode: 0o755 },
	)
	writeFileSync(join(dir, 'curl'), '#!/bin/bash\necho 200\n', { mode: 0o755 })
	writeFileSync(join(dir, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
	const body = `cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE)} bridge_start; echo rc=$?`
	const { stdout } = await promisify(execFile)('bash', ['-c', body], {
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_CONFIG: dir },
	})
	const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null)
	return { out: stdout, created: read('created-labels'), env: read('created-env') }
}

const TRAEFIK = {
	'com.docker.compose.project': 'demo',
	'com.docker.compose.service': 'app',
	'powder.bridge.enabled': 'true',
	'traefik.enable': 'true',
	'traefik.http.routers.demo.rule': 'Host(`demo.example.com`)',
	'traefik.http.services.demo.loadbalancer.server.port': '3000',
}

describe.skipIf(!DOCKER)('bridge prelude against the real docker CLI', () => {
	it('bridges a normal traefik app (26 labels)', async () => {
		const l: Record<string, string> = { ...TRAEFIK }
		for (let i = 0; Object.keys(l).length < 26; i++) l[`org.example.l${i}`] = `v${i}`
		const r = await runBridge(l)
		expect(r.out).not.toMatch(/skipped/)
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('bridged')
		expect(r.created).toContain('traefik.http.routers.demo.rule=Host(`demo.example.com`)\n')
		expect(r.created).not.toContain('com.docker.compose.')
		expect(r.created?.split('\n').filter(Boolean)).toHaveLength(24)
		expect(r.env).toBe('NODE_ENV=production\nPORT=3000\n')
	})
	it('refuses a label value with an LF or CR', async () => {
		for (const v of ['a\ntraefik.http.routers.evil.rule=Host(`x`)', 'a\rb']) {
			const r = await runBridge({ ...TRAEFIK, 'org.example.note': v })
			expect(r.out).toMatch(/\[bridge\] skipped: label key or value with a line break/)
			expect(r.created).toBeNull()
		}
	})
})
