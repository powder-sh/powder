import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bridgeShellFunctions } from '../deploy/fragments'
import { writeFakeDocker } from './fixtures/fake-docker'

// Regression guard for the bridge modes that existed before DNS-alias: the traefik mode
// and the host-port mode (and the not-enabled verdicts) must issue the same
// state-changing docker commands (create / network connect / start / exec / stop /
// rm, with every argument) and print the same log as before the DNS-alias mode
// existed. The snapshot file was recorded against the pre-DNS-alias code; a diff
// here is a behaviour change for every bridged app. Read-only `docker inspect`
// calls are left out on purpose (a new mode may read one more label).

const NONCE = 'reg1'

type Opts = {
	labels: string
	bindings?: string
	extraHosts?: string[]
	healthcheck?: boolean
	netMode?: string
	nets?: string
	nginx?: string
	cmd?: string
}

function run(o: Opts) {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-reg-'))
	writeFileSync(join(dir, 'labels.txt'), o.labels)
	const lc = o.labels.split('\n').filter(Boolean).length
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
	const hp = /^powder\.bridge\.host-port=(.*)$/m.exec(o.labels)?.[1] ?? ''
	const log = join(dir, 'calls.log')
	writeFakeDocker(
		dir,
		`#!/bin/bash
echo "$*" >> ${log}
case "$*" in
 create*) :;;
 start*|stop*|exec*|"network connect"*|"rm "*) :;;
 *"ps -q"*|*"ps -aq"*) case "$*" in *"compose"*) echo oldid;; esac;;
 *'index .Config.Labels "powder.bridge.enabled"'*) grep -q '^powder.bridge.enabled=true$' ${dir}/labels.txt && echo true || echo;;
 *'index .Config.Labels "powder.bridge.host-port"'*) echo '${hp}';;
 *'index .Config.Labels "powder.bridge"}}'*) echo '/opt/apps/demo|app';;
 *boot-push-ok*) echo false;;
 *State.Running*) echo true;;
 *State.Health*) echo healthy;;
 *"len .HostConfig.PortBindings"*) echo ${pbLen};;
 *"range \\$p,\\$v := .HostConfig.PortBindings"*) cat ${dir}/pb.txt;;
 *NetworkMode*) echo ${o.netMode ?? 'shop_default'};;
 *"len .Mounts"*|*"len .HostConfig.Binds"*) echo 1;;
 *"range .HostConfig.Binds"*) echo /opt/apps/demo/data:/data;;
 *"len .HostConfig.ExtraHosts"*) echo '${eh.length}|0|0|0|<nil>|67108864';;
 *"range .HostConfig.ExtraHosts"*) cat ${dir}/eh.txt;;
 *"json .Config.Env"*) echo '["A=1"]';;
 *"range .Config.Env"*) echo A=1;;
 *"json .Config.Labels"*) echo '{}';;
 *"len .Config.Labels"*) echo ${lc};;
 *'range $k,$v := .Config.Labels'*) cat ${dir}/labels.txt;;
 *Healthcheck*) ${o.healthcheck === false ? 'echo' : 'echo y'};;
 *"json .Config.Cmd"*) echo '${o.cmd ?? '["node","server.js"]null'}';;
 *"{{.Image}}"*) echo sha256:abc;;
 *"range .HostConfig.CapDrop"*) echo 'ALL ';;
 *"range .HostConfig.SecurityOpt"*) echo no-new-privileges:true;;
 *"range .Config.ExposedPorts"*|*'range $p,$v := .Config.ExposedPorts'*) echo '3000/tcp ';;
 *'range $k,$v := .NetworkSettings.Networks'*) echo '${o.nets ?? 'shop_default '}';;
 *"range .NetworkSettings.Networks"*) echo '172.20.0.9 ';;
 *"{{.Name}}"*) echo /demo;;
 *"{{.Config.User}}"*) echo node;;
 *"{{.Config.WorkingDir}}"*) echo /app;;
 *HostConfig.PidsLimit*) echo 512;;
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
	const body = `cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE)} bridge_start; echo rc=$?; bridge_handoff; echo hrc=$?`
	const out = execFileSync('bash', ['-c', body], {
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
	}).toString()
	let calls = ''
	try {
		calls = readFileSync(log, 'utf8')
	} catch {}
	const norm = (s: string) =>
		s
			.split(dir)
			.join('<dir>')
			.replace(/(--(?:label|env)-file) \S+/g, '$1 <tmp>')
	const changes = calls
		.split('\n')
		.filter((l) => /^(create|start|stop|exec|network connect|rm) /.test(l))
		.map(norm)
	return { out: norm(out), changes }
}

const TRAEFIK =
	'com.docker.compose.project=demo\ncom.docker.compose.service=app\npowder.bridge.enabled=true\ntraefik.enable=true\ntraefik.http.routers.x.rule=Host(`x`)\ntraefik.http.services.x.loadbalancer.server.port=3000\n'
const HOST_PORT = 'com.docker.compose.service=app\npowder.bridge.enabled=true\npowder.bridge.host-port=13001\n'

describe('bridge modes without the dns-alias label (regression guard)', () => {
	it('traefik mode, two networks', () => {
		expect(run({ labels: TRAEFIK, nets: 'shop_default proxy ' })).toMatchSnapshot()
	})
	it('traefik mode with a loopback port', () => {
		expect(run({ labels: TRAEFIK, bindings: '3000/tcp|127.0.0.1|3040\n' })).toMatchSnapshot()
	})
	it('traefik mode skips (no healthcheck)', () => {
		expect(run({ labels: TRAEFIK, healthcheck: false })).toMatchSnapshot()
	})
	it('host-port mode with extra_hosts', () => {
		expect(
			run({
				labels: HOST_PORT,
				bindings: '3001/tcp|127.0.0.1|3001\n',
				extraHosts: ['host.docker.internal:host-gateway'],
				nginx: 'upstream u { server 127.0.0.1:3001 max_fails=0; server 127.0.0.1:13001 backup; }\n',
			}),
		).toMatchSnapshot()
	})
	it('host-port mode skips on a boot push', () => {
		expect(
			run({ labels: HOST_PORT, bindings: '3001/tcp|127.0.0.1|3001\n', cmd: '["sh","-c","drizzle-kit push --force"]null' }),
		).toMatchSnapshot()
	})
	it('not enabled: traefik-routed, nginx-fronted, plain', () => {
		expect(run({ labels: 'traefik.enable=true\ntraefik.http.routers.x.rule=Host(`x`)\n' })).toMatchSnapshot()
		expect(
			run({ labels: 'a=b\n', bindings: '3000/tcp|127.0.0.1|3004\n', nginx: 'location / { proxy_pass http://127.0.0.1:3004; }\n' }),
		).toMatchSnapshot()
		expect(run({ labels: 'a=b\n' })).toMatchSnapshot()
	})
	it('enabled but not routed and no host-port label: not-routed skip', () => {
		expect(run({ labels: 'powder.bridge.enabled=true\n' })).toMatchSnapshot()
	})
})
