import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bridgeShellFunctions } from '../deploy/fragments'
import { writeFakeDocker } from './fixtures/fake-docker'

// the zero-downtime bridge keeps the running container's hardening.
const LABELS =
	'powder.bridge.enabled=true\ntraefik.http.routers.app.rule=Host(`app.example.com`)\ntraefik.http.services.app.loadbalancer.server.port=3000\n'

function runBridge(h: {
	capDrop?: string
	secOpt?: string
	ro?: string
	pids?: string
	failCapDrop?: boolean
}) {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-hard-'))
	writeFileSync(join(dir, 'labels.txt'), LABELS)
	const log = join(dir, 'calls.log')
	writeFakeDocker(dir, `#!/bin/bash
echo "$*" >> ${log}
case "$*" in
 create*) echo "$*" > ${dir}/create;;
 *"ps -q"*) echo oldid;;
 *'index .Config.Labels "powder.bridge.enabled"'*) echo true;;
 *boot-push-ok*) echo false;;
 *State.Running*) echo true;;
 *State.Health*) echo healthy;;
 *PortBindings*) echo 0;;
 *NetworkMode*) echo web;;
 *"len .Mounts"*|*"len .HostConfig.Binds"*) echo 0;;
 *ExtraHosts*) echo '0|0|0|0|<nil>|67108864';;
 *"json .Config.Env"*) echo '[]';;
 *"json .Config.Labels"*) echo '{}';;
 *"len .Config.Labels"*) echo 3;;
 *'range $k,$v := .Config.Labels'*) cat ${dir}/labels.txt;;
 *Healthcheck*) echo y;;
 *"json .Config.Cmd"*) echo '["node","server.js"]null';;
 *"{{.Image}}"*) echo sha256:abc;;
 *NetworkSettings.Networks*) echo 'web ';;
 *"{{.Name}}"*) echo /demo;;
 *HostConfig.CapDrop*) ${h.failCapDrop ? 'exit 1' : `printf '%s' ${JSON.stringify(h.capDrop ?? '')}`};;
 *HostConfig.SecurityOpt*) printf '%b' ${JSON.stringify(h.secOpt ?? '')};;
 *HostConfig.ReadonlyRootfs*) echo ${h.ro ?? 'false'};;
 *HostConfig.PidsLimit*) echo '${h.pids ?? '<nil>'}';;
esac
exit 0
`)
	writeFileSync(join(dir, 'curl'), '#!/bin/bash\necho 200\n', { mode: 0o755 })
	writeFileSync(join(dir, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
	const body = `cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')} bridge_start; echo rc=$?`
	const out = execFileSync('bash', ['-c', body], {
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
	}).toString()
	let create = ''
	try {
		create = readFileSync(join(dir, 'create'), 'utf8')
	} catch {}
	return { out, create }
}

describe('bridge hardening', () => {
	it('always drops NET_RAW, even when the app sets nothing', () => {
		const r = runBridge({})
		expect(r.out).not.toMatch(/skipped/)
		expect(r.create).toContain('--cap-drop NET_RAW')
		expect(r.create).not.toContain('--read-only')
		expect(r.create).not.toContain('--pids-limit')
	})
	it('copies cap_drop, security_opt, read_only and pids_limit', () => {
		const r = runBridge({
			capDrop: 'ALL ',
			secOpt: 'no-new-privileges\\nlabel=disable\\n',
			ro: 'true',
			pids: '200',
		})
		expect(r.create).toContain('--cap-drop ALL')
		expect(r.create).toContain('--security-opt no-new-privileges')
		expect(r.create).toContain('--security-opt label=disable')
		expect(r.create).toContain('--read-only')
		expect(r.create).toContain('--pids-limit 200')
	})
	it('skips the bridge (no create) when a setting cannot be read or copied', () => {
		const a = runBridge({ failCapDrop: true })
		expect(a.out).toContain('[bridge] skipped: could not read cap_drop')
		expect(a.out).toContain('rc=0')
		expect(a.create).toBe('')
		const b = runBridge({ secOpt: 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}\\n' })
		expect(b.out).toContain('[bridge] skipped: custom inline seccomp profile')
		expect(b.create).toBe('')
		const c = runBridge({ pids: '12x' })
		expect(c.out).toContain('[bridge] skipped: unexpected pids_limit value')
	})
})
