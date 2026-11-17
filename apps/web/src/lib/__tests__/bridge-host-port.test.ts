import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bridgeShellFunctions } from '../deploy/fragments'
import { writeFakeDocker } from './fixtures/fake-docker'

// Host-port bridge mode (label powder.bridge.host-port=<N>): nginx-fronted apps that
// publish 127.0.0.1:<port> get a bridge on 127.0.0.1:<N>, which the vhost lists as a
// `backup` upstream, so the deploy swap does not 502. Runs the generated shell
// against a fake `docker` on PATH.

type Opts = {
	hostPort?: string
	pbLen?: string
	bindings?: string
	extraHosts?: string[]
	healthcheck?: boolean
	labels?: string
	startFail?: boolean
}

const TAG = '/opt/apps/demo|app'

function run(o: Opts, handoff = false) {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-hp-'))
	const labels =
		o.labels ??
		`powder.bridge.enabled=true\npowder.bridge.host-port=${o.hostPort ?? ''}\ntraefik.http.routers.x.rule=Host(\`x\`)\n`
	writeFileSync(join(dir, 'labels.txt'), labels)
	const lc = labels.split('\n').filter(Boolean).length
	const eh = o.extraHosts ?? []
	writeFileSync(join(dir, 'eh.txt'), eh.map((e) => `${e}\n`).join(''))
	writeFileSync(join(dir, 'pb.txt'), o.bindings ?? '3001/tcp|127.0.0.1|3001\n')
	const log = join(dir, 'calls.log')
	writeFakeDocker(dir, `#!/bin/bash
echo "$*" >> ${log}
case "$*" in
 create*) echo "$*" > ${dir}/create; __p=""; for __a in "$@"; do if [ "$__p" = --label-file ]; then cp "$__a" ${dir}/lf; fi; __p="$__a"; done;;
 start*) ${o.startFail ? 'exit 1' : ':'};;
 *"ps -q"*) echo oldid;;
 *'index .Config.Labels "powder.bridge.enabled"'*) echo true;;
 *'index .Config.Labels "powder.bridge.host-port"'*) echo '${o.hostPort ?? ''}';;
 *'index .Config.Labels "powder.bridge"}}'*) echo '${TAG}';;
 *boot-push-ok*) echo false;;
 *State.Running*) echo true;;
 *State.Health*) echo healthy;;
 *"len .HostConfig.PortBindings"*) echo ${o.pbLen ?? '1'};;
 *"range \\$p,\\$v := .HostConfig.PortBindings"*) cat ${dir}/pb.txt;;
 *NetworkMode*) echo shop_default;;
 *"len .Mounts"*|*"len .HostConfig.Binds"*) echo 0;;
 *"len .HostConfig.ExtraHosts"*) echo '${eh.length}|0|0|0|<nil>|67108864';;
 *"range .HostConfig.ExtraHosts"*) cat ${dir}/eh.txt;;
 *"json .Config.Env"*) echo '[]';;
 *"json .Config.Labels"*) echo '{}';;
 *"len .Config.Labels"*) echo ${lc};;
 *'range $k,$v := .Config.Labels'*) cat ${dir}/labels.txt;;
 *Healthcheck*) ${o.healthcheck ? 'echo y' : 'echo'};;
 *"json .Config.Cmd"*) echo '["node","server.js"]null';;
 *"{{.Image}}"*) echo sha256:abc;;
 *NetworkSettings.Networks*) echo 'shop_default ';;
 *"{{.Name}}"*) echo /demo;;
 *HostConfig.PidsLimit*) echo '<nil>';;
 *HostConfig.ReadonlyRootfs*) echo false;;
esac
exit 0
`)
	writeFileSync(join(dir, 'curl'), '#!/bin/bash\necho 200\n', { mode: 0o755 })
	writeFileSync(join(dir, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
	const body = `cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')} bridge_start; echo rc=$?; ${handoff ? 'bridge_handoff; echo hrc=$?;' : ''}`
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
	return { out, create: read('create'), labelFile: read('lf'), calls: read('calls.log') }
}

describe('bridge host-port mode', () => {
	it('publishes 127.0.0.1:N:<binding container port>, no healthcheck needed', () => {
		const r = run({ hostPort: '13001' })
		expect(r.out).not.toMatch(/skipped/)
		expect(r.out).toContain('answering on 127.0.0.1:13001')
		expect(r.create).toContain('-p 127.0.0.1:13001:3001 ')
		expect(r.create).toContain('--cap-drop NET_RAW')
		expect(r.out).toContain('rc=0')
	})
	it('uses the binding container port, not EXPOSE or the host port', () => {
		const r = run({ hostPort: '14555', bindings: '3001/tcp|127.0.0.1|4555\n' })
		expect(r.out).not.toMatch(/skipped/)
		expect(r.create).toContain('-p 127.0.0.1:14555:3001 ')
	})
	it('copies extra_hosts as --add-host', () => {
		const r = run({
			hostPort: '13001',
			extraHosts: ['host.docker.internal:host-gateway', 'db=10.0.0.5', 'v6:::1'],
		})
		expect(r.out).not.toMatch(/skipped/)
		expect(r.create).toContain('--add-host host.docker.internal:host-gateway')
		expect(r.create).toContain('--add-host db:10.0.0.5')
		expect(r.create).toContain('--add-host v6:::1')
	})
	it.each([
		['bad;name:1.2.3.4'],
		['x:$(id)'],
		['x:1.2.3.4 --privileged'],
		['-x:1.2.3.4'],
		['x:example.com'],
	])('skips on an invalid extra_hosts entry %s', (e) => {
		const r = run({ hostPort: '13001', extraHosts: [e] })
		expect(r.out).toContain('[bridge] skipped: unexpected extra_hosts entry')
		expect(r.create).toBe('')
	})
	it.each([
		[
			'0.0.0.0 binding',
			{ bindings: '3001/tcp|0.0.0.0|3001\n' },
			'a tcp port bound to 127.0.0.1 only',
		],
		['empty HostIp', { bindings: '3001/tcp||3001\n' }, 'a tcp port bound to 127.0.0.1 only'],
		['::1 binding', { bindings: '3001/tcp|::1|3001\n' }, 'a tcp port bound to 127.0.0.1 only'],
		[
			'udp binding',
			{ bindings: '3001/udp|127.0.0.1|3001\n' },
			'a tcp port bound to 127.0.0.1 only',
		],
		[
			'two keys',
			{ pbLen: '2', bindings: '3001/tcp|127.0.0.1|3001\n9229/tcp|127.0.0.1|9229\n' },
			'exactly one published port',
		],
		[
			'two hosts on one key',
			{ bindings: '3001/tcp|127.0.0.1|3001\n3001/tcp|127.0.0.1|3002\n' },
			'exactly one published port',
		],
		['no binding', { pbLen: '0', bindings: '' }, 'exactly one published port'],
	])('skips on %s', (_n, o, why) => {
		const r = run({ hostPort: '13001', ...o })
		expect(r.out).toContain(`[bridge] skipped: host-port mode needs ${why}`)
		expect(r.create).toBe('')
	})
	it.each([['abc'], ['80'], ['1023'], ['65536'], ['013001'], ['999999'], ['13001 ']])(
		'skips on invalid label value %j',
		(hp) => {
			const r = run({ hostPort: hp })
			expect(r.out).toContain('[bridge] skipped: invalid powder.bridge.host-port label')
			expect(r.create).toBe('')
		},
	)
	// N must be the app host port + 10000: a label cannot grab another app's port
	// (e.g. 3002) while that app is being recreated.
	it.each([['3001'], ['3002'], ['13002'], ['23001'], ['13000']])(
		'skips when N %s is not the app host port + 10000',
		(hp) => {
			const r = run({ hostPort: hp })
			expect(r.out).toContain(
				'[bridge] skipped: powder.bridge.host-port must be the app host port + 10000',
			)
			expect(r.create).toBe('')
		},
	)
	it('without the label a host-port app is skipped as before', () => {
		const r = run({ labels: 'powder.bridge.enabled=true\n' })
		expect(r.out).toContain('[bridge] skipped: app publishes host ports')
		expect(r.create).toBe('')
	})
	it('keeps the bridge out of traefik and skips the traefik label compare at handoff', () => {
		const r = run({ hostPort: '13001' }, true)
		expect(r.out).not.toMatch(/skipped|traefik labels differ/)
		expect(r.out).toContain('new container ready; draining bridge')
		expect(r.out).toContain('[bridge] removed demo-powder-bridge')
		expect(r.out).toContain('hrc=0')
		expect(r.labelFile).not.toMatch(/^traefik\.http\./m)
		expect(r.labelFile).toMatch(/^traefik\.enable=false$/m)
		expect(r.labelFile).toMatch(/^powder\.bridge\.host-port=13001$/m)
		expect(r.calls).toMatch(/rm -f demo-powder-bridge/)
	})
	it('a failed docker start (port taken) skips and removes the bridge', () => {
		const r = run({ hostPort: '13001', startFail: true })
		expect(r.out).toContain('[bridge] skipped: docker start failed')
		expect(r.out).toContain('[bridge] removed demo-powder-bridge')
		expect(r.out).toContain('rc=0')
	})
	it('bash -n accepts the generated functions', () => {
		const f = bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')
		execFileSync('bash', ['-n'], { input: `cap() { :; }; ${f}` })
	})
})

describe('bridge traefik mode unchanged', () => {
	it('still requires a healthcheck and does not publish ports', () => {
		const r = run({
			labels:
				'powder.bridge.enabled=true\ntraefik.http.routers.x.rule=Host(`x`)\ntraefik.http.services.x.loadbalancer.server.port=3000\n',
			pbLen: '0',
			healthcheck: false,
		})
		expect(r.out).toContain('[bridge] skipped: current container has no healthcheck')
	})
	it('publishes nothing and keeps traefik labels', () => {
		const r = run({
			labels:
				'powder.bridge.enabled=true\ntraefik.http.routers.x.rule=Host(`x`)\ntraefik.http.services.x.loadbalancer.server.port=3000\n',
			pbLen: '0',
			healthcheck: true,
		})
		expect(r.out).not.toMatch(/skipped/)
		expect(r.create).not.toContain(' -p ')
		expect(r.out).toContain('answering on :3000')
		expect(r.labelFile).toMatch(/^traefik\.http\.routers\.x\.rule=/m)
		expect(r.labelFile).not.toContain('traefik.enable=false')
	})
	it('still skips on extra_hosts in traefik mode', () => {
		const r = run({
			labels:
				'powder.bridge.enabled=true\ntraefik.http.routers.x.rule=Host(`x`)\ntraefik.http.services.x.loadbalancer.server.port=3000\n',
			pbLen: '0',
			healthcheck: true,
			extraHosts: ['host.docker.internal:host-gateway'],
		})
		expect(r.out).toContain('[bridge] skipped: extra_hosts/tmpfs/cap_add/sysctls/init/shm_size set')
		expect(r.create).toBe('')
		expect(r.calls).not.toContain('range .HostConfig.ExtraHosts')
	})
})
