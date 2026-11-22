import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { renderLabelsBlock } from '../app-domains'
import { bridgeShellFunctions, drainAbortClearShell, drainRuleId, drainShellFunctions } from '../deploy/fragments'
import { drainActiveFor, drainModeFrom } from '../drain-mode'
import { buildDeployScript } from '../deploy/script'
import { parseStabilityMarkers } from '../deploy/stability'
import { writeFakeDocker } from './fixtures/fake-docker'
import { pathWithout } from './hermetic'

// Lossless stop of the old container in a bridged swap (fragments.ts
// drainShellFunctions). The gap it closes: compose stopped the old container
// while the proxy still sent it new requests.
// Runs the generated shell against stubs on PATH: docker, curl, and
// a STATEFUL iptables (rules kept in a file per netfilter namespace, `-S` prints them
// the way iptables does), reached directly for the host and through nsenter for a
// container's netns.

const NONCE = 'drain1'
const SMARK = `__POWDER_STAB_${NONCE}__`
const ID = drainRuleId('/opt/apps/demo', 'app')

/** Stateful stubs in `dir`; returns the path of the call log. */
function stubs(dir: string, o: { probeRc?: number; noIptables?: boolean; noSs?: boolean; realTime?: boolean } = {}) {
	const log = join(dir, 'calls.log')
	writeFileSync(log, '')
	writeFileSync(
		join(dir, 'ipt-impl'),
		`#!/bin/bash
f=\${IPT_RULES:-${dir}/host.rules}; echo "iptables $*" >> ${log}
op=""; c=""; prev=""; for a in "$@"; do [ "$prev" = --comment ] && c="$a"; case "$a" in -I|-D|-S) op="$a";; esac; prev="$a"; done
touch "$f"
case "$op" in
 -S) echo "-P INPUT ACCEPT"; while IFS= read -r l; do echo "-A INPUT -p tcp -m tcp --dport 1 -m comment --comment \\"$l\\" -j REJECT --reject-with tcp-reset"; done < "$f";;
 -I) echo "$c" >> "$f";;
 -D) if grep -qxF "$c" "$f"; then grep -vxF "$c" "$f" > "$f.t"; mv "$f.t" "$f"; else exit 1; fi;;
esac
exit 0
`,
		{ mode: 0o755 },
	)
	if (!o.noIptables) writeFileSync(join(dir, 'iptables'), `#!/bin/bash\nexec ${dir}/ipt-impl "$@"\n`, { mode: 0o755 })
	writeFileSync(
		join(dir, 'nsenter'),
		`#!/bin/bash
echo "nsenter $*" >> ${log}
pid=$2; shift 3
case "$1" in
 iptables) shift; IPT_RULES=${dir}/ns-$pid.rules exec ${dir}/ipt-impl "$@";;
 ss) n=$(cat ${dir}/n 2>/dev/null || echo 0); cat ${dir}/c$n 2>/dev/null; [ -f ${dir}/c$((n+1)) ] && echo $((n+1)) > ${dir}/n; exit 0;;
esac
exit 0
`,
		{ mode: 0o755 },
	)
	if (!o.noSs) writeFileSync(join(dir, 'ss'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
	writeFileSync(
		join(dir, 'curl'),
		`#!/bin/bash
echo "curl $*" >> ${log}
case "$*" in
 *http_code*) [ -f ${dir}/bridge-down ] && { echo 000; exit 7; }; echo 200;;
 *"127.0.0.1:3001/"*|*"10.0.0.5:3000/"*) exit ${o.probeRc ?? 7};;
esac
exit 0
`,
		{ mode: 0o755 },
	)
	if (!o.realTime) {
		writeFileSync(join(dir, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
		// every `date +%s` is one second later, so the wait loops end without real waiting
		writeFileSync(
			join(dir, 'date'),
			`#!/bin/bash\nn=$(cat ${dir}/clock 2>/dev/null || echo 0); echo $((1000000 + n)); echo $((n + 1)) > ${dir}/clock\n`,
			{ mode: 0o755 },
		)
	}
	return log
}

function fakeDocker(dir: string, log: string, o: { stopTimeout?: string; exitCode?: number; stopSleep?: number }) {
	writeFakeDocker(
		dir,
		`#!/bin/bash
echo "docker $*" >> ${log}
case "$*" in
 *"ps -q"*) case "$*" in *compose*) if [ -f ${dir}/recreated ]; then echo newid; else echo oldid; fi;; esac;;
 "inspect demo-powder-bridge"|"inspect oldid"|"inspect newid") :;;
 *State.Running*) if [ -f ${dir}/stopped ]; then echo false; else echo true; fi;;
 *State.Health*) echo healthy;;
 *Config.StopTimeout*) echo '${o.stopTimeout ?? '<nil>'}';;
 *State.Pid*) echo 4242;;
 *State.ExitCode*) echo ${o.exitCode ?? 143};;
 *NetworkSettings.Networks*) case "$*" in *bridge*) echo '10.0.0.9 ';; *) echo '10.0.0.5 ';; esac;;
 stop*) ${o.stopSleep ? `/bin/sleep ${o.stopSleep}; ` : ''}case "$*" in *oldid*) touch ${dir}/stopped;; esac;;
 start*) rm -f ${dir}/stopped;;
esac
exit 0
`,
	)
}

const TRAEFIK_LABELS =
	'traefik.enable=true\ntraefik.http.routers.app.rule=Host(`x`)\ntraefik.http.routers.app.middlewares=app-diag,app-retry\ntraefik.http.middlewares.app-retry.retry.attempts=10\n'

type Opts = {
	mode: 'host-port' | 'traefik' | 'dns-alias'
	probeRc?: number
	/** established connections nsenter ss prints, per call (the last repeats) */
	conns?: string[]
	exitCode?: number
	stopTimeout?: string
	noIptables?: boolean
	noSs?: boolean
	noBridge?: boolean
	bridgeDown?: boolean
	restore?: boolean
	handoff?: boolean
	labels?: string
}

function run(o: Opts) {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-drain-'))
	const log = stubs(dir, { probeRc: o.probeRc, noIptables: o.noIptables, noSs: o.noSs })
	fakeDocker(dir, log, { stopTimeout: o.stopTimeout, exitCode: o.exitCode })
	if (o.bridgeDown) writeFileSync(join(dir, 'bridge-down'), '')
	;(o.conns ?? ['']).forEach((c, i) => writeFileSync(join(dir, `c${i}`), c ? `${c}\n` : ''))
	writeFileSync(join(dir, 'labels'), o.labels ?? TRAEFIK_LABELS)
	const state =
		o.mode === 'host-port'
			? 'B_HP=13001; B_AHP=3001; B_PORT=3001; '
			: o.mode === 'dns-alias'
				? 'B_DNS=1; B_PORT=3000; '
				: 'B_PORT=3000; '
	const body =
		`cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE, SMARK, true)} B_REAPER=off; ` +
		`${o.noBridge ? '' : 'BRIDGE=demo-powder-bridge; '}${state}B_LF=${dir}/labels; ` +
		`bridge_drain_old; echo "drc=$? B_OLD=$B_OLD B_RULE=$B_RULE G=$B_DRAIN_G"; ` +
		(o.restore ? 'SWAPPED=0; bridge_restore_old; echo "rrc=$?"; ' : '') +
		(o.handoff ? `touch ${dir}/recreated; B_LF=; bridge_handoff; echo "hrc=$? B_RULE=$B_RULE"; ` : '')
	const out = execFileSync('bash', ['-c', body], {
		env: { ...process.env, PATH: `${dir}:${pathWithout(['docker', 'iptables', 'nsenter', 'nginx', 'ss'])}` },
	}).toString()
	const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '')
	return { out, calls: read('calls.log'), hostRules: read('host.rules'), nsRules: read('ns-4242.rules') }
}

const lines = (calls: string, re: RegExp) => calls.split('\n').filter((l) => re.test(l))

describe('bridge_drain_old host-port mode', () => {
	it('refuses new connections on the host, waits until idle, then stops; handoff routes back', () => {
		const r = run({ mode: 'host-port', conns: ['a\nb', ''], handoff: true })
		const ins = lines(r.calls, /^iptables -w 5 -I /)
		expect(ins).toHaveLength(1)
		expect(ins[0]).toMatch(
			new RegExp(`^iptables -w 5 -I INPUT -i lo -p tcp -d 127\\.0\\.0\\.1 --dport 3001 --syn -m comment --comment powder-drain 127\\.0\\.0\\.1:3001 d[0-9]+ ${ID} -j REJECT --reject-with tcp-reset$`),
		)
		expect(r.out).toContain('[drain] new connections to 127.0.0.1:3001 refused: nginx sends them to the bridge')
		expect(r.out).toContain('[drain] old container idle')
		expect(r.out).toContain('with no request in flight')
		expect(r.calls).toContain('docker stop -t 10 oldid')
		// the rule outlives the recreate and is removed only once the new container answers
		expect(r.out).toContain('B_RULE=3001')
		const all = r.calls.split('\n')
		const del = all.findIndex((l) => l.startsWith('iptables -w 5 -D INPUT') && l.includes('--dport 3001'))
		const bstop = all.findIndex((l) => l.startsWith('docker stop -t 30 demo-powder-bridge'))
		expect(del).toBeGreaterThan(-1)
		expect(bstop).toBeGreaterThan(del)
		expect(r.hostRules.trim()).toBe('')
		expect(r.out).toMatch(/hrc=0 B_RULE=$/m)
		expect(parseStabilityMarkers(r.out, NONCE).stopDrain).toBe('ok')
	})
	it('the bridge must answer first: no rule, no stop, no-route-away', () => {
		const r = run({ mode: 'host-port', bridgeDown: true })
		expect(r.calls).not.toMatch(/^iptables -w 5 -I/m)
		expect(r.calls).not.toMatch(/^docker stop/m)
		expect(r.out).toContain('the bridge is not answering')
		expect(parseStabilityMarkers(r.out, NONCE).stopDrain).toBe('no-route-away')
	})
	it('a rule that does not take effect is removed again and reported, with a true reason', () => {
		const r = run({ mode: 'host-port', probeRc: 0 })
		expect(r.hostRules.trim()).toBe('')
		expect(r.out).toContain('B_RULE= ')
		expect(r.out).toContain('not refusing new connections to the old container: the reject rule did not take effect')
		expect(r.calls).toContain('docker stop -t 30 oldid')
		// nothing known about requests in flight: no claim that they finished
		expect(r.out).not.toContain('no request in flight')
		expect(parseStabilityMarkers(r.out, NONCE).stopDrain).toBe('no-route-away')
	})
	it('no iptables on the host: reported, the old container still gets its grace', () => {
		const r = run({ mode: 'host-port', noIptables: true })
		expect(r.out).toContain('iptables is not installed')
		expect(r.calls).toContain('docker stop -t 30 oldid')
		expect(parseStabilityMarkers(r.out, NONCE).stopDrain).toBe('no-route-away')
	})
	it('no ss: says the connections were not counted (not "still open") and uses the full grace', () => {
		const r = run({ mode: 'host-port', noSs: true })
		expect(r.out).toContain('could not count the old container')
		expect(r.out).not.toContain('still has open connections')
		expect(r.calls).toContain('docker stop -t 30 oldid')
	})
	it('uses stop_grace_period (StopTimeout) as the grace', () => {
		const r = run({ mode: 'host-port', stopTimeout: '120', conns: ['a'] })
		expect(r.out).toContain('G=120')
		expect(r.out).toContain('still has open connections after 120s')
	})
	it('caps an absurd grace at 600 s', () => {
		const r = run({ mode: 'host-port', stopTimeout: '99999', conns: [''] })
		expect(r.out).toContain('G=600')
	})
	it('idle but killed: SIGTERM ignored, nothing lost', () => {
		const r = run({ mode: 'host-port', exitCode: 137, conns: [''] })
		expect(r.out).toContain('ignored SIGTERM')
		expect(parseStabilityMarkers(r.out, NONCE).stopDrain).toBe('sigterm-ignored')
	})
})

describe('bridge_drain_old traefik and dns-alias modes', () => {
	it('traefik with a retry middleware: REJECT inside the old container netns, never on the host', () => {
		const r = run({ mode: 'traefik', conns: [''] })
		expect(lines(r.calls, /^nsenter -t 4242 -n iptables -w 5 -I INPUT/)[0]).toMatch(
			new RegExp(`-p tcp --dport 3000 --syn -m comment --comment powder-drain netns:3000 d[0-9]+ ${ID} -j REJECT --reject-with tcp-reset$`),
		)
		expect(r.calls).not.toMatch(/^iptables .*-I INPUT -i lo/m)
		expect(r.hostRules.trim()).toBe('')
		expect(r.calls).toContain('curl -s -o /dev/null --max-time 3 http://10.0.0.5:3000/')
		expect(r.out).toContain("Traefik's retry middleware re-sends them to the bridge")
		expect(r.calls).toContain('docker stop -t 10 oldid')
		expect(parseStabilityMarkers(r.out, NONCE).stopDrain).toBe('ok')
	})
	it('traefik with hand-written labels and no retry middleware: no REJECT, verdict no-route-away', () => {
		for (const labels of [
			'traefik.enable=true\ntraefik.http.routers.app.rule=Host(`x`)\n',
			'traefik.enable=true\ntraefik.http.routers.app.rule=Host(`x`)\ntraefik.http.routers.app.middlewares=app-retry\ntraefik.http.middlewares.app-retry.retry.attempts=1\n',
			// a second router without one
			`${TRAEFIK_LABELS}traefik.http.routers.www.rule=Host(\`www.x\`)\n`,
		]) {
			const r = run({ mode: 'traefik', conns: [''], labels })
			expect(r.calls).not.toMatch(/^nsenter .* -I INPUT/m)
			expect(r.out).toContain('its Traefik router has no retry middleware')
			expect(r.out).not.toContain('re-sends them')
			expect(r.calls).toContain('docker stop -t 30 oldid')
			expect(parseStabilityMarkers(r.out, NONCE).stopDrain).toBe('no-route-away')
		}
	})
	it('traefik keeps keep-alive connections: waits at most 5 s, then SIGTERM with the full grace', () => {
		const r = run({ mode: 'traefik', conns: ['a'] })
		expect(r.calls).toContain('docker stop -t 30 oldid')
		expect(r.out).not.toContain('no request in flight')
		expect(parseStabilityMarkers(r.out, NONCE).stopDrain).toBe('ok')
	})
	it('killed with connections open: requests in flight may have been cut', () => {
		const r = run({ mode: 'traefik', conns: ['a'], exitCode: 137 })
		expect(r.out).toContain('requests in flight may have been cut')
		expect(parseStabilityMarkers(r.out, NONCE).stopDrain).toBe('killed')
	})
	it('a netns rule that does not take effect is deleted again', () => {
		const r = run({ mode: 'dns-alias', probeRc: 0 })
		expect(lines(r.calls, /^nsenter -t 4242 -n iptables -w 5 -D INPUT/).length).toBeGreaterThan(0)
		expect(r.nsRules.trim()).toBe('')
		expect(parseStabilityMarkers(r.out, NONCE).stopDrain).toBe('no-route-away')
	})
	it('dns-alias waits the grace for idle, like host-port', () => {
		const r = run({ mode: 'dns-alias', conns: ['a', 'a', ''] })
		expect(r.out).toContain('the proxy retries them on the next address')
		expect(r.out).toContain('[drain] old container idle')
		expect(r.calls).toContain('docker stop -t 10 oldid')
	})
})

// origin/main (e9287680) rendered with these inputs, POWDER_DRAIN unset, outside vitest
// (hostAppsDir reads VITEST): the drain must leave an off deploy byte for byte as it was.
// Recorded with scratch offdiff/hash.ts against `git archive origin/main`; re-record only
// when main itself changes the script or the labels.
const MAIN_OFF = {
	swap: 'af4ad7790a64bacb2e6d6789ad49484808c02d7a40763c9d7727044f0845f97d',
	infra: '994597698c4991766d9ddb978fb9717950e983b4751477a0661f433938012e2f',
	labels: 'd36818c26a28aeb52db791c83ad4ac967f017010218ca8d32ba42a451111bed8',
}
const sha = (x: string) => createHash('sha256').update(x).digest('hex')
const outsideVitest = <T>(f: () => T): T => {
	const keep = { VITEST: process.env.VITEST, POWDER_DRAIN: process.env.POWDER_DRAIN, POWDER_DRAIN_APPS: process.env.POWDER_DRAIN_APPS }
	delete process.env.VITEST
	delete process.env.POWDER_DRAIN
	delete process.env.POWDER_DRAIN_APPS
	try {
		return f()
	} finally {
		for (const [k, v] of Object.entries(keep)) if (v !== undefined) process.env[k] = v
	}
}
const OFF_BASE = {
	workingDir: '/opt/apps/demo',
	configFile: '/opt/apps/demo/docker-compose.yml',
	service: 'app',
	cf: "-f '/opt/apps/demo/docker-compose.yml'",
	declaredMode: 'build',
	prebuilt: false,
	infra: [] as string[],
	wantBranch: null,
	wantSha: null,
	shaIsStrict: false,
	swapOrdinal: 1700000000000,
	stageId: 'dep_x',
	shaNonce: 'drain1',
} as const
const shopLabels = () =>
	renderLabelsBlock({ containerName: 'shop', hosts: ['shop.example.com'], containerPort: 3000, redirects: { redirects: [], rewrites: [], headers: {} }, serverId: 'srv-1', healthUrl: null, tlsMode: undefined } as never)

describe('POWDER_DRAIN switch', () => {
	it('defaults to off; on drains every app, canary only POWDER_DRAIN_APPS', () => {
		expect(drainModeFrom({})).toBe('off')
		expect(drainModeFrom({ POWDER_DRAIN: 'yes' })).toBe('off')
		expect(drainModeFrom({ POWDER_DRAIN: ' Canary ' })).toBe('canary')
		expect(drainActiveFor('shop', {})).toBe(false)
		expect(drainActiveFor('shop', { POWDER_DRAIN: 'on' })).toBe(true)
		expect(drainActiveFor('shop', { POWDER_DRAIN: 'canary' })).toBe(false)
		expect(drainActiveFor('shop', { POWDER_DRAIN: 'canary', POWDER_DRAIN_APPS: 'demo, shop' })).toBe(true)
		expect(drainActiveFor('shop', { POWDER_DRAIN: 'canary', POWDER_DRAIN_APPS: 'shopfront' })).toBe(false)
	})
	it('off: the deploy script and the Traefik labels are byte-identical to origin/main', () => {
		outsideVitest(() => {
			// The test gate's nonced result marks (passed, failed, none: deploys.test_gate) are
			// the one later addition to the script; without them it is main byte for byte.
			const gateMarks = /echo '__POWDER_STAB_drain1__ test-gate-result (passed|failed|none)'; /g
			for (const [script, pin] of [
				[buildDeployScript({ ...OFF_BASE, wantSha: 'c'.repeat(40) }), MAIN_OFF.swap],
				[buildDeployScript({ ...OFF_BASE, infra: ['db'] }), MAIN_OFF.infra],
			] as const) {
				expect(script.match(gateMarks)).toHaveLength(3)
				expect(sha(script.replace(gateMarks, ''))).toBe(pin)
			}
			expect(sha(shopLabels())).toBe(MAIN_OFF.labels)
		})
	})
	it('off renders no drain part at all; on renders the retry label only for the drained app', () => {
		outsideVitest(() => {
			const off = buildDeployScript({ ...OFF_BASE })
			for (const t of ['drain_', 'bridge_restore_old', 'B_DRAIN_G', 'B_RULE', 'iptables', 'powder-drain', 'B_DEAD', "trap ''"]) expect(off).not.toContain(t)
			expect(off).toContain("trap 'rc=$?; bridge_stop; release_stop; ")
			expect(shopLabels()).not.toContain('retry')
			process.env.POWDER_DRAIN = 'canary'
			process.env.POWDER_DRAIN_APPS = 'shop'
			expect(shopLabels()).toContain('traefik.http.middlewares.shop-retry.retry.attempts=10')
			expect(shopLabels()).toContain('traefik.http.routers.shop.middlewares=shop-diag,shop-retry')
			expect(buildDeployScript({ ...OFF_BASE })).not.toContain('bridge_drain_old')
			expect(buildDeployScript({ ...OFF_BASE, workingDir: '/opt/apps/shop', service: 'shop' })).toContain('bridge_drain_old')
		})
	})
})

/** The deploy script's EXIT trap, run for real with stubbed helpers: the trap of the
 *  rendered script (drain on or off), a bridge up, a pending abort record (PREVF), and
 *  the log reader gone when SSH hangs up (SIGHUP). */
async function deadStdoutTrap(drain: boolean) {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-drain-trap-'))
	const script = buildDeployScript({ ...OFF_BASE, drain })
	const trap = /trap '(rc=\$\?;[^']*)' EXIT; /.exec(script)?.[1]
	if (!trap) throw new Error('no EXIT trap in the rendered script')
	const fns = drain ? bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE, SMARK, true) : ''
	const body =
		`set -e; LAST_STEP=x; SWAPPED=0; PREVF=${dir}/prev; STAGE_IMG=""; CG_RECHECK=0; STAGE_F=""; DFR_DIR=""; ${fns}` +
		`bridge_stop() { echo "[bridge] removed demo-powder-bridge"; }; bridge_restore_old() { :; }; release_stop() { :; }; release_restore() { touch ${dir}/restored; }; tg_stop() { :; }; ` +
		`drain_clear() { :; }; touch "$PREVF"; trap '${trap}' EXIT; echo started; while :; do /bin/sleep 1; done`
	writeFileSync(join(dir, 's.sh'), body)
	const child = spawn('bash', [join(dir, 's.sh')], { stdio: ['ignore', 'pipe', 'pipe'] })
	await new Promise<void>((res) => child.stdout.once('data', () => res()))
	child.stdout.destroy()
	child.stderr.destroy()
	child.kill('SIGHUP')
	await new Promise<void>((res) => child.once('exit', () => res()))
	await new Promise((res) => setTimeout(res, 200))
	return { prev: existsSync(join(dir, 'prev')), restored: existsSync(join(dir, 'restored')) }
}

describe('EXIT trap with the log reader gone (SSH hung up before the swap)', () => {
	it('drain off: the trap is main\'s and keeps the abort record for the worker', async () => {
		const r = await deadStdoutTrap(false)
		expect(r.prev).toBe(true)
	})
	it('drain on: the trap runs to the end, restores the shared tag and still keeps the abort record', async () => {
		const r = await deadStdoutTrap(true)
		expect(r.prev).toBe(true)
		expect(r.restored).toBe(true)
	})
})

describe('turning the drain on is not a lossy deploy (Traefik labels change)', () => {
	const fns = bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE, SMARK, true)
	it("the bridge's routers get their own names, so they never conflict with the old or the new container's", () => {
		const prog = /sed -E '([^']*powder-bridge[^']*)'/.exec(fns)?.[1]
		expect(prog).toBeTruthy()
		const out = execFileSync('sed', ['-E', prog as string], {
			input: 'traefik.http.routers.app.rule=Host(`x`)\ntraefik.http.routers.app.middlewares=app-diag\ntraefik.http.services.app.loadbalancer.server.port=3000\n',
		}).toString()
		expect(out).toBe(
			'traefik.http.routers.app-powder-bridge.rule=Host(`x`)\ntraefik.http.routers.app-powder-bridge.middlewares=app-diag\ntraefik.http.services.app.loadbalancer.server.port=3000\n',
		)
		// off: no rename
		expect(bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')).not.toContain('powder-bridge./')
	})
	const handoff = (newLabels: string) => {
		const dir = mkdtempSync(join(tmpdir(), 'bridge-drain-handoff-'))
		const log = stubs(dir)
		fakeDocker(dir, log, {})
		writeFileSync(join(dir, 'recreated'), '')
		writeFileSync(
			join(dir, 'bl'),
			'traefik.enable=true\ntraefik.http.routers.app-powder-bridge.rule=Host(`x`)\ntraefik.http.routers.app-powder-bridge.middlewares=app-diag\ntraefik.http.middlewares.app-diag.headers.customresponseheaders.X-Powder-App=app\ntraefik.http.services.app.loadbalancer.server.port=3000\n',
		)
		writeFileSync(join(dir, 'nl'), newLabels)
		// the new container's labels come from docker inspect
		writeFileSync(join(dir, 'docker-impl'), readFileSync(join(dir, 'docker-impl'), 'utf8').replace('case "$*" in\n', `case "$*" in\n *'range $k,$v := .Config.Labels'*) cat ${dir}/nl; exit 0;;\n`))
		const out = execFileSync('bash', ['-c', `cap() { echo "$1"; }; ${fns} BRIDGE=demo-powder-bridge; B_PORT=3000; B_LF=${dir}/bl; bridge_handoff`], {
			env: { ...process.env, PATH: `${dir}:${pathWithout(['docker', 'iptables', 'nsenter', 'nginx', 'ss'])}` },
		}).toString()
		return { out, calls: readFileSync(log, 'utf8') }
	}
	const NEW = 'traefik.enable=true\ntraefik.http.routers.app.rule=Host(`x`)\ntraefik.http.middlewares.app-diag.headers.customresponseheaders.X-Powder-App=app\ntraefik.http.services.app.loadbalancer.server.port=3000\n'
	it('the new container adds the retry middleware: normal handoff (wait until it answers, then drain the bridge)', () => {
		const r = handoff(`${NEW}traefik.http.routers.app.middlewares=app-diag,app-retry\ntraefik.http.middlewares.app-retry.retry.attempts=10\n`)
		expect(r.out).not.toContain('removing bridge now')
		expect(r.out).toContain('new container ready; draining bridge')
	})
	it('the new container changes a service or middleware definition: the bridge goes at once, as before', () => {
		const r = handoff(NEW.replace('server.port=3000', 'server.port=3001'))
		expect(r.out).toContain('removing bridge now')
		expect(r.out).not.toContain('draining bridge')
	})
})

describe('the reaper does not hold the per-app lock', () => {
	it('fd 9 (appLockShell) and 7/8 are closed in the reaper: free as soon as the script exits', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'bridge-drain-lock-'))
		stubs(dir, { realTime: true })
		const script = `${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE, SMARK, true)} drain_rule -I host 3001 tok1; drain_reaper host 3001 tok1 4; echo inserted`
		writeFileSync(join(dir, 's.sh'), script)
		const env = { ...process.env, PATH: `${dir}:${pathWithout(['docker', 'iptables', 'nsenter', 'nginx', 'ss'])}` }
		const child = spawn('bash', [join(dir, 's.sh')], { env, stdio: ['ignore', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
		const closed = (i: number) => new Promise<number>((res) => (child.stdio[i] as NodeJS.ReadableStream).on('end', () => res(Date.now())).resume())
		const t9 = closed(9)
		const t8 = closed(8)
		const t7 = closed(7)
		const exited = await new Promise<number>((res) => child.once('exit', () => res(Date.now())))
		const ends = await Promise.race([Promise.all([t7, t8, t9]), new Promise<null>((res) => setTimeout(() => res(null), 3000))])
		expect(ends).not.toBeNull()
		for (const t of ends ?? []) expect(t - exited).toBeLessThan(1500)
		// the reaper is still alive and does its job later
		expect(readFileSync(join(dir, 'host.rules'), 'utf8')).toContain('tok1')
		expect(await waitFor(() => readFileSync(join(dir, 'host.rules'), 'utf8').trim() === '', 10_000)).toBe(true)
	})
})

// The fake `docker stop` of midDrain hangs far past any wait below and past the test
// limit (vitest.config.ts), so a rule that goes away inside WAIT_MS was deleted by the
// trap or the reaper, never after a docker call returned. Load only lengthens a run;
// it cannot make a docker-first trap pass.
const STOP_HANG_SEC = 600
const WAIT_MS = 50_000

/** A real (not stubbed) run of the generated functions under the EXIT trap the deploy
 *  script uses, stopped mid-drain while `docker stop` hangs. Returns the dir. */
function midDrain(o: { reaper: boolean; reapSec?: number; netns?: boolean }) {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-drain-leak-'))
	const log = stubs(dir, { realTime: true })
	fakeDocker(dir, log, { stopSleep: STOP_HANG_SEC })
	writeFileSync(join(dir, 'c0'), '')
	writeFileSync(join(dir, 'labels'), TRAEFIK_LABELS)
	const state = o.netns ? 'B_PORT=3000; ' : 'B_HP=13001; B_AHP=3001; B_PORT=3001; '
	const script =
		`set -e; cap() { echo "$1"; }; SWAPPED=0; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE, SMARK, true)}` +
		`trap 'rc=$?; drain_trap_first; bridge_restore_old; bridge_stop; echo trap-done >> ${dir}/trap.log' EXIT; ` +
		`${o.reaper ? `B_REAP_SEC=${o.reapSec ?? 1}; ` : 'B_REAPER=off; '}BRIDGE=demo-powder-bridge; ${state}B_LF=${dir}/labels; ` +
		`{ bridge_drain_old || true; }; echo after-drain; SWAPPED=1`
	writeFileSync(join(dir, 'script.sh'), script)
	const env = { ...process.env, PATH: `${dir}:${pathWithout(['docker', 'iptables', 'nsenter', 'nginx', 'ss'])}` }
	return { dir, env }
}

const waitFor = async (pred: () => boolean, ms: number) => {
	const end = Date.now() + ms
	while (Date.now() < end) {
		if (pred()) return true
		await new Promise((r) => setTimeout(r, 100))
	}
	return pred()
}

const ruleFile = (dir: string, f: string) => () => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim() : '')

// Each mid-drain script runs in its own process group: afterEach kills the group, so
// the hanging fake `docker stop` (and a reaper without setsid) never outlives the test.
const groups: number[] = []
const spawnMidDrain = (dir: string, env: NodeJS.ProcessEnv, stdio: 'ignore' | ['ignore', 'pipe', 'pipe']) => {
	const child = spawn('bash', [join(dir, 'script.sh')], { env, stdio, detached: true })
	if (child.pid) groups.push(child.pid)
	return child
}

describe('a drain rule cannot outlive the deploy', () => {
	afterEach(() => {
		for (const pid of groups.splice(0)) {
			try {
				process.kill(-pid, 'SIGKILL')
			} catch {}
		}
	})
	it('the reader of the deploy log goes away mid-drain (SSH channel gone): the EXIT trap deletes the rule first', async () => {
		const { dir, env } = midDrain({ reaper: false })
		const child = spawnMidDrain(dir, env, ['ignore', 'pipe', 'pipe'])
		const rules = ruleFile(dir, 'host.rules')
		expect(await waitFor(() => rules() !== '', WAIT_MS)).toBe(true)
		// sshd closes the channel and hangs up the session
		child.stdout?.destroy()
		child.stderr?.destroy()
		child.kill('SIGHUP')
		expect(await waitFor(() => rules() === '', WAIT_MS)).toBe(true)
	})
	it('the script is SIGKILLed mid-drain (no trap at all): the detached reaper deletes the host rule', async () => {
		const { dir, env } = midDrain({ reaper: true, reapSec: 2 })
		const child = spawnMidDrain(dir, env, 'ignore')
		const rules = ruleFile(dir, 'host.rules')
		expect(await waitFor(() => rules() !== '', WAIT_MS)).toBe(true)
		child.kill('SIGKILL')
		expect(rules()).not.toBe('')
		expect(await waitFor(() => rules() === '', WAIT_MS)).toBe(true)
		expect(existsSync(join(dir, 'trap.log'))).toBe(false)
	})
	it('the same for a netns rule', async () => {
		const { dir, env } = midDrain({ reaper: true, reapSec: 2, netns: true })
		const child = spawnMidDrain(dir, env, 'ignore')
		const rules = ruleFile(dir, 'ns-4242.rules')
		expect(await waitFor(() => rules() !== '', WAIT_MS)).toBe(true)
		child.kill('SIGKILL')
		expect(await waitFor(() => rules() === '', WAIT_MS)).toBe(true)
	})
	it("the worker abort path and the next bridge_start delete only this app's rules", () => {
		const dir = mkdtempSync(join(tmpdir(), 'bridge-drain-abort-'))
		const log = stubs(dir)
		fakeDocker(dir, log, {})
		writeFileSync(
			join(dir, 'host.rules'),
			`powder-drain 127.0.0.1:3001 d1 ${ID}\npowder-drain 127.0.0.1:3005 d2 ${ID}\npowder-drain 127.0.0.1:3009 d3 other-app\n`,
		)
		writeFileSync(join(dir, 'ns-4242.rules'), `powder-drain netns:3000 d4 ${ID}\n`)
		const env = { ...process.env, PATH: `${dir}:${pathWithout(['docker', 'iptables', 'nsenter', 'nginx', 'ss'])}` }
		execFileSync('bash', ['-c', `${drainAbortClearShell(ID, 'demo')} echo done`], { env })
		expect(readFileSync(join(dir, 'host.rules'), 'utf8').trim()).toBe('powder-drain 127.0.0.1:3009 d3 other-app')
		expect(readFileSync(join(dir, 'ns-4242.rules'), 'utf8').trim()).toBe('')
		// bridge_start_body: first thing, before the stale bridge is removed
		writeFileSync(join(dir, 'host.rules'), `powder-drain 127.0.0.1:3001 d1 ${ID}\n`)
		writeFileSync(log, '')
		execFileSync('bash', ['-c', `cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', '', '', true)} bridge_start_body >/dev/null; echo ok`], { env })
		expect(readFileSync(join(dir, 'host.rules'), 'utf8').trim()).toBe('')
		const calls = readFileSync(log, 'utf8').split('\n')
		const del = calls.findIndex((l) => l.startsWith('iptables -w 5 -D'))
		const stale = calls.findIndex((l) => l.includes('ps -aq --filter'))
		expect(del).toBeGreaterThan(-1)
		expect(stale).toBeGreaterThan(del)
	})
	it('route rule ids only carry safe characters', () => {
		expect(drainRuleId('/opt/apps/my.app', 'web;id')).toMatch(/^my_app-web_id-[0-9a-f]{10}$/)
		// the same readable part, different apps: different ids
		expect(drainRuleId('/opt/apps/foo', 'bar-baz')).not.toBe(drainRuleId('/opt/apps/foo-bar', 'baz'))
		expect(drainShellFunctions('true', "x'; id; '")).not.toContain('id;')
		expect(drainShellFunctions('true', SMARK)).toContain(`'${SMARK}'" stop-drain $1"`)
	})
	it('is valid bash', () => {
		execFileSync('bash', ['-n', '-c', bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', NONCE, SMARK, true)])
		execFileSync('bash', ['-n', '-c', drainAbortClearShell(ID, 'demo')])
	})
})

describe('generated deploy script wiring', () => {
	const base = {
		workingDir: '/opt/apps/demo',
		configFile: '/opt/apps/demo/docker-compose.yml',
		service: 'app',
		cf: "-f '/opt/apps/demo/docker-compose.yml'",
		declaredMode: 'build',
		prebuilt: false,
		infra: [],
		wantBranch: null,
		wantSha: null,
		shaIsStrict: false,
		swapOrdinal: 1700000000000,
		stageId: 'dep_x',
		shaNonce: NONCE,
	} as const
	const script = buildDeployScript({ ...base, infra: [], drain: true })
	it('drains after the last guard and before the recreate', () => {
		const drain = script.indexOf('el_guard && { bridge_drain_old || true; } && ')
		const up = script.indexOf('up -d --force-recreate', drain)
		expect(drain).toBeGreaterThan(script.indexOf('step "docker compose up"'))
		expect(up).toBeGreaterThan(drain)
		expect(script.indexOf('bridge_drain_old', up)).toBe(-1)
	})
	it('the EXIT trap deletes the rules before anything else, then restores the old container', () => {
		expect(script).toContain("trap 'rc=$?; drain_trap_first; if [ \"$B_DEAD\" = 1 ] && [ \"$SWAPPED\" != 1 ] && [ \"$rc\" -eq 0 ]; then rc=1; fi; bridge_restore_old; bridge_stop; ")
	})
	it('off renders no drain step', () => {
		expect(buildDeployScript({ ...base, infra: [], drain: false })).not.toContain('bridge_drain_old')
	})
	it('passes the stability marker to the drain', () => {
		expect(script).toContain(`'${SMARK}'" stop-drain $1"`)
	})
	it('drain functions snapshot', () => {
		expect(drainShellFunctions("docker compose -f 'c.yml' ps -q 'app' 2>/dev/null | head -1", SMARK, ID)).toMatchSnapshot()
	})
})
