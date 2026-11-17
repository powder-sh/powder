import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOT_SCHEMA_PUSH_ERE, bridgeShellFunctions, bridgeVerdictMarkerFor, parseBridgeVerdict } from '../deploy/fragments'
import { reportDeployWarningsToHq, stabilityCardPlan, stabilityCardsOn } from '../hq'
import { writeFakeDocker } from './fixtures/fake-docker'
import { pathWithout } from './hermetic'

// An app without the bridge label that traefik does not route is not simply
// not-routed (which resolves the no-bridge card): an nginx-fronted or host-network
// app still 502s on each swap. The "not enabled" branch tells these cases apart
// (read-only, warnings only): nginx-unbridged (host nginx proxies to the
// container's published 127.0.0.1 port) and host-network. Anything unreadable
// falls back to not-routed.

const NONCE = 'abc123'
const MARK = bridgeVerdictMarkerFor(NONCE)

type Opts = {
	/** `<containerPort>/tcp|<hostIp>|<hostPort>` lines */
	bindings?: string
	netMode?: string | null
	labels?: string
	/** null = no nginx on PATH; 'fail' = nginx -T exits 1 */
	nginx?: string | null | 'fail'
}

function run(o: Opts): string {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-unb-'))
	writeFileSync(join(dir, 'labels.txt'), o.labels ?? 'com.docker.compose.service=app\n')
	writeFileSync(join(dir, 'bindings.txt'), o.bindings ?? '')
	const nm = o.netMode === null ? 'exit 1' : `echo ${o.netMode ?? 'app_default'}`
	writeFakeDocker(
		dir,
		`#!/bin/bash
case "$*" in
 *"ps -q"*) echo oldid;;
 *State.Running*) echo true;;
 *'index .Config.Labels "powder.bridge.enabled"'*) echo;;
 *'range $k,$v := .Config.Labels'*) cat ${dir}/labels.txt;;
 *NetworkMode*) ${nm};;
 *'range $p,$v := .HostConfig.PortBindings'*) cat ${dir}/bindings.txt;;
esac
exit 0
`,
	)
	writeFileSync(join(dir, 'curl'), '#!/bin/bash\necho 200\n', { mode: 0o755 })
	if (o.nginx === 'fail') {
		writeFileSync(join(dir, 'nginx'), '#!/bin/bash\necho "nginx: [emerg] x" >&2\nexit 1\n', { mode: 0o755 })
	} else if (o.nginx !== null && o.nginx !== undefined) {
		writeFileSync(join(dir, 'conf'), o.nginx)
		writeFileSync(join(dir, 'nginx'), `#!/bin/bash\n[ "$1" = -T ] || exit 9\ncat ${join(dir, 'conf')}\n`, { mode: 0o755 })
	}
	const body = `set -e; cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE)} { bridge_start || true; } && echo rc=$?`
	return execFileSync('bash', ['-c', body], {
		env: { ...process.env, PATH: `${dir}:${pathWithout(['nginx'])}` },
	}).toString()
}

const VHOST = (target: string) => `# configuration file /etc/nginx/sites-enabled/demo:
server {
\tserver_name demo.example.com;
\tlocation / { proxy_pass http://${target}; }
}
`
const LOOP = '3000/tcp|127.0.0.1|3004\n'

describe('bridge verdict for apps traefik does not route', () => {
	it('nginx proxies to the published loopback port: nginx-unbridged, warns, rc=0', () => {
		const out = run({ bindings: LOOP, nginx: VHOST('127.0.0.1:3004') })
		expect(out).toContain('[bridge] WARNING: nginx-fronted app not bridged')
		expect(out).toContain('rc=0')
		expect(parseBridgeVerdict(out, NONCE)).toBe('nginx-unbridged')
	})
	it('localhost and an upstream block count too', () => {
		expect(parseBridgeVerdict(run({ bindings: LOOP, nginx: VHOST('localhost:3004/') }), NONCE)).toBe('nginx-unbridged')
		expect(
			parseBridgeVerdict(run({ bindings: LOOP, nginx: 'upstream u { server 127.0.0.1:3004 max_fails=0; }\n' }), NONCE),
		).toBe('nginx-unbridged')
	})
	it('nginx names another port, a longer port or only a comment: not-routed', () => {
		for (const conf of [VHOST('127.0.0.1:3005'), VHOST('127.0.0.1:30040'), '# proxy_pass http://127.0.0.1:3004;\n', '']) {
			const out = run({ bindings: LOOP, nginx: conf })
			expect(out).toContain('[bridge] not traefik-routed')
			expect(parseBridgeVerdict(out, NONCE)).toBe('not-routed')
		}
	})
	it('nginx missing or failing: falls back to not-routed', () => {
		for (const nginx of [null, 'fail'] as const) {
			const out = run({ bindings: LOOP, nginx })
			expect(out).not.toContain('WARNING')
			expect(parseBridgeVerdict(out, NONCE)).toBe('not-routed')
			expect(out).toContain('rc=0')
		}
	})
	it('a binding on a public interface or no binding: not-routed', () => {
		for (const bindings of ['3000/tcp|0.0.0.0|3004\n', '3000/tcp||3004\n', '']) {
			expect(parseBridgeVerdict(run({ bindings, nginx: VHOST('127.0.0.1:3004') }), NONCE)).toBe('not-routed')
		}
	})
	it('host networking: host-network (nginx not needed)', () => {
		for (const nginx of [null, VHOST('127.0.0.1:3004')]) {
			const out = run({ netMode: 'host', nginx })
			expect(out).toContain('[bridge] WARNING: host-network app not bridged')
			expect(parseBridgeVerdict(out, NONCE)).toBe('host-network')
		}
	})
	it('docker inspect failing: not-routed', () => {
		const out = run({ netMode: null, bindings: LOOP, nginx: VHOST('127.0.0.1:3004') })
		expect(parseBridgeVerdict(out, NONCE)).toBe('not-routed')
		expect(out).toContain('rc=0')
	})
	it('a traefik-routed app without the label stays no-label', () => {
		const labels = 'traefik.enable=true\ntraefik.http.routers.x.rule=Host(`x`)\n'
		const out = run({ labels, bindings: LOOP, nginx: VHOST('127.0.0.1:3004') })
		expect(parseBridgeVerdict(out, NONCE)).toBe('no-label')
	})
	it('a malformed or foreign marker gives no verdict and never throws', () => {
		expect(parseBridgeVerdict(`${MARK} nginx-unbridged;x`, NONCE)).toBeNull()
		expect(parseBridgeVerdict(`${MARK}  `, NONCE)).toBeNull()
		expect(parseBridgeVerdict('__POWDER_BRIDGE_zzz__ host-network', NONCE)).toBeNull()
		expect(parseBridgeVerdict('', NONCE)).toBeNull()
	})
	it('the boot-push check keeps its exact pattern', () => {
		expect(BOOT_SCHEMA_PUSH_ERE).toBe('push[ ",]+--force|db[ ",]+push|accept-data-loss')
		expect(bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE)).toContain(
			`2>/dev/null | grep -qE 'push[ ",]+--force|db[ ",]+push|accept-data-loss'; then`,
		)
	})
	it('generated shell passes bash -n', () => {
		execFileSync('bash', ['-n'], { input: bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE) })
	})
})

describe('no-bridge card for nginx-unbridged / host-network', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		delete process.env.POWDER_HQ_INGEST_TOKEN
		delete process.env.POWDER_HQ_GENERIC_URL
		delete process.env.POWDER_STABILITY_CARDS
	})
	function capture() {
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
		return bodies
	}
	const base = { app: 'demo', server: 'web1', envRefusedKeys: null, builderFallback: null }
	it('switch off (default): resolves like not-routed and logs what it would raise', async () => {
		const bodies = capture()
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		expect(stabilityCardsOn()).toBe(false)
		await reportDeployWarningsToHq({ ...base, bridge: 'nginx-unbridged' })
		const cards = bodies.filter((b) => b.source_ref === 'no-bridge:web1/demo')
		expect(cards).toHaveLength(1)
		expect(cards[0]?.resolve).toBe(true)
		expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(
			expect.stringMatching(/^\[stability\] would warn: no-bridge:web1\/demo host nginx proxies/),
		)
	})
	it('switch on: raises one warn card per verdict with what to do', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		await reportDeployWarningsToHq({ ...base, bridge: 'nginx-unbridged' })
		await reportDeployWarningsToHq({ ...base, bridge: 'host-network' })
		const cards = bodies.filter((b) => b.source_ref === 'no-bridge:web1/demo')
		expect(cards).toHaveLength(2)
		expect(cards[0]).toMatchObject({ severity: 'warn', project: 'demo', source: 'powder-deploy-warn' })
		expect(String(cards[0]?.body)).toContain('powder.bridge.enabled=true')
		expect(String(cards[0]?.body)).toContain('backup')
		expect(String(cards[1]?.body)).toContain('move the app off host networking first')
		await reportDeployWarningsToHq({ ...base, bridge: 'not-routed' })
		expect(bodies.filter((b) => b.source_ref === 'no-bridge:web1/demo')[2]?.resolve).toBe(true)
	})
	it('the switch reads on / 1 / true only', () => {
		for (const v of ['on', 'ON', '1', 'true']) expect(stabilityCardsOn({ POWDER_STABILITY_CARDS: v })).toBe(true)
		for (const v of ['', 'off', '0', 'yes please']) expect(stabilityCardsOn({ POWDER_STABILITY_CARDS: v })).toBe(false)
		expect(stabilityCardsOn({})).toBe(false)
	})
	it('the plan has no entry for other verdicts', () => {
		for (const bridge of ['bridged', 'not-routed', 'no-label', null] as const)
			expect(stabilityCardPlan({ ...base, bridge }).filter((c) => c.key.startsWith('no-bridge'))).toEqual([])
	})
})
