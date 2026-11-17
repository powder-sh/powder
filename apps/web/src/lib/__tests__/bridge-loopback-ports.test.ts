import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	bridgeShellFunctions,
	bridgeSkipClass,
	bridgeVerdictMarkerFor,
	parseBridgeVerdict,
} from '../deploy/fragments'
import { reportDeployWarningsToHq } from '../hq'
import { writeFakeDocker } from './fixtures/fake-docker'

// A traefik-routed app that also publishes a loopback port (e.g.
// 127.0.0.1:3040:3000) is bridged in traefik mode: loopback-only bindings are
// tolerated (the clone publishes none); any other interface skips as its own
// verdict, host-ports.
// Runs the generated shell against a fake `docker` on PATH.

const NONCE = 'lb42'
const TRAEFIK =
	'powder.bridge.enabled=true\ntraefik.enable=true\ntraefik.http.routers.x.rule=Host(`x`)\ntraefik.http.services.x.loadbalancer.server.port=3000\n'

type Opts = { labels?: string; bindings: string; hostPort?: string }

function run(o: Opts) {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-lb-'))
	const labels = o.labels ?? TRAEFIK
	writeFileSync(join(dir, 'labels.txt'), labels)
	writeFileSync(join(dir, 'pb.txt'), o.bindings)
	const lc = labels.split('\n').filter(Boolean).length
	const pbLen = new Set(
		o.bindings
			.split('\n')
			.filter(Boolean)
			.map((l) => l.split('|')[0]),
	).size
	writeFakeDocker(dir, `#!/bin/bash
case "$*" in
 create*) echo "$*" > ${dir}/create;;
 *"ps -q"*) echo oldid;;
 *State.Running*) echo true;;
 *State.Health*) echo healthy;;
 *'index .Config.Labels "powder.bridge.enabled"'*) echo true;;
 *'index .Config.Labels "powder.bridge.host-port"'*) echo '${o.hostPort ?? ''}';;
 *'index .Config.Labels "powder.bridge"}}'*) echo '/opt/apps/demo|app';;
 *boot-push-ok*) echo false;;
 *"len .HostConfig.PortBindings"*) echo ${pbLen};;
 *"range \\$p,\\$v := .HostConfig.PortBindings"*) cat ${dir}/pb.txt;;
 *NetworkMode*) echo web;;
 *"len .Mounts"*|*"len .HostConfig.Binds"*) echo 0;;
 *"len .HostConfig.ExtraHosts"*) echo '0|0|0|0|<nil>|67108864';;
 *"range .HostConfig.ExtraHosts"*) :;;
 *"json .Config.Env"*) echo '[]';;
 *"json .Config.Labels"*) echo '{}';;
 *"len .Config.Labels"*) echo ${lc};;
 *'range $k,$v := .Config.Labels'*) cat ${dir}/labels.txt;;
 *"{{.Image}}"*) echo sha256:abc;;
 *Healthcheck*) echo y;;
 *"json .Config.Cmd"*) echo '["node","server.js"]null';;
 *NetworkSettings.Networks*) echo 'web ';;
 *"{{.Name}}"*) echo /demo;;
 *HostConfig.PidsLimit*) echo '<nil>';;
 *HostConfig.ReadonlyRootfs*) echo false;;
esac
exit 0
`)
	writeFileSync(join(dir, 'curl'), '#!/bin/bash\necho 200\n', { mode: 0o755 })
	writeFileSync(join(dir, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
	const body = `cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE)} bridge_start; echo rc=$?`
	const out = execFileSync('bash', ['-c', body], {
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
	}).toString()
	let create = ''
	try {
		create = readFileSync(join(dir, 'create'), 'utf8')
	} catch {}
	return { out, create }
}

afterEach(() => {
	vi.unstubAllGlobals()
	delete process.env.POWDER_HQ_INGEST_TOKEN
	delete process.env.POWDER_HQ_GENERIC_URL
})

describe('bridge with loopback-only published ports (traefik mode)', () => {
	it.each([
		['127.0.0.1', '3000/tcp|127.0.0.1|3040\n'],
		['::1', '3000/tcp|::1|3040\n'],
		['both loopbacks', '3000/tcp|127.0.0.1|3040\n3000/tcp|::1|3040\n'],
	])('bridges a traefik app bound to %s, publishing nothing on the clone', (_n, bindings) => {
		const r = run({ bindings })
		expect(r.out).not.toMatch(/skipped/)
		expect(r.out).toContain('loopback-only host ports stay on the old container')
		expect(r.out).toContain('overlapping old and new during the swap')
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('bridged')
		expect(r.create).not.toMatch(/(^|\s)-p\s/)
		expect(r.create).toContain('--label-file')
		expect(r.out).toContain('rc=0')
	})
	it.each([
		['0.0.0.0', '3000/tcp|0.0.0.0|3040\n'],
		['empty HostIp (all interfaces)', '3000/tcp||3040\n'],
		['a LAN ip', '3000/tcp|10.0.0.5|3040\n'],
		['loopback plus a public one', '3000/tcp|127.0.0.1|3040\n3000/tcp|0.0.0.0|3040\n'],
		['127.0.0.10 (not 127.0.0.1)', '3000/tcp|127.0.0.10|3040\n'],
	])('skips on %s as host-ports, naming the compose ports line', (_n, bindings) => {
		const r = run({ bindings })
		expect(r.out).toContain(
			'[bridge] skipped: app publishes host ports on a public interface (drop the ports line',
		)
		expect(r.out).toContain('[bridge] WARNING: traefik app not bridged')
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('host-ports')
		expect(r.create).toBe('')
		expect(r.out).toContain('rc=0')
	})
	it('a loopback-bound app traefik does not route still skips (not-routed)', () => {
		const r = run({ labels: 'powder.bridge.enabled=true\n', bindings: '3000/tcp|127.0.0.1|3040\n' })
		expect(r.out).toContain('[bridge] skipped: app publishes host ports and is not traefik-routed')
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('not-routed')
		expect(r.create).toBe('')
	})
	it('nginx host-port mode is unchanged: publishes 127.0.0.1:N and drops traefik labels', () => {
		const r = run({ hostPort: '13040', bindings: '3000/tcp|127.0.0.1|3040\n' })
		expect(r.out).not.toMatch(/skipped|loopback-only host ports/)
		expect(r.out).toContain('answering on 127.0.0.1:13040')
		expect(r.create).toContain('-p 127.0.0.1:13040:3000 ')
	})
	it('nginx host-port mode still refuses a public binding', () => {
		const r = run({ hostPort: '13040', bindings: '3000/tcp|0.0.0.0|3040\n' })
		expect(r.out).toContain(
			'[bridge] skipped: host-port mode needs a tcp port bound to 127.0.0.1 only',
		)
		expect(r.create).toBe('')
	})
	it('port skips get their own class', () => {
		expect(bridgeSkipClass('app publishes host ports on a public interface (x)')).toBe('host-ports')
		expect(bridgeSkipClass('could not read port bindings of the current container')).toBe('failed')
	})
	it('the host-ports card names the compose ports line to drop', async () => {
		process.env.POWDER_HQ_INGEST_TOKEN = 't'
		process.env.POWDER_HQ_GENERIC_URL = 'http://hq/generic'
		const bodies: Record<string, unknown>[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_u: string, i: { body: string }) => {
				bodies.push(JSON.parse(i.body))
				return new Response('ok')
			}),
		)
		await reportDeployWarningsToHq({
			app: 'shop',
			server: 'web1',
			envRefusedKeys: null,
			builderFallback: null,
			bridge: 'host-ports',
		})
		const card = bodies.find((b) => b.source_ref === 'no-bridge:web1/shop')
		expect(card).toMatchObject({ severity: 'warn' })
		expect(String(card?.body)).toContain(
			'drop the ports line of this service in the server compose',
		)
	})
})

// The marker helper is shared with the warn test; keep the nonce wiring honest here too.
it('nonce marker present', () =>
	expect(bridgeVerdictMarkerFor(NONCE)).toBe('__POWDER_BRIDGE_lb42__'))
