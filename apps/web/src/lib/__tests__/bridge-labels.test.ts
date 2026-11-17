import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({}))
import { parseBridgeVerdict } from '../deploy/fragments'
import { bridgeShellFunctions, imageLabelGuardShell } from '../ssh'
import { writeFakeDocker } from './fixtures/fake-docker'

// a label value with a raw newline followed by traefik.* must not
// become a real Traefik label on the bridge container, and the image guard
// must refuse it.

const NONCE = 'lbl7'

const EVIL_VALUE = 'a\ntraefik.http.routers.evil.rule=Host(`x`)'
const GOOD = {
	'powder.bridge.enabled': 'true',
	'traefik.http.routers.app.rule': 'Host(`app.example.com`)',
	'traefik.http.services.app.loadbalancer.server.port': '3000',
}

/** Stub docker for bridge_start. `json` is what {{json .Config.Labels}} prints,
 *  `lines` what the {{range}} template prints, `len` the {{len}} answer. */
function runBridge(labels: Record<string, string>, opts: { json?: string; len?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-lbl-'))
	const lines = Object.entries(labels)
		.map(([k, v]) => `${k}=${v}\n`)
		.join('')
	writeFileSync(join(dir, 'labels.json'), opts.json ?? JSON.stringify(labels))
	writeFileSync(join(dir, 'labels.txt'), lines)
	writeFileSync(join(dir, 'labels.len'), opts.len ?? String(Object.keys(labels).length))
	const log = join(dir, 'calls.log')
	writeFakeDocker(dir, `#!/bin/bash
echo "$*" >> ${log}
case "$*" in
 create*) while [ $# -gt 0 ]; do if [ "$1" = --label-file ]; then cp "$2" ${dir}/created-labels; fi; shift; done;;
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
 *"json .Config.Labels"*) cat ${dir}/labels.json; echo;;
 *"len .Config.Labels"*) cat ${dir}/labels.len;;
 *'range $k,$v := .Config.Labels'*) cat ${dir}/labels.txt;;
 *Healthcheck*) echo y;;
 *"json .Config.Cmd"*) echo '["node","server.js"]null';;
 *"{{.Image}}"*) echo sha256:abc;;
 *NetworkSettings.Networks*) echo 'web ';;
 *"{{.Name}}"*) echo /demo;;
esac
exit 0
`)
	writeFileSync(join(dir, 'curl'), '#!/bin/bash\necho 200\n', { mode: 0o755 })
	writeFileSync(join(dir, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
	const body = `cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE)} bridge_start; echo rc=$?`
	const out = execFileSync('bash', ['-c', body], {
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
	}).toString()
	const created = existsSync(join(dir, 'created-labels'))
		? readFileSync(join(dir, 'created-labels'), 'utf8')
		: null
	return { out, created, calls: readFileSync(log, 'utf8') }
}

describe('bridge label injection', () => {
	it('skips the bridge (no docker create) when a label value contains a newline', () => {
		const r = runBridge({ ...GOOD, 'org.example.note': EVIL_VALUE })
		expect(r.out).toMatch(/\[bridge\] skipped: label key or value with a line break/)
		expect(r.out).toMatch(/rc=0/)
		expect(r.created).toBeNull()
		expect(r.calls).not.toMatch(/^create /m)
	})
	it('skips when the label file has more lines than labels even if the JSON check is bypassed', () => {
		const labels = { ...GOOD, 'org.example.note': EVIL_VALUE }
		const r = runBridge(labels, { json: JSON.stringify(GOOD) })
		expect(r.out).toMatch(/\[bridge\] skipped: label file line count differs/)
		expect(r.created).toBeNull()
	})
	it('still starts the bridge for ordinary labels, without compose labels in the label file', () => {
		const r = runBridge({ ...GOOD, 'com.docker.compose.project': 'demo' })
		expect(r.out).not.toMatch(/skipped/)
		expect(r.created).toBe(
			'powder.bridge.enabled=true\ntraefik.http.routers.app.rule=Host(`app.example.com`)\ntraefik.http.services.app.loadbalancer.server.port=3000\n',
		)
	})
	// docker inspect -f appends one "\n" after the template, so the label dump has
	// an empty last line; counting it would refuse every bridge as "line count
	// differs". The shared fake docker appends it too.
	it('bridges a normal labelled container (verdict bridged, not unsupported)', () => {
		const labels: Record<string, string> = { ...GOOD, 'com.docker.compose.project': 'demo' }
		for (let i = 0; i < 22; i++) labels[`org.example.l${i}`] = `v${i}`
		const r = runBridge(labels)
		expect(r.out).not.toMatch(/skipped/)
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('bridged')
		expect(r.created).toContain('traefik.http.routers.app.rule=Host(`app.example.com`)\n')
		expect(r.created).not.toContain('\n\n')
	})
	it.each([
		['an LF mid-value', 'a\ntraefik.x=y'],
		['an LF at the end of the last value', 'a\n'],
		['a CR', 'a\rb'],
	])('the line-count guard alone still refuses %s (JSON check bypassed)', (_n, v) => {
		const ok = { ...GOOD, 'traefik.enable': 'true' }
		const r = runBridge({ ...ok, 'zz.note': v }, { json: JSON.stringify(ok) })
		expect(r.out).toMatch(/\[bridge\] skipped: label file line count differs/)
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('internal')
		expect(r.created).toBeNull()
	})
	it.each([
		['empty', ''],
		['non-numeric', '<no value>'],
	])('an unreadable label count (%s, container gone) is failed, not a powder bug', (_n, len) => {
		const ok = { ...GOOD, 'traefik.enable': 'true' }
		const r = runBridge(ok, { len })
		expect(r.out).toMatch(/\[bridge\] skipped: could not read labels of the current container/)
		expect(parseBridgeVerdict(r.out, NONCE)).toBe('failed')
		expect(r.out).not.toMatch(/powder self-check tripped/)
		expect(r.created).toBeNull()
	})
	it('the internal verdict warning says powder bug, not add HEALTHCHECK/LABEL', () => {
		const ok = { ...GOOD, 'traefik.enable': 'true' }
		const r = runBridge({ ...ok, 'zz.note': 'a\nb' }, { json: JSON.stringify(ok) })
		expect(r.out).toMatch(/WARNING: traefik app not bridged: .*powder self-check tripped: this is a powder bug, nothing in the app needs to change/)
		expect(r.out).not.toMatch(/add HEALTHCHECK/)
	})
	it('does not skip a literal backslash-n (escaped backslash) in a label value', () => {
		const r = runBridge({ ...GOOD, 'org.example.note': 'C:\\new' })
		expect(r.out).not.toMatch(/skipped/)
		expect(r.created).toContain('org.example.note=C:\\new\n')
	})
})

const guard = (labelsJson: string) => {
	const dir = mkdtempSync(join(tmpdir(), 'guard-lbl-'))
	writeFileSync(join(dir, 'labels.json'), labelsJson)
	const script = `docker() { if [ "$1" = compose ]; then return 0; fi; cat ${dir}/labels.json; }; STAGE_IMG=img:build-1; ${imageLabelGuardShell()} && echo PASSED`
	try {
		return { rc: 0, out: execFileSync('bash', ['-c', script], { encoding: 'utf8' }) }
	} catch (e) {
		const x = e as { status: number; stdout: string }
		return { rc: x.status, out: x.stdout }
	}
}

describe('image label guard', () => {
	it('refuses a label value with a newline that smuggles a traefik label', () => {
		const r = guard(JSON.stringify({ x: EVIL_VALUE }))
		expect(r.rc).toBe(1)
		expect(r.out).toContain('line break')
	})
	it('refuses CR and newlines in label keys', () => {
		expect(guard(JSON.stringify({ x: 'a\rb' })).rc).toBe(1)
		expect(guard(JSON.stringify({ 'a\nb': 'c' })).rc).toBe(1)
	})
	it('matches traefik. case-insensitively anywhere in a key', () => {
		expect(guard(JSON.stringify({ 'Traefik.http.routers.x.rule': 'Host(`v`)' })).out).toContain(
			'carries a traefik.* image label',
		)
		expect(guard(JSON.stringify({ 'x.traefik.http.routers.y.rule': 'z' })).rc).toBe(1)
	})
	it('passes ordinary labels, a value mentioning traefik, and an escaped backslash-n', () => {
		expect(
			guard(
				JSON.stringify({
					'org.opencontainers.image.description': 'runs behind traefik.io, see "a,traefik.b"',
				}),
			).out,
		).toContain('PASSED')
		expect(guard(JSON.stringify({ note: 'C:\\new' })).out).toContain('PASSED')
		expect(guard('null').out).toContain('PASSED')
	})
})
