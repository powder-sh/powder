import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bridgeShellFunctions, bridgeSkipClass, parseBridgeVerdict, parseNginxUpstreamVerdict } from '../deploy/fragments'
import { reportDeployWarningsToHq, stabilityCardPlan } from '../hq'
import { writeFakeDocker } from './fixtures/fake-docker'

// DNS-alias bridge mode (labels powder.bridge.enabled=true + powder.bridge.dns-alias=true):
// for apps behind a proxy CONTAINER that resolves them by docker DNS name per request
// (nginx `resolver 127.0.0.11` + a variable proxy_pass). The clone joins the old
// container's user-defined networks carrying the old container's own name as a network
// alias, so docker DNS answers that name with old + bridge, and later new + bridge.
// Runs the generated shell against a fake `docker` on PATH.

const NONCE = 'dns7'
const TAG = '/opt/apps/demo|app'
const BASE = 'com.docker.compose.project=demo\ncom.docker.compose.service=app\npowder.bridge.enabled=true\npowder.bridge.dns-alias=true\n'

type Opts = {
	labels?: string
	/** extra label lines appended to BASE */
	extra?: string
	bindings?: string
	extraHosts?: string[]
	healthcheck?: boolean
	exposed?: string
	/** `<net>|<alias> <alias> ` lines, one per network (the order docker prints: sorted) */
	nets?: string
	name?: string
	netMode?: string
	cmd?: string
	connectFail?: boolean
	nginx?: string
}

function run(o: Opts = {}, handoff = false) {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-dns-'))
	const labels = o.labels ?? BASE + (o.extra ?? '')
	writeFileSync(join(dir, 'labels.txt'), labels)
	const lc = labels.split('\n').filter(Boolean).length
	const bindings = o.bindings ?? ''
	writeFileSync(join(dir, 'pb.txt'), bindings)
	const pbLen = new Set(
		bindings
			.split('\n')
			.filter(Boolean)
			.map((l) => l.split('|')[0]),
	).size
	const eh = o.extraHosts ?? []
	writeFileSync(join(dir, 'eh.txt'), eh.map((e) => `${e}\n`).join(''))
	const nets = o.nets ?? 'demo_default|demo app \n'
	writeFileSync(join(dir, 'nal.txt'), nets)
	writeFileSync(
		join(dir, 'nets.txt'),
		`${nets
			.split('\n')
			.filter(Boolean)
			.map((l) => l.split('|')[0])
			.join(' ')} \n`,
	)
	writeFileSync(join(dir, 'exposed.txt'), o.exposed ?? '3000/tcp \n')
	const log = join(dir, 'calls.log')
	writeFakeDocker(
		dir,
		`#!/bin/bash
echo "$*" >> ${log}
if [[ "$*" =~ index\\ .Config.Labels\\ \\"([^\\"]+)\\" ]]; then
 __k="\${BASH_REMATCH[1]}"
 if [ "$__k" = powder.bridge ]; then echo '${TAG}'; exit 0; fi
 grep "^$__k=" ${dir}/labels.txt | head -1 | cut -d= -f2-
 exit 0
fi
case "$*" in
 create*) echo "$*" > ${dir}/create; __p=""; for __a in "$@"; do if [ "$__p" = --label-file ]; then cp "$__a" ${dir}/lf; fi; __p="$__a"; done;;
 "network connect"*) echo "$*" >> ${dir}/connect; ${o.connectFail ? 'exit 1' : ':'};;
 start*|stop*|exec*|"rm "*) :;;
 *"compose"*"ps -q"*) echo oldid;;
 *"ps -aq"*) :;;
 *State.Running*) echo true;;
 *State.Health*) echo healthy;;
 *"len .HostConfig.PortBindings"*) echo ${pbLen};;
 *'range $p,$v := .HostConfig.PortBindings'*) cat ${dir}/pb.txt;;
 *NetworkMode*) echo ${o.netMode ?? 'demo_default'};;
 *"len .Mounts"*|*"len .HostConfig.Binds"*) echo 0;;
 *"range .HostConfig.Binds"*) :;;
 *"len .HostConfig.ExtraHosts"*) echo '${eh.length}|0|0|0|<nil>|67108864';;
 *"range .HostConfig.ExtraHosts"*) cat ${dir}/eh.txt;;
 *"json .Config.Env"*) echo '["A=1"]';;
 *"range .Config.Env"*) echo A=1;;
 *"json .Config.Labels"*) echo '{}';;
 *"len .Config.Labels"*) echo ${lc};;
 *'range $k,$v := .Config.Labels'*) cat ${dir}/labels.txt;;
 *Healthcheck*) ${o.healthcheck ? 'echo y' : 'echo'};;
 *"json .Config.Cmd"*) echo '${o.cmd ?? '["node","server.js"]null'}';;
 *"{{.Image}}"*) echo sha256:abc;;
 *'range $p,$v := .Config.ExposedPorts'*) cat ${dir}/exposed.txt;;
 *"range .HostConfig.CapDrop"*) echo 'ALL ';;
 *"range .HostConfig.SecurityOpt"*) :;;
 *'{{$k}}|{{range $v.Aliases}}'*) cat ${dir}/nal.txt;;
 *'range $k,$v := .NetworkSettings.Networks'*) cat ${dir}/nets.txt;;
 *"range .NetworkSettings.Networks"*) echo '172.20.0.9 ';;
 *"{{.Name}}"*) echo /${o.name ?? 'demo'};;
 *HostConfig.PidsLimit*) echo '<nil>';;
 *HostConfig.ReadonlyRootfs*) echo false;;
esac
exit 0
`,
	)
	writeFileSync(join(dir, 'curl'), '#!/bin/bash\necho 200\n', { mode: 0o755 })
	writeFileSync(join(dir, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
	if (o.nginx !== undefined) {
		writeFileSync(join(dir, 'conf'), o.nginx)
		writeFileSync(join(dir, 'nginx'), `#!/bin/bash\n[ "$1" = -T ] || exit 9\ncat ${join(dir, 'conf')}\n`, { mode: 0o755 })
	}
	const body = `cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE)} bridge_start; echo rc=$?; ${handoff ? 'bridge_handoff; echo hrc=$?;' : ''}`
	const out = execFileSync('bash', ['-c', body], {
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
	}).toString()
	const read = (f: string) => {
		try {
			return readFileSync(join(dir, f), 'utf8')
		} catch {
			return ''
		}
	}
	return { out, create: read('create'), connect: read('connect'), labelFile: read('lf'), calls: read('calls.log') }
}

describe('bridge dns-alias mode', () => {
	it('bridges: alias = old container name + its service alias, no host ports, no healthcheck needed', () => {
		const r = run()
		expect(r.out).not.toMatch(/skipped/)
		expect(r.out).toContain(
			'[bridge] demo-powder-bridge answering on :3000 (DNS-alias mode: docker DNS also answers demo app with the bridge) - overlapping old and new during the swap',
		)
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('bridged')
		expect(r.create).toContain('--name demo-powder-bridge ')
		expect(r.create).toContain('--network demo_default ')
		expect(r.create).toContain('--network-alias demo --network-alias app ')
		expect(r.create).not.toMatch(/ -p /)
		expect(r.create).not.toContain('--publish')
		expect(r.out).toContain('rc=0')
	})
	it('drops traefik labels and adds traefik.enable=false', () => {
		const r = run({ extra: 'traefik.http.middlewares.m.headers.x=1\n' })
		expect(r.out).not.toMatch(/skipped/)
		expect(r.labelFile).not.toMatch(/^traefik\.http\./m)
		expect(r.labelFile).toMatch(/^traefik\.enable=false$/m)
		expect(r.labelFile).not.toMatch(/^com\.docker\.compose\./m)
		expect(r.labelFile).toMatch(/^powder\.bridge\.dns-alias=true$/m)
	})
	it('the alias comes from the old container inspect name, never from a label', () => {
		const r = run({
			extra: 'powder.bridge.dns-alias.name=otherapp\npowder.bridge.alias=otherapp\ncom.docker.compose.container-name=otherapp\n',
			name: 'demo',
			nets: 'demo_default|demo app \n',
		})
		expect(r.out).not.toMatch(/skipped/)
		expect(r.create).not.toContain('otherapp ')
		expect(r.create).toMatch(/--network-alias demo /)
		expect(r.calls).toContain("-f {{.Name}} oldid")
	})
	it('the service alias is copied only where the old container already has it', () => {
		const r = run({ nets: 'a_net|demo \nb_net|demo app \n' })
		expect(r.out).not.toMatch(/skipped/)
		expect(r.create).toContain('--network a_net ')
		expect(r.create).toContain('--network-alias demo ')
		expect(r.create).not.toContain('--network-alias app')
		expect(r.connect).toBe('network connect --alias demo --alias app b_net demo-powder-bridge\n')
	})
	it('other aliases of the old container are not copied', () => {
		const r = run({ nets: 'demo_default|demo app shop.internal otherapp \n' })
		expect(r.out).not.toMatch(/skipped/)
		expect(r.create).toContain('--network-alias demo --network-alias app ')
		expect(r.create).not.toMatch(/shop\.internal|otherapp/)
	})
	it('service name equal to the container name gives one alias', () => {
		const r = run({ name: 'app', nets: 'demo_default|app \n' })
		expect(r.out).not.toMatch(/skipped/)
		expect(r.create).toContain('--name app-powder-bridge ')
		expect(r.create.match(/--network-alias/g)).toHaveLength(1)
	})
	it.each([['demo-powder-bridge'], ['-x'], ['a b']])('skips on an unexpected old container name %j', (name) => {
		const r = run({ name })
		expect(r.out).toContain('[bridge] skipped: dns-alias mode: unexpected container name')
		expect(r.create).toBe('')
	})
	it('joins the default bridge network plain, aliases only on user-defined networks', () => {
		const r = run({ nets: 'bridge|\nzz_net|demo app \n' })
		expect(r.out).not.toMatch(/skipped/)
		expect(r.create).toContain('--network zz_net ')
		expect(r.connect).toBe('network connect bridge demo-powder-bridge\n')
	})
	it('skips without a user-defined network', () => {
		const r = run({ nets: 'bridge|\n', netMode: 'bridge' })
		expect(r.out).toContain('[bridge] skipped: dns-alias mode needs a user-defined docker network')
		expect(r.create).toBe('')
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('unsupported')
	})
	it('a failed network connect skips and removes the bridge', () => {
		const r = run({ nets: 'a_net|demo app \nb_net|demo app \n', connectFail: true })
		expect(r.out).toContain('[bridge] skipped: docker network connect failed')
		expect(r.out).toContain('[bridge] removed demo-powder-bridge')
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('failed')
	})
	it('copies extra_hosts as --add-host (name:ip / name:host-gateway only)', () => {
		const r = run({ extraHosts: ['host.docker.internal:host-gateway', 'db:10.0.0.5'] })
		expect(r.out).not.toMatch(/skipped/)
		expect(r.create).toContain('--add-host host.docker.internal:host-gateway')
		expect(r.create).toContain('--add-host db:10.0.0.5')
		const bad = run({ extraHosts: ['x:$(id)'] })
		expect(bad.out).toContain('[bridge] skipped: unexpected extra_hosts entry')
		expect(bad.create).toBe('')
	})
	it('loopback-only published ports stay on the old container; the bridge publishes none', () => {
		const r = run({ bindings: '3000/tcp|127.0.0.1|3011\n' })
		expect(r.out).toContain('[bridge] loopback-only host ports stay on the old container; the bridge publishes none')
		expect(r.out).not.toMatch(/skipped/)
		expect(r.create).not.toMatch(/ -p /)
	})
	it('skips on a public published port as host-ports', () => {
		for (const bindings of ['3000/tcp|0.0.0.0|3011\n', '3000/tcp||3011\n']) {
			const r = run({ bindings })
			expect(r.out).toContain('[bridge] skipped: dns-alias app publishes host ports on a public interface')
			expect(r.out).toContain('[bridge] WARNING: dns-alias app not bridged')
			expect(parseBridgeVerdict(r.out, NONCE)).toBe('host-ports')
			expect(r.create).toBe('')
		}
	})
	it('app port: label powder.bridge.port wins over the exposed port', () => {
		const r = run({ extra: 'powder.bridge.port=8080\n', exposed: '3000/tcp 9229/tcp \n' })
		expect(r.out).not.toMatch(/skipped/)
		expect(r.out).toContain('answering on :8080 (DNS-alias mode')
	})
	it.each([['0'], ['abc'], ['65536'], ['080'], ['123456'], ['80 ']])('skips on an invalid powder.bridge.port %j', (p) => {
		const r = run({ extra: `powder.bridge.port=${p}\n` })
		expect(r.out).toContain('[bridge] skipped: invalid powder.bridge.port label (want 1-65535)')
		expect(r.create).toBe('')
	})
	it.each([['', 'none'], ['3000/tcp 9229/tcp ', 'two'], ['53/udp ', 'udp only']])(
		'skips when the image exposes %j (%s) and there is no port label',
		(exposed) => {
			const r = run({ exposed: `${exposed}\n` })
			expect(r.out).toContain('[bridge] skipped: dns-alias mode needs the app port')
			expect(r.create).toBe('')
			expect(parseBridgeVerdict(r.out, NONCE)).toBe('unsupported')
		},
	)
	it('skips on a boot-time schema push unless boot-push-ok', () => {
		const cmd = '["sh","-c","npx drizzle-kit push --force && node server.js"]null'
		const r = run({ cmd })
		expect(r.out).toContain('[bridge] skipped: boot-time schema push in command')
		expect(r.out).toContain('[bridge] WARNING: dns-alias app not bridged')
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('unsupported')
		expect(run({ cmd, extra: 'powder.bridge.boot-push-ok=true\n' }).out).not.toMatch(/skipped/)
	})
	it('skips with host-port and dns-alias both set', () => {
		const r = run({ extra: 'powder.bridge.host-port=13000\n', bindings: '3000/tcp|127.0.0.1|3000\n' })
		expect(r.out).toContain('[bridge] skipped: powder.bridge.dns-alias and powder.bridge.host-port are both set')
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('unsupported')
		expect(r.create).toBe('')
	})
	it('a traefik-routed app keeps the traefik mode', () => {
		const r = run({
			extra: 'traefik.enable=true\ntraefik.http.routers.x.rule=Host(`x`)\ntraefik.http.services.x.loadbalancer.server.port=3000\n',
			healthcheck: true,
		})
		expect(r.out).toContain('[bridge] powder.bridge.dns-alias ignored: the app is traefik-routed')
		expect(r.out).toContain('answering on :3000 - overlapping')
		expect(r.create).not.toContain('--network-alias')
		expect(r.labelFile).toMatch(/^traefik\.http\.routers\.x\.rule=/m)
	})
	it('skips host nginx checks entirely: no nginx marker, no nginx-unbridged', () => {
		const r = run({ nginx: 'upstream u { server 127.0.0.1:3000; server 127.0.0.1:13000 backup; }\n' })
		expect(r.out).toContain('[nginx] host nginx checks not run')
		expect(r.out).not.toContain('[nginx] WARNING')
		expect(parseNginxUpstreamVerdict(r.out, NONCE)).toEqual({ server: null, app: 'n/a' })
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('bridged')
	})
	it('handoff: waits for the new container, keeps the bridge >= 6 s, then removes it (no traefik compare)', () => {
		const r = run({}, true)
		expect(r.out).not.toMatch(/skipped|traefik labels differ/)
		expect(r.out).toContain('new container ready; draining bridge')
		expect(r.out).toContain('[bridge] removed demo-powder-bridge')
		expect(r.out).toContain('hrc=0')
		const changes = r.calls.split('\n').filter((l) => /^(create|start|stop|exec|network connect|rm) /.test(l))
		expect(changes.map((l) => l.replace(/^create .*/, 'create'))).toEqual([
			'create',
			'start demo-powder-bridge',
			'exec demo-powder-bridge touch /tmp/.powder-ready',
			'exec demo-powder-bridge rm -f /tmp/.powder-ready',
			'stop -t 10 demo-powder-bridge',
			'rm -f demo-powder-bridge',
		])
	})
	it('without the dns-alias label an unrouted enabled app stays not-routed (no alias)', () => {
		const r = run({ labels: 'powder.bridge.enabled=true\n' })
		expect(r.out).toContain('[bridge] not traefik-routed')
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('not-routed')
		expect(r.create).toBe('')
	})
	it('dns-alias=false or other values do not enable the mode', () => {
		const r = run({ labels: 'powder.bridge.enabled=true\npowder.bridge.dns-alias=yes\n' })
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('not-routed')
		expect(r.create).toBe('')
	})
	it('skip reasons classify as intended', () => {
		expect(bridgeSkipClass('dns-alias app publishes host ports on a public interface (x)')).toBe('host-ports')
		expect(bridgeSkipClass('could not read network aliases of the current container')).toBe('failed')
		expect(bridgeSkipClass('dns-alias mode: unexpected container name')).toBe('unsupported')
	})
	it('bash -n accepts the generated functions', () => {
		execFileSync('bash', ['-n'], { input: `cap() { :; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE)}` })
	})
})

describe('no-bridge card on an nginx-container server', () => {
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
	const base = { app: 'demo', server: 'mar', envRefusedKeys: null, builderFallback: null }
	const noBridge = (b: Record<string, unknown>[]) => b.filter((x) => x.source_ref === 'no-bridge:mar/demo')
	it('not-routed + nginx-container: the plan carries the dns-alias hint; other proxies do not', () => {
		const plan = stabilityCardPlan({ ...base, bridge: 'not-routed', serverProxy: 'nginx-container' })
		const c = plan.find((p) => p.key === 'no-bridge:mar/demo')
		expect(c?.raise?.body).toContain('powder.bridge.enabled=true and LABEL powder.bridge.dns-alias=true')
		for (const serverProxy of ['traefik', 'nginx', null] as const)
			expect(stabilityCardPlan({ ...base, bridge: 'not-routed', serverProxy }).filter((p) => p.key.startsWith('no-bridge'))).toEqual([])
		expect(
			stabilityCardPlan({ ...base, bridge: 'bridged', serverProxy: 'nginx-container' }).filter((p) => p.key.startsWith('no-bridge')),
		).toEqual([])
	})
	it('switch off: resolves (as before) and logs the would-warn line', async () => {
		const bodies = capture()
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		await reportDeployWarningsToHq({ ...base, bridge: 'not-routed', serverProxy: 'nginx-container' })
		expect(noBridge(bodies)).toHaveLength(1)
		expect(noBridge(bodies)[0]?.resolve).toBe(true)
		expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/^\[stability\] would warn: no-bridge:mar\/demo .*dns-alias/))
	})
	it('switch on: one warn card with the hint; bridged resolves it', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		await reportDeployWarningsToHq({ ...base, bridge: 'not-routed', serverProxy: 'nginx-container' })
		expect(noBridge(bodies)).toHaveLength(1)
		expect(noBridge(bodies)[0]).toMatchObject({ severity: 'warn', project: 'demo' })
		expect(String(noBridge(bodies)[0]?.body)).toContain('powder.bridge.dns-alias=true')
		await reportDeployWarningsToHq({ ...base, bridge: 'bridged', serverProxy: 'nginx-container' })
		expect(noBridge(bodies)[1]?.resolve).toBe(true)
	})
	it('a dns-alias skip card names the mode, not traefik', async () => {
		const bodies = capture()
		await reportDeployWarningsToHq({ ...base, bridge: 'unsupported', serverProxy: 'nginx-container' })
		const body = String(noBridge(bodies)[0]?.body)
		expect(body).toContain('DNS-alias mode')
		expect(body).not.toContain('routed by traefik')
		await reportDeployWarningsToHq({ ...base, bridge: 'unsupported', serverProxy: 'traefik' })
		expect(String(noBridge(bodies)[1]?.body)).toContain('routed by traefik')
	})
	it('not-routed on a traefik server still resolves', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		const bodies = capture()
		await reportDeployWarningsToHq({ ...base, bridge: 'not-routed', serverProxy: 'traefik' })
		expect(noBridge(bodies)).toHaveLength(1)
		expect(noBridge(bodies)[0]?.resolve).toBe(true)
	})
})
