import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

// A traefik-routed app powder cannot bridge 502s for the whole recreate on every
// deploy. bridge_start logs a WARNING and prints a nonce-tagged
// verdict; the runner reads only that marker into one deduped HQ card per app.
// Runs the generated shell against a fake `docker` on PATH.

const NONCE = 'abc123'
const MARK = bridgeVerdictMarkerFor(NONCE)
const TRAEFIK =
	'traefik.enable=true\ntraefik.http.routers.x.rule=Host(`x`)\ntraefik.http.services.x.loadbalancer.server.port=3000\n'

type Opts = {
	labels: string
	enabled?: boolean
	healthcheck?: boolean
	running?: boolean
	imageCmd?: string
}

function run(o: Opts) {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-warn-'))
	writeFileSync(join(dir, 'labels.txt'), o.labels)
	const lc = o.labels.split('\n').filter(Boolean).length
	writeFakeDocker(dir, `#!/bin/bash
case "$*" in
 *"ps -q"*) ${o.running === false ? ':' : 'echo oldid'};;
 *State.Running*) echo true;;
 *State.Health*) echo healthy;;
 *'index .Config.Labels "powder.bridge.enabled"'*) ${o.enabled === false ? 'echo' : 'echo true'};;
 *'index .Config.Labels "powder.bridge.host-port"'*) echo;;
 *'index .Config.Labels "powder.bridge"}}'*) echo '/opt/apps/demo|app';;
 *boot-push-ok*) echo false;;
 *"len .HostConfig.PortBindings"*) echo 0;;
 *NetworkMode*) echo web;;
 *"len .Mounts"*|*"len .HostConfig.Binds"*) echo 0;;
 *"len .HostConfig.ExtraHosts"*) echo '0|0|0|0|<nil>|67108864';;
 *"json .Config.Env"*) echo '[]';;
 *"json .Config.Labels"*) echo '{}';;
 *"len .Config.Labels"*) echo ${lc};;
 *'range $k,$v := .Config.Labels'*) cat ${dir}/labels.txt;;
 *"{{.Image}}"*) echo sha256:abc;;
 *Healthcheck*) ${o.healthcheck === false ? 'echo' : 'echo y'};;
 *"--type image"*) echo '${o.imageCmd ?? '["node","server.js"]null'}';;
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
	return execFileSync('bash', ['-c', body], {
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
	}).toString()
}

afterEach(() => {
	vi.unstubAllGlobals()
	delete process.env.POWDER_HQ_INGEST_TOKEN
	delete process.env.POWDER_HQ_GENERIC_URL
})

describe('bridge verdict for traefik apps', () => {
	it('no bridge label on a traefik app: WARNING + no-label, still rc=0', () => {
		const out = run({ labels: TRAEFIK, enabled: false })
		expect(out).toContain('[bridge] WARNING: traefik app not bridged: not enabled')
		expect(out).toContain('rc=0')
		expect(parseBridgeVerdict(out, NONCE)).toBe('no-label')
	})
	it('no healthcheck: no-healthcheck', () => {
		const out = run({ labels: `powder.bridge.enabled=true\n${TRAEFIK}`, healthcheck: false })
		expect(out).toContain('not bridged: current container has no healthcheck')
		expect(parseBridgeVerdict(out, NONCE)).toBe('no-healthcheck')
	})
	it('any other skip reason warns too, as unsupported (command overridden)', () => {
		const out = run({ labels: `powder.bridge.enabled=true\n${TRAEFIK}`, imageCmd: '["other"]null' })
		expect(out).toContain('not bridged: command/entrypoint overridden or image unreadable')
		expect(parseBridgeVerdict(out, NONCE)).toBe('unsupported')
	})
	it('a router label without traefik.enable true is not routed (exposedbydefault=false)', () => {
		const noEnable = 'traefik.http.routers.x.rule=Host(`x`)\n'
		for (const labels of [noEnable, `traefik.enable=false\n${noEnable}`, 'foo=bar\n']) {
			const out = run({ labels, enabled: false })
			expect(out).not.toContain('WARNING')
			expect(out).toContain('[bridge] not traefik-routed')
			expect(parseBridgeVerdict(out, NONCE)).toBe('not-routed')
		}
		for (const v of ['TRUE', '1', 'True']) {
			expect(
				parseBridgeVerdict(
					run({ labels: `traefik.enable=${v}\n${noEnable}`, enabled: false }),
					NONCE,
				),
			).toBe('no-label')
		}
	})
	it('a working bridge prints bridged', () => {
		const out = run({ labels: `powder.bridge.enabled=true\n${TRAEFIK}` })
		expect(out).toContain('overlapping old and new during the swap')
		expect(parseBridgeVerdict(out, NONCE)).toBe('bridged')
	})
	it('early returns (no running container) give no verdict: unknown', () => {
		const out = run({ labels: TRAEFIK, running: false })
		expect(out).toContain('no running container to overlap')
		expect(parseBridgeVerdict(out, NONCE)).toBeNull()
	})
	it('skip reasons map to a fixed class', () => {
		expect(bridgeSkipClass('docker create failed')).toBe('failed')
		expect(
			bridgeSkipClass(
				'bridge not answering HTTP / not healthy within budget (needs sh+test in image)',
			),
		).toBe('failed')
		expect(bridgeSkipClass('could not read cap_drop of the current container')).toBe('failed')
		expect(
			bridgeSkipClass(
				'no explicit traefik router+service labels (worker / non-http / default-named)',
			),
		).toBe('unsupported')
		expect(bridgeSkipClass('traefik router without an explicit rule label')).toBe('unsupported')
		expect(
			bridgeSkipClass('label file line count differs from the label count (powder self-check)'),
		).toBe('internal')
	})
	it('a tripped powder self-check raises a powder-bug card, not an app-config one', async () => {
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
		await reportDeployWarningsToHq({ app: 'shop', server: 'web1', envRefusedKeys: null, builderFallback: null, bridge: 'internal' })
		const card = bodies.find((b) => b.source_ref === 'no-bridge:web1/shop')
		expect(String(card?.title)).toContain('powder bug')
		expect(String(card?.body)).toContain('nothing in the app needs to change')
		expect(String(card?.body)).not.toContain('LABEL powder.bridge.enabled=true')
	})
	it('only the nonce-tagged marker counts; build output cannot fake it', () => {
		expect(parseBridgeVerdict(`${MARK} no-label\nbuild: ${MARK} bridged`, NONCE)).toBe('no-label')
		expect(parseBridgeVerdict('__POWDER_BRIDGE_other__ no-label', NONCE)).toBeNull()
		expect(parseBridgeVerdict(`${MARK} nonsense`, NONCE)).toBeNull()
		expect(parseBridgeVerdict(`${MARK} no-label\n${MARK} bridged`, NONCE)).toBe('bridged')
		expect(parseBridgeVerdict(`${MARK} no-label`, '')).toBeNull()
		expect(bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')).not.toContain(
			'__POWDER_BRIDGE_',
		)
	})
	it('raises one deduped card, resolves only on a positive verdict, posts nothing when unknown', async () => {
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
		const base = { app: 'shop', server: 'web1', envRefusedKeys: null, builderFallback: null }
		const cards = () => bodies.filter((b) => b.source_ref === 'no-bridge:web1/shop')
		await reportDeployWarningsToHq({ ...base, bridge: 'no-label' })
		expect(cards()).toHaveLength(1)
		expect(cards()[0]).toMatchObject({
			severity: 'warn',
			source: 'powder-deploy-warn',
			project: 'shop',
		})
		expect(String(cards()[0]?.body)).toContain('has no powder.bridge.enabled=true label')
		await reportDeployWarningsToHq({ ...base, bridge: null })
		await reportDeployWarningsToHq({ ...base })
		expect(cards()).toHaveLength(1)
		await reportDeployWarningsToHq({ ...base, bridge: 'not-routed' })
		await reportDeployWarningsToHq({ ...base, bridge: 'bridged' })
		expect(
			cards()
				.slice(1)
				.every((c) => c.resolve === true),
		).toBe(true)
		expect(cards()).toHaveLength(3)
	})
})
