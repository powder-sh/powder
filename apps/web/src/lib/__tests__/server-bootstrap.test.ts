import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathWithout } from './hermetic'
import {
	type BootstrapFacts,
	type BootstrapProxy,
	DOCKER_APT_KEY_FINGERPRINT,
	DOCKER_MAJOR,
	DOCKER_VERSION,
	INSPECT_MARKER,
	PRUNE_CRON_FILE,
	PRUNE_CRON_LINE,
	TRAEFIK_IMAGE,
	TRAEFIK_LOGROTATE_FILE,
	TRAEFIK_LOGROTATE_LINES,
	checkItems,
	createNetworkCommand,
	helperState,
	installDockerCommand,
	installDockerScriptCommand,
	installHelperCommand,
	installPruneCronCommand,
	installTraefikLogrotateCommand,
	isCheckGreen,
	mkdirCommand,
	parseCheckOutput,
	planApply,
	renderCheckScript,
	startTraefikCommand,
	traefikBlocker,
} from '../server-bootstrap'
import { shq } from '../shell'

const DYN = '/opt/infra/traefik/dynamic'
const W = shq(DYN)

function facts(over: Partial<BootstrapFacts> = {}): BootstrapFacts {
	return {
		root: true,
		os: 'ubuntu',
		docker: 'present',
		dockerVersion: '27.0.1',
		compose: 'present',
		networks: { web: 'present', internal: 'present' },
		traefik: 'running',
		traefikFileProvider: 'ok',
		appsDir: 'present',
		dynamicDir: 'present',
		ufw: 'inactive',
		port80: 'busy',
		port443: 'busy',
		nginx: 'absent',
		nginxBinary: 'absent',
		nginxUnit: 'absent',
		portBindings: 'bound',
		proxyContainers: 'present',
		diskFreeBytes: 100 * 1024 ** 3,
		memTotalBytes: 8 * 1024 ** 3,
		memAvailBytes: 4 * 1024 ** 3,
		...over,
	}
}

// A server that is safe for a new Traefik: nothing on or bound to 80/443.
const empty: Partial<BootstrapFacts> = {
	traefik: 'absent',
	traefikFileProvider: 'n/a',
	port80: 'free',
	port443: 'free',
	portBindings: 'none',
	proxyContainers: 'absent',
}

const fresh = facts({
	...empty,
	docker: 'absent',
	dockerVersion: null,
	compose: 'absent',
	networks: { web: 'absent', internal: 'absent' },
	appsDir: 'absent',
	dynamicDir: 'absent',
	ufw: 'absent',
})

const ids = (f: BootstrapFacts, proxy: BootstrapProxy = 'traefik') =>
	planApply(f, W, proxy).steps.map((s) => s.id)

describe('parseCheckOutput', () => {
	it('reads key=value lines and splits off the inspect JSON', () => {
		const out = [
			'uid=0',
			'os=debian',
			'docker=present',
			'docker_version=27.3.1',
			'compose=present',
			'net_web=present',
			'net_internal=absent',
			'traefik=running',
			'apps_dir=present',
			'dynamic_dir=absent',
			'ufw=active',
			'port_80=busy',
			'port_443=free',
			'nginx=present',
			'nginx_bin=present',
			'nginx_unit=disabled',
			'port_bindings=none',
			'proxy_containers=absent',
			'disk_free_kb=1048576',
			'mem_total_kb=2097152',
			'mem_avail_kb=1048576',
			INSPECT_MARKER,
			'[{"Args":["--providers.file.directory=/etc/traefik/dynamic"]}]',
		].join('\n')
		const { facts: f, inspectJson } = parseCheckOutput(out)
		expect(f).toMatchObject({
			root: true,
			os: 'debian',
			docker: 'present',
			dockerVersion: '27.3.1',
			networks: { web: 'present', internal: 'absent' },
			traefik: 'running',
			dynamicDir: 'absent',
			ufw: 'active',
			port80: 'busy',
			port443: 'free',
			nginx: 'present',
			nginxBinary: 'present',
			nginxUnit: 'disabled',
			portBindings: 'none',
			proxyContainers: 'absent',
			diskFreeBytes: 1024 ** 3,
			memTotalBytes: 2 * 1024 ** 3,
		})
		expect(JSON.parse(inspectJson)[0].Args[0]).toContain('providers.file.directory')
	})
	it('unknown or missing values fall back to the cautious side', () => {
		const { facts: f } = parseCheckOutput('uid=1000\ntraefik=weird\nport_80=\n')
		expect(f.root).toBe(false)
		expect(f.traefik).toBe('absent')
		expect(f.port80).toBe('unknown')
		expect(f.nginx).toBe('present')
		expect(f.nginxBinary).toBe('present')
		expect(f.nginxUnit).toBe('unknown')
		expect(f.portBindings).toBe('unknown')
		expect(f.proxyContainers).toBe('unknown')
		expect(f.diskFreeBytes).toBeNull()
	})
})

describe('checkItems', () => {
	it('a fully set up traefik server is green; ufw is report-only', () => {
		const items = checkItems(facts({ ufw: 'active' }), DYN, 'traefik')
		expect(isCheckGreen(items)).toBe(true)
		expect(items.find((i) => i.id === 'ufw')?.state).toBe('info')
	})
	it('a missing file provider or network fails the check on a traefik server', () => {
		expect(
			isCheckGreen(checkItems(facts({ traefikFileProvider: 'missing' }), DYN, 'traefik')),
		).toBe(false)
		expect(
			isCheckGreen(
				checkItems(facts({ networks: { web: 'present', internal: 'absent' } }), DYN, 'traefik'),
			),
		).toBe(false)
	})
	it('nginx servers: no traefik, file provider or dynamic dir is info, never missing', () => {
		for (const proxy of ['nginx', 'nginx-container'] as const) {
			const noTraefik = checkItems(
				facts({ traefik: 'absent', traefikFileProvider: 'n/a', dynamicDir: 'absent' }),
				DYN,
				proxy,
			)
			expect(isCheckGreen(noTraefik), proxy).toBe(true)
			expect(noTraefik.find((i) => i.id === 'traefik')?.state).toBe('info')
			expect(noTraefik.find((i) => i.id === 'dynamic-dir')?.state).toBe('info')
			const badProvider = checkItems(facts({ traefikFileProvider: 'missing' }), DYN, proxy)
			expect(badProvider.find((i) => i.id === 'traefik-file-provider')?.state).toBe('info')
			expect(isCheckGreen(badProvider)).toBe(true)
		}
	})
	it('low disk/memory warns but does not fail', () => {
		const items = checkItems(
			facts({ diskFreeBytes: 1024 ** 3, memTotalBytes: 1024 ** 3 }),
			DYN,
			'traefik',
		)
		expect(items.find((i) => i.id === 'disk')?.state).toBe('warn')
		expect(isCheckGreen(items)).toBe(true)
	})
})

describe('planApply', () => {
	it('a green server needs nothing', () => {
		expect(ids(facts())).toEqual([])
	})
	it('a fresh traefik server gets every step, Docker first and Traefik last', () => {
		expect(ids(fresh)).toEqual([
			'install-docker',
			'mkdir-apps',
			'mkdir-dynamic',
			'network-web',
			'network-internal',
			'start-traefik',
		])
	})
	it('a fresh nginx server gets no Traefik and no dynamic dir', () => {
		for (const proxy of ['nginx', 'nginx-container'] as const) {
			expect(ids(fresh, proxy)).toEqual([
				'install-docker',
				'mkdir-apps',
				'network-web',
				'network-internal',
			])
		}
	})
	it('nginx server with nginx stopped: no traefik step', () => {
		// nginx crashed or stopped: nothing listens, no process, but it is installed.
		const stopped = facts({
			...empty,
			nginx: 'absent',
			nginxBinary: 'present',
			nginxUnit: 'enabled',
		})
		expect(ids(stopped, 'nginx')).not.toContain('start-traefik')
		expect(ids(stopped, 'nginx-container')).not.toContain('start-traefik')
		// Even with servers.proxy wrongly set to traefik, the nginx guards refuse.
		expect(ids(stopped, 'traefik')).not.toContain('start-traefik')
		expect(ids(facts({ ...empty, nginxBinary: 'present' }), 'traefik')).not.toContain(
			'start-traefik',
		)
		expect(ids(facts({ ...empty, nginxUnit: 'enabled' }), 'traefik')).not.toContain('start-traefik')
		expect(ids(facts({ ...empty, nginxUnit: 'unknown' }), 'traefik')).not.toContain('start-traefik')
		// Stopped nginx container: its 80/443 binding survives in HostConfig.
		expect(ids(facts({ ...empty, portBindings: 'bound' }), 'traefik')).not.toContain(
			'start-traefik',
		)
		expect(ids(facts({ ...empty, proxyContainers: 'present' }), 'traefik')).not.toContain(
			'start-traefik',
		)
		expect(traefikBlocker(stopped, 'nginx')).toMatch(/routes with nginx/)
	})
	it('only the missing networks and dirs', () => {
		expect(
			ids(facts({ networks: { web: 'absent', internal: 'present' }, appsDir: 'absent' })),
		).toEqual(['mkdir-apps', 'network-web'])
	})
	it('Docker is installed only when absent, pinned, with the iptables note', () => {
		expect(ids(facts({ compose: 'absent' }))).not.toContain('install-docker')
		expect(ids(facts({ docker: 'unreachable' }))).not.toContain('install-docker')
		expect(
			planApply(facts({ compose: 'absent' }), W, 'traefik').skipped.map((s) => s.id),
		).toContain('compose')
		const step = planApply(fresh, W, 'nginx').steps.find((s) => s.id === 'install-docker')
		// the default is Docker's apt repository with the key fingerprint checked, never the script
		expect(step?.command).toBe(installDockerCommand())
		expect(step?.command).not.toContain('get.docker.com')
		expect(step?.command).toContain(`'${DOCKER_APT_KEY_FINGERPRINT}'`)
		expect(step?.command).toContain('signed-by=/etc/apt/keyrings/docker.asc')
		expect(DOCKER_APT_KEY_FINGERPRINT).toBe('9DC858229FC7DD38854AE2D88D81803C0EBFCD88')
		expect(DOCKER_MAJOR).toMatch(/^\d+$/)
		expect(step?.command).toContain(`apt-cache madison docker-ce | awk -v m=${DOCKER_MAJOR} '`)
		expect(step?.title).toMatch(/iptables/)
		// the opt-in script: pinned minor, a fresh mktemp file, not the fixed
		// /tmp/powder-get-docker.sh a local user could pre-plant
		expect(DOCKER_VERSION).toMatch(new RegExp(`^${DOCKER_MAJOR}\\.\\d+$`))
		expect(installDockerScriptCommand()).toMatch(/sh "\$GD" --version \d+\.\d+$/)
		expect(installDockerScriptCommand()).toContain('GD=$(mktemp /tmp/powder-get-docker.XXXXXX)')
		expect(installDockerScriptCommand()).not.toContain('/tmp/powder-get-docker.sh')
	})
	it('removes the Docker apt source again when apt-get update fails with it', () => {
		const root = mkdtempSync(join(tmpdir(), 'aptroot-'))
		const bin = join(root, 'bin')
		mkdirSync(bin)
		mkdirSync(join(root, 'etc/apt/sources.list.d'), { recursive: true })
		writeFileSync(join(root, 'os-release'), 'ID=debian\nVERSION_CODENAME=bookworm\n')
		const stub = (name: string, body: string) => {
			writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
			chmodSync(join(bin, name), 0o755)
		}
		// apt-get update fails once the Docker source exists (a broken repo)
		stub('apt-get', `case "$*" in *update*) [ -e ${shq(root)}/etc/apt/sources.list.d/docker.list ] && exit 100;; esac; exit 0`)
		stub('curl', 'while [ "$#" -gt 1 ]; do [ "$1" = -o ] && { echo key > "$2"; exit 0; }; shift; done; exit 1')
		stub('gpg', `printf 'pub:x\\nfpr:::::::::${DOCKER_APT_KEY_FINGERPRINT}:\\n'`)
		stub('dpkg', 'echo amd64')
		const cmd = installDockerCommand().replaceAll('/etc/apt/', `${root}/etc/apt/`).replaceAll('/etc/os-release', `${root}/os-release`)
		const r = spawnSync('bash', ['-c', `( ${cmd}\n)`], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${pathWithout(['docker'])}` } })
		expect(r.status).not.toBe(0)
		expect(r.stdout).toContain('apt-get update failed with the Docker repository')
		expect(existsSync(join(root, 'etc/apt/sources.list.d/docker.list'))).toBe(false)
		// the key this step wrote goes too
		expect(existsSync(join(root, 'etc/apt/keyrings/docker.asc'))).toBe(false)
	})
	it('Traefik only with no traefik container and 80/443 free', () => {
		expect(ids(facts(empty))).toContain('start-traefik')
		expect(ids(facts({ ...empty, traefik: 'stopped' }))).not.toContain('start-traefik')
		expect(ids(facts({ ...empty, traefik: 'running' }))).not.toContain('start-traefik')
		expect(ids(facts({ ...empty, port80: 'busy' }))).not.toContain('start-traefik')
		expect(ids(facts({ ...empty, port443: 'unknown' }))).not.toContain('start-traefik')
		expect(ids(facts({ ...empty, portBindings: 'unknown' }))).not.toContain('start-traefik')
		expect(ids(facts({ ...empty, proxyContainers: 'unknown' }))).not.toContain('start-traefik')
	})
	it('a non-root SSH user gets no steps', () => {
		const p = planApply({ ...fresh, root: false }, W, 'traefik')
		expect(p.steps).toEqual([])
		expect(p.skipped[0]?.id).toBe('all')
	})
	it('the Traefik step pins the image and wires file provider + le resolver', () => {
		const cmd = startTraefikCommand(W)
		expect(TRAEFIK_IMAGE).toMatch(/^traefik:v\d+\.\d+/)
		expect(cmd).toContain(` ${TRAEFIK_IMAGE} `)
		expect(cmd).toContain(`-v ${W}:/etc/traefik/dynamic:ro`)
		expect(cmd).toContain('--providers.file.directory=/etc/traefik/dynamic')
		expect(cmd).toContain('--providers.file.watch=true')
		expect(cmd).toContain('--certificatesresolvers.le.acme.httpchallenge=true')
		// Every runtime guard runs before docker run.
		const run = cmd.indexOf('docker run')
		for (const guard of [
			'docker inspect --type container traefik',
			'command -v nginx',
			'systemctl is-enabled nginx',
			'command -v ss',
			'ss -ltn',
			'HostPort',
		]) {
			expect(cmd.indexOf(guard), guard).toBeGreaterThan(-1)
			expect(cmd.indexOf(guard), guard).toBeLessThan(run)
		}
		expect(cmd).not.toContain('ss -H')
	})
})

// Every combination of facts: apply never emits a command that changes an
// existing traefik, nginx, ufw or any container.
describe('planApply never touches existing infrastructure', () => {
	const P = ['present', 'absent'] as const
	const combos: Array<[BootstrapFacts, BootstrapProxy]> = []
	for (const proxy of ['traefik', 'nginx', 'nginx-container'] as const)
		for (const root of [true, false])
			for (const docker of ['present', 'absent', 'unreachable'] as const)
				for (const traefik of ['running', 'stopped', 'absent'] as const)
					for (const port80 of ['busy', 'free', 'unknown'] as const)
						for (const port443 of ['busy', 'free'] as const)
							for (const nginx of P)
								for (const nginxBinary of P)
									for (const nginxUnit of ['enabled', 'disabled', 'absent', 'unknown'] as const)
										for (const portBindings of ['bound', 'none', 'unknown'] as const)
											for (const proxyContainers of ['present', 'absent', 'unknown'] as const)
												for (const ufw of ['active', 'absent'] as const)
													combos.push([
														facts({
															root,
															docker,
															traefik,
															port80,
															port443,
															nginx,
															nginxBinary,
															nginxUnit,
															portBindings,
															proxyContainers,
															ufw,
														}),
														proxy,
													])

	const APT = /apt(-get)?\s+(install|remove|purge)/
	// Mutating forms only: the Traefik step reads `command -v nginx` and
	// `systemctl is-enabled nginx` as guards.
	const FORBIDDEN = [
		/\bufw\b/,
		/\biptables\b|\bnft\b/,
		/systemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|kill)\b/,
		/\bservice\s+\S+\s+(start|stop|restart|reload)/,
		/nginx\s+-s\b|\bpkill\b|\bkillall\b/,
		APT,
		/docker\s+(rm|stop|restart|kill|update|rename|pause|start|compose|network\s+(rm|disconnect|connect))\b/,
		/docker\s+container\s+(rm|stop|restart|kill|update)/,
	]

	it(`checks ${combos.length} combinations`, () => {
		expect(combos.length).toBeGreaterThan(10_000)
		// Plain checks in the loop (expect() per combination is too slow); any
		// violation is collected and reported at the end.
		const bad: string[] = []
		for (const [f, proxy] of combos) {
			const { steps } = planApply(f, W, proxy)
			const tag = () => JSON.stringify({ proxy, ...f })
			for (const s of steps) {
				for (const re of FORBIDDEN) {
					// installing Docker's own packages is that step's job; no other step runs apt
					if (re === APT && s.id === 'install-docker') continue
					if (re.test(s.command)) bad.push(`${s.id} ${re}: ${tag()}`)
				}
			}
			const traefikStep = steps.some((s) => s.id === 'start-traefik')
			const safe =
				proxy === 'traefik' &&
				f.traefik === 'absent' &&
				f.nginx === 'absent' &&
				f.nginxBinary === 'absent' &&
				(f.nginxUnit === 'absent' || f.nginxUnit === 'disabled') &&
				f.port80 === 'free' &&
				f.port443 === 'free' &&
				f.portBindings === 'none' &&
				f.proxyContainers === 'absent' &&
				f.docker !== 'unreachable' &&
				f.root
			if (traefikStep !== safe) bad.push(`traefik=${traefikStep}: ${tag()}`)
			if (
				proxy !== 'traefik' &&
				steps.some((s) => s.id === 'mkdir-dynamic' || /docker run/.test(s.command))
			) {
				bad.push(`traefik piece on ${proxy}: ${tag()}`)
			}
			if (f.docker !== 'absent' && steps.some((s) => s.id === 'install-docker')) {
				bad.push(`docker reinstall: ${tag()}`)
			}
			if (!f.root && steps.length > 0) bad.push(`non-root steps: ${tag()}`)
		}
		expect(bad.slice(0, 5)).toEqual([])
	}, 30_000)
})

// Port detection and the runtime guard under a real shell with stub tools:
// an ss failure must read as unknown and refuse, never as free.
describe('port checks fail closed (stubbed ss/docker)', () => {
	function sandbox(
		ssScript: string | null,
		systemctlScript: string | null = null,
	): { dir: string; env: { PATH: string }; log: string } {
		const dir = mkdtempSync(join(tmpdir(), 'powder-bootstrap-'))
		const bin = join(dir, 'bin')
		spawnSync('mkdir', ['-p', bin])
		// Only the tools the snippets need, so the host's real ss/nginx/systemctl never leak in.
		for (const t of ['sh', 'awk', 'grep', 'mkdir', 'install', 'cat', 'head', 'printf']) {
			const which = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim()
			if (which.startsWith('/')) symlinkSync(which, join(bin, t))
		}
		const log = join(dir, 'docker.log')
		const stub = (name: string, body: string) => {
			writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
			chmodSync(join(bin, name), 0o755)
		}
		stub(
			'docker',
			`echo "$@" >> '${log}'\ncase "$1" in inspect) exit 1 ;; ps) exit 0 ;; info) exit 0 ;; *) exit 0 ;; esac`,
		)
		if (ssScript !== null) stub('ss', ssScript)
		if (systemctlScript !== null) stub('systemctl', systemctlScript)
		return { dir, env: { PATH: bin }, log }
	}
	const run = (script: string, env: { PATH: string }) =>
		spawnSync(`${env.PATH}/sh`, ['-c', script], {
			env: env as unknown as NodeJS.ProcessEnv,
			encoding: 'utf8',
		})
	const portLine = renderCheckScript("'/nonexistent'")
		.split('\n')
		.filter((l) => l.startsWith('have()') || l.includes('ssout'))
		.join('\n')

	const unitLine = renderCheckScript("'/nonexistent'")
		.split('\n')
		.filter((l) => l.startsWith('have()') || l.includes('nginx_unit'))
		.join('\n')
	const EMPTY_SS = `printf 'State Recv-Q Send-Q Local Address:Port\\n'`
	// systemctl stubs: what `systemctl is-enabled nginx` does in each case.
	const NO_BUS = 'echo "Failed to connect to bus: No such file or directory" >&2; exit 1'
	const NO_UNIT = 'exit 4'
	const DISABLED = 'echo disabled; exit 1'
	const ENABLED = 'echo enabled; exit 0'

	it('systemctl failing (no bus, empty output, exit 1) reads as unknown', () => {
		const { env } = sandbox(EMPTY_SS, NO_BUS)
		expect(run(unitLine, env).stdout).toBe('nginx_unit=unknown\n')
	})
	it('systemctl unit states: exit 4 = absent, disabled, enabled, odd output = unknown', () => {
		const cases: Array<[string, string]> = [
			[NO_UNIT, 'absent'],
			[DISABLED, 'disabled'],
			['echo masked; exit 1', 'disabled'],
			[ENABLED, 'enabled'],
			['echo generated; exit 0', 'unknown'],
			['exit 3', 'unknown'],
		]
		for (const [stub, want] of cases) {
			const { env } = sandbox(EMPTY_SS, stub)
			expect(run(unitLine, env).stdout, stub).toBe(`nginx_unit=${want}\n`)
		}
		expect(parseCheckOutput('nginx_unit=unknown').facts.nginxUnit).toBe('unknown')
		expect(traefikBlocker(facts({ ...empty, nginxUnit: 'unknown' }), 'traefik')).toMatch(
			/systemd unit state/,
		)
	})
	it('the Traefik guard refuses when systemctl fails or nginx is enabled', () => {
		for (const sc of [NO_BUS, ENABLED, 'exit 3', 'echo generated']) {
			const { dir, env, log } = sandbox(EMPTY_SS, sc)
			const r = run(startTraefikCommand(shq(join(dir, 'dyn'))), env)
			expect(r.status, sc).toBe(1)
			expect(r.stdout, sc).toMatch(/nginx systemd unit/)
			const calls = spawnSync(`${env.PATH}/cat`, [log], { encoding: 'utf8' }).stdout
			expect(calls).not.toMatch(/^run /m)
		}
	})
	it('the Traefik guard passes a missing (exit 4) or disabled nginx unit', () => {
		for (const sc of [NO_UNIT, DISABLED]) {
			const { dir, env, log } = sandbox(EMPTY_SS, sc)
			const r = run(startTraefikCommand(shq(join(dir, 'dyn'))), env)
			expect(r.status, sc).toBe(0)
			expect(readFileSync(log, 'utf8')).toMatch(/^run -d --name traefik /m)
		}
	})

	const LISTEN = [
		'State  Recv-Q Send-Q Local Address:Port Peer Address:Port',
		'LISTEN 0      511    0.0.0.0:8080       0.0.0.0:*',
		'LISTEN 0      511    [::]:443           [::]:*',
	].join('\\n')

	it('ss missing: both ports unknown', () => {
		const { env } = sandbox(null)
		expect(run(portLine, env).stdout).toBe('port_80=unknown\nport_443=unknown\n')
	})
	it('ss exits non-zero: unknown, not free', () => {
		const { env } = sandbox('echo "Cannot open netlink socket" >&2; exit 1')
		expect(run(portLine, env).stdout).toBe('port_80=unknown\nport_443=unknown\n')
	})
	it('ss output: 8080 is not 80, [::]:443 is busy', () => {
		const { env } = sandbox(`printf '${LISTEN}\\n'`)
		expect(run(portLine, env).stdout).toBe('port_80=free\nport_443=busy\n')
	})
	it('the Traefik guard refuses when ss is missing or fails, before docker run', () => {
		for (const ss of [null, 'exit 1', `printf '${LISTEN}\\n'`]) {
			const { dir, env, log } = sandbox(ss)
			const r = run(startTraefikCommand(shq(join(dir, 'dyn'))), env)
			expect(r.status, String(ss)).toBe(1)
			const calls = spawnSync(`${env.PATH}/cat`, [log], { encoding: 'utf8' }).stdout
			expect(calls).not.toMatch(/^run /m)
		}
	})
	it('a clean server passes the guard and reaches docker run', () => {
		const { dir, env, log } = sandbox(`printf 'State Recv-Q Send-Q Local Address:Port\\n'`)
		const r = run(startTraefikCommand(shq(join(dir, 'dyn'))), env)
		expect(r.status).toBe(0)
		expect(readFileSync(log, 'utf8')).toMatch(/^run -d --name traefik /m)
	})
})

// bin/server-bootstrap.sh must run the same check and the same step commands.
describe('bin/server-bootstrap.sh stays in sync', () => {
	const script = readFileSync(join(__dirname, '../../../../../bin/server-bootstrap.sh'), 'utf8')
	const SH = '"$DYN"'
	const norm = (s: string) =>
		s
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)

	it('the check body is identical', () => {
		const m = /# BEGIN CHECK\n([\s\S]*?)# END CHECK/.exec(script)
		expect(m).not.toBeNull()
		expect(norm(m?.[1] ?? '')).toEqual(norm(renderCheckScript(SH)))
	})
	it('every step command appears verbatim', () => {
		const lines = new Set(norm(script))
		for (const cmd of [
			installDockerCommand(),
			installDockerScriptCommand(),
			installTraefikLogrotateCommand(),
			createNetworkCommand('web'),
			createNetworkCommand('internal'),
			mkdirCommand(shq('/opt/apps')),
			mkdirCommand(SH),
			startTraefikCommand(SH),
			installHelperCommand('powder-migrate'),
			installHelperCommand('powder-image-prune'),
			installPruneCronCommand(),
		]) {
			for (const l of norm(cmd)) expect(lines.has(l), l).toBe(true)
		}
	})
	it('--apply without --proxy refuses before checking anything', () => {
		const r = spawnSync(
			'bash',
			[join(__dirname, '../../../../../bin/server-bootstrap.sh'), '--apply'],
			{
				encoding: 'utf8',
			},
		)
		expect(r.status).toBe(2)
		expect(r.stderr).toMatch(/--apply needs --proxy/)
		expect(r.stdout).toBe('')
	})
	it('the convenience script is planned only with --docker-script, never by --yes', () => {
		// check mode as "root" on a server without docker: stub id, keep docker off PATH
		const bin = mkdtempSync(join(tmpdir(), 'bs-'))
		writeFileSync(join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 })
		const plan = (...args: string[]) =>
			spawnSync('bash', [join(__dirname, '../../../../../bin/server-bootstrap.sh'), '--proxy', 'nginx', ...args], {
				encoding: 'utf8',
				env: { ...process.env, PATH: `${bin}:${pathWithout(['docker'])}` },
			}).stdout
		const def = plan('--yes')
		expect(def).toMatch(/^--- install_docker$/m)
		expect(def).not.toContain('install_docker_script')
		expect(def).not.toContain('get.docker.com')
		expect(def).toContain(DOCKER_APT_KEY_FINGERPRINT)
		const opt = plan('--docker-script')
		expect(opt).toMatch(/^--- install_docker_script$/m)
		expect(opt).not.toMatch(/^--- install_docker$/m)
		expect(opt).toContain('https://get.docker.com')
		expect(script).toContain('--docker-script) DOCKER_SCRIPT=1 ;;')
	})
	it('defaults to check mode and --proxy traefik, and guards Traefik on proxy and nginx', () => {
		expect(script).toMatch(/^MODE=check$/m)
		expect(script).toMatch(/^PROXY=$/m)
		expect(script).toContain('if [ "$PROXY" != traefik ]; then echo')
		expect(script).toContain('[ "$(get nginx_bin)" != absent ]')
		expect(script).toContain('case "$(get port_bindings)" in')
		expect(script).toContain('[ "$PROXY" = traefik ] && STEPS+=(mkdir_dynamic)')
	})
})

describe('per-server helpers', () => {
	const SHA_M = 'a'.repeat(64)
	const SHA_P = 'b'.repeat(64)
	const shipped = { migrate: SHA_M, imagePrune: SHA_P }
	const withHelpers = (over: Partial<BootstrapFacts> = {}) =>
		facts({
			helpers: { migrate: 'present', imagePrune: 'present', resourceGuard: 'absent' },
			helperShas: { migrate: SHA_M, imagePrune: SHA_P, resourceGuard: null },
			...over,
		})
	it('the check reports each helper by its fixed path, with its sha256', () => {
		const script = renderCheckScript(W)
		for (const h of ['migrate', 'image-prune', 'resource-guard']) expect(script).toContain(h)
		expect(script).toContain('[ -x "/usr/local/bin/powder-$h" ]')
		expect(script).toContain('echo "helper_${k}_sha=$(sha256sum "/usr/local/bin/powder-$h" 2>/dev/null | cut -c1-64)"')
		const { facts: f } = parseCheckOutput(`helper_migrate=present\nhelper_migrate_sha=${SHA_M}\nhelper_image_prune=absent\nhelper_image_prune_sha=\nhelper_resource_guard_sha=junk\n`)
		expect(f.helpers).toEqual({ migrate: 'present', imagePrune: 'absent', resourceGuard: 'absent' })
		expect(f.helperShas).toEqual({ migrate: SHA_M, imagePrune: null, resourceGuard: null })
	})
	it('absent / outdated / current against the shipped copy', () => {
		expect(helperState(withHelpers(), 'migrate', shipped)).toBe('current')
		expect(helperState(withHelpers({ helperShas: { migrate: 'c'.repeat(64) } }), 'migrate', shipped)).toBe('outdated')
		expect(helperState(withHelpers({ helpers: { migrate: 'absent', imagePrune: 'present', resourceGuard: 'absent' } }), 'migrate', shipped)).toBe('absent')
		// Nothing shipped to compare with: present counts as current.
		expect(helperState(withHelpers({ helperShas: { migrate: 'c'.repeat(64) } }), 'migrate', {})).toBe('current')
	})
	it('missing or outdated helpers warn with the reason, never fail the check; the resource guard is optional', () => {
		const items = checkItems(
			withHelpers({ helpers: { migrate: 'absent', imagePrune: 'present', resourceGuard: 'absent' }, helperShas: { imagePrune: 'c'.repeat(64) } }),
			DYN,
			'traefik',
			shipped,
		)
		const h = items.find((i) => i.id === 'helpers')
		expect(h?.state).toBe('warn')
		expect(h?.detail).toContain('powder-migrate not installed (without it the per-app SQL migrations are skipped on deploy; fix missing pieces installs it)')
		expect(h?.detail).toContain('powder-image-prune outdated')
		expect(h?.detail).toContain('replaces it only when you tick it')
		expect(h?.detail).not.toContain('resource-guard')
		expect(isCheckGreen(items)).toBe(true)
		const all = checkItems(withHelpers(), DYN, 'traefik', shipped)
		expect(all.find((i) => i.id === 'helpers')?.state).toBe('ok')
	})
	it('the resource guard is its own info line, installed or not, never compared or planned', () => {
		const absent = checkItems(withHelpers(), DYN, 'traefik', shipped).find((i) => i.id === 'resource-guard')
		expect(absent?.state).toBe('info')
		expect(absent?.detail).toMatch(/^optional, not installed: caps app containers that have no memory limit/)
		const present = withHelpers({
			helpers: { migrate: 'present', imagePrune: 'present', resourceGuard: 'present' },
			helperShas: { migrate: SHA_M, imagePrune: SHA_P, resourceGuard: 'd'.repeat(64) },
		})
		const item = checkItems(present, DYN, 'traefik', { ...shipped, resourceGuard: 'e'.repeat(64) }).find(
			(i) => i.id === 'resource-guard',
		)
		expect(item).toEqual({ id: 'resource-guard', label: 'powder-resource-guard', state: 'info', detail: 'installed (optional; not checked for updates)' })
		expect(planApply(present, W, 'traefik', { ...shipped, resourceGuard: 'e'.repeat(64) }).steps).toEqual([])
	})
	it('the plan installs an absent helper, replaces an outdated one, never the resource guard', () => {
		const f = withHelpers({
			helpers: { migrate: 'absent', imagePrune: 'present', resourceGuard: 'absent' },
			helperShas: { imagePrune: 'c'.repeat(64) },
		})
		const plan = planApply(f, W, 'traefik', shipped)
		const steps = plan.steps.filter((s) => s.helper)
		expect(steps.map((s) => [s.id, s.helper, s.replaces])).toEqual([
			['install-powder-migrate', 'migrate', undefined],
			['replace-powder-image-prune', 'imagePrune', true],
		])
		expect(steps[0]?.title).toBe('install /usr/local/bin/powder-migrate (root, 0755)')
		expect(steps[1]?.title).toMatch(/^replace \/usr\/local\/bin\/powder-image-prune: the installed copy differs/)
		expect(steps[0]?.command.startsWith(`S=${SHA_M}\n`)).toBe(true)
		expect(steps[0]?.command).toMatchSnapshot()
		expect(plan.steps.some((s) => /resource-guard/.test(s.id))).toBe(false)
		expect(planApply(withHelpers(), W, 'traefik', shipped).steps.filter((s) => s.helper)).toEqual([])
	})
	it('a helper this image does not ship is skipped, and a non-root user gets no helper step', () => {
		const f = withHelpers({ helpers: { migrate: 'absent', imagePrune: 'absent', resourceGuard: 'absent' } })
		const plan = planApply(f, W, 'traefik', {})
		expect(plan.steps.filter((s) => s.helper)).toEqual([])
		expect(plan.skipped.map((s) => s.id)).toEqual(expect.arrayContaining(['powder-migrate', 'powder-image-prune']))
		expect(planApply({ ...f, root: false }, W, 'traefik', shipped).steps).toEqual([])
	})
	it('the install command verifies the upload, refuses a directory, then 0755 + mv', () => {
		const run = (prep: (dir: string, t: string) => string) => {
			const dir = mkdtempSync(join(tmpdir(), 'helper-'))
			const t = join(dir, '.powder-migrate.x')
			writeFileSync(t, 'echo hi\n', { mode: 0o600 })
			const sha = prep(dir, t)
			// Same lines, a temp dir for /usr/local/bin, and no chown (tests do not run as root).
			const cmd = installHelperCommand('powder-migrate').replaceAll('/usr/local/bin', dir).replace('chown root:root "$T" && ', '')
			const r = spawnSync('bash', ['-c', `T='${t}'; S='${sha}'\n${cmd}`], { encoding: 'utf8' })
			return { r, dir, t }
		}
		const good = createHash('sha256').update('echo hi\n').digest('hex')
		const ok = run(() => good)
		expect(ok.r.status, ok.r.stdout).toBe(0)
		expect(statSync(join(ok.dir, 'powder-migrate')).mode & 0o777).toBe(0o755)
		expect(existsSync(ok.t)).toBe(false)
		const bad = run(() => 'f'.repeat(64))
		expect(bad.r.status).toBe(1)
		expect(bad.r.stdout).toContain('does not match, nothing installed')
		expect(existsSync(join(bad.dir, 'powder-migrate'))).toBe(false)
		expect(existsSync(bad.t)).toBe(false)
		const isDir = run((dir) => {
			mkdirSync(join(dir, 'powder-migrate'))
			return good
		})
		expect(isDir.r.status).toBe(1)
		expect(isDir.r.stdout).toContain('is a directory, not touching it')
	})
})

describe('git and flock', () => {
	it('the check reports both; a missing one fails the check and is skipped in the plan', () => {
		expect(renderCheckScript(W)).toContain('for c in git flock; do if have "$c"; then echo "cmd_$c=present"')
		const { facts: parsed } = parseCheckOutput('cmd_git=present\ncmd_flock=absent\n')
		expect(parsed.tools).toEqual({ git: 'present', flock: 'absent' })
		const f = facts({ tools: { git: 'present', flock: 'absent' } })
		const items = checkItems(f, DYN, 'traefik')
		const t = items.find((i) => i.id === 'tools')
		expect(t?.state).toBe('missing')
		expect(t?.detail).toContain('flock (util-linux: the per-app deploy lock)')
		expect(isCheckGreen(items)).toBe(false)
		expect(planApply(f, W, 'traefik').skipped).toContainEqual({ id: 'flock', reason: "install util-linux (flock) with the distro's package manager" })
		const ok = checkItems(facts({ tools: { git: 'present', flock: 'present' } }), DYN, 'traefik')
		expect(ok.find((i) => i.id === 'tools')?.state).toBe('ok')
	})
	it('the shell twin checks them and skips them the same way', () => {
		const script = readFileSync(join(__dirname, '../../../../../bin/server-bootstrap.sh'), 'utf8')
		expect(script).toContain(`req missing 'git and flock'`)
		expect(script).toContain(`SKIPPED+=("flock: install util-linux (flock) with the distro's package manager")`)
		expect(script).toContain('STEPS+=("install_powder_$_h")')
		expect(script).not.toMatch(/install_powder_resource/)
	})
})

describe('image prune cron', () => {
	const shipped = { migrate: 'a'.repeat(64), imagePrune: 'b'.repeat(64) }
	const srv = (pruneCron: BootstrapFacts['pruneCron'], imagePrune: 'present' | 'absent' = 'present') =>
		facts({
			helpers: { migrate: 'present', imagePrune, resourceGuard: 'absent' },
			helperShas: { migrate: shipped.migrate, imagePrune: imagePrune === 'present' ? shipped.imagePrune : null },
			pruneCron,
		})
	it('is exactly the line the script header documents', () => {
		const header = readFileSync(join(__dirname, '../../../../../infra/powder-image-prune.sh'), 'utf8')
		expect(header).toContain(`echo '${PRUNE_CRON_LINE}' > ${PRUNE_CRON_FILE}`)
	})
	it('the check reads absent / current / different / no-crond; missing output stays undefined', () => {
		expect(parseCheckOutput('prune_cron=absent\n').facts.pruneCron).toBe('absent')
		expect(parseCheckOutput('prune_cron=current\n').facts.pruneCron).toBe('current')
		expect(parseCheckOutput('prune_cron=no-crond\n').facts.pruneCron).toBe('no-crond')
		expect(parseCheckOutput('prune_cron=junk\n').facts.pruneCron).toBe('different')
		expect(parseCheckOutput('uid=0\n').facts.pruneCron).toBeUndefined()
	})
	it('check items: current ok, absent warn, other content info, no cron.d warn with the manual line', () => {
		const item = (c: BootstrapFacts['pruneCron']) => checkItems(srv(c), DYN, 'traefik', shipped).find((i) => i.id === 'image-prune-cron')
		expect(item('current')?.state).toBe('ok')
		expect(item('absent')?.state).toBe('warn')
		expect(item('different')?.state).toBe('info')
		expect(item('different')?.detail).toContain('left as is')
		expect(item('no-crond')?.state).toBe('warn')
		expect(item('no-crond')?.detail).toContain(PRUNE_CRON_LINE)
		expect(isCheckGreen(checkItems(srv('absent'), DYN, 'traefik', shipped))).toBe(true)
	})
	it('plan: added when absent and the helper is there or being installed; never for other content', () => {
		const ids = (f: BootstrapFacts) => planApply(f, W, 'traefik', shipped).steps.map((s) => s.id)
		expect(ids(srv('absent'))).toEqual(['install-image-prune-cron'])
		expect(ids(srv('absent', 'absent'))).toEqual(['install-powder-image-prune', 'install-image-prune-cron'])
		expect(ids(srv('current'))).toEqual([])
		expect(ids(srv('different'))).toEqual([])
		const noCrond = planApply(srv('no-crond'), W, 'traefik', shipped)
		expect(noCrond.steps).toEqual([])
		expect(noCrond.skipped.find((s) => s.id === 'image-prune-cron')?.reason).toContain(PRUNE_CRON_LINE)
		const notShipped = planApply(srv('absent', 'absent'), W, 'traefik', {})
		expect(notShipped.steps).toEqual([])
		expect(notShipped.skipped.map((s) => s.id)).toContain('image-prune-cron')
	})
	it('the command writes the fixed line 0644, never touches an existing file, and refuses without the helper', () => {
		const run = (prep: (cron: string, bin: string) => void) => {
			const dir = mkdtempSync(join(tmpdir(), 'cron-'))
			const cron = join(dir, 'cron.d')
			const bin = join(dir, 'bin')
			mkdirSync(bin)
			prep(cron, bin)
			const cmd = installPruneCronCommand()
				.replaceAll('/etc/cron.d', cron)
				.replaceAll("'/usr/local/bin/powder-image-prune'", `'${bin}/powder-image-prune'`)
				.replace('chown root:root "$C" && ', '')
			return { r: spawnSync('bash', ['-c', cmd], { encoding: 'utf8' }), file: join(cron, 'powder-image-prune'), cron }
		}
		const helper = (bin: string) => writeFileSync(join(bin, 'powder-image-prune'), '#!/bin/sh\n', { mode: 0o755 })
		const ok = run((cron, bin) => {
			mkdirSync(cron)
			helper(bin)
		})
		expect(ok.r.status, ok.r.stdout).toBe(0)
		expect(readFileSync(ok.file, 'utf8')).toBe(`${PRUNE_CRON_LINE}\n`)
		expect(statSync(ok.file).mode & 0o777).toBe(0o644)
		expect(spawnSync('ls', ['-A', ok.cron], { encoding: 'utf8' }).stdout.trim()).toBe('powder-image-prune')
		const kept = run((cron, bin) => {
			mkdirSync(cron)
			helper(bin)
			writeFileSync(join(cron, 'powder-image-prune'), 'mine\n')
		})
		expect(kept.r.status).toBe(0)
		expect(kept.r.stdout).toContain('exists, left as is')
		expect(readFileSync(kept.file, 'utf8')).toBe('mine\n')
		const noHelper = run((cron) => mkdirSync(cron))
		expect(noHelper.r.status).toBe(1)
		expect(existsSync(noHelper.file)).toBe(false)
		const noDir = run((_cron, bin) => helper(bin))
		expect(noDir.r.status).toBe(1)
		expect(noDir.r.stdout).toContain(PRUNE_CRON_LINE)
	})
	it('the check line reports each state under a real shell', () => {
		const line = renderCheckScript(W)
			.split('\n')
			.find((l) => l.includes('prune_cron='))
		expect(line).toBeDefined()
		const probe = (prep: (cron: string) => void) => {
			const dir = mkdtempSync(join(tmpdir(), 'cronchk-'))
			const cron = join(dir, 'cron.d')
			prep(cron)
			return spawnSync('bash', ['-c', (line ?? '').replaceAll('/etc/cron.d', cron)], { encoding: 'utf8' }).stdout.trim()
		}
		expect(probe(() => {})).toBe('prune_cron=no-crond')
		expect(probe((c) => mkdirSync(c))).toBe('prune_cron=absent')
		expect(
			probe((c) => {
				mkdirSync(c)
				writeFileSync(join(c, 'powder-image-prune'), `${PRUNE_CRON_LINE}\n`)
			}),
		).toBe('prune_cron=current')
		expect(
			probe((c) => {
				mkdirSync(c)
				writeFileSync(join(c, 'powder-image-prune'), '17 * * * * root /usr/local/bin/my-wrapper /usr/local/bin/powder-image-prune\n')
			}),
		).toBe('prune_cron=different')
	})
})

describe('traefik access log', () => {
	const srv = (traefikLogrotate: BootstrapFacts['traefikLogrotate']) => facts({ traefikLogrotate })
	it('the log dir is created 0750, not world-readable', () => {
		const cmd = startTraefikCommand(W)
		expect(cmd).toContain('install -d -m 0750 /var/log/traefik')
		expect(cmd).not.toContain('/opt/infra/traefik/acme /var/log/traefik')
	})
	it('the check reads absent / current / different / no-logrotate; missing output stays undefined', () => {
		expect(parseCheckOutput('traefik_logrotate=absent\n').facts.traefikLogrotate).toBe('absent')
		expect(parseCheckOutput('traefik_logrotate=current\n').facts.traefikLogrotate).toBe('current')
		expect(parseCheckOutput('traefik_logrotate=no-logrotate\n').facts.traefikLogrotate).toBe('no-logrotate')
		expect(parseCheckOutput('traefik_logrotate=junk\n').facts.traefikLogrotate).toBe('different')
		expect(parseCheckOutput('uid=0\n').facts.traefikLogrotate).toBeUndefined()
	})
	it('plan: added on traefik servers when absent; never on nginx, never over an existing file', () => {
		const ids = (f: BootstrapFacts, proxy: BootstrapProxy = 'traefik') => planApply(f, W, proxy).steps.map((s) => s.id)
		expect(ids(srv('absent'))).toEqual(['install-traefik-logrotate'])
		expect(ids(srv('absent'), 'nginx')).toEqual([])
		expect(ids(srv('current'))).toEqual([])
		expect(ids(srv('different'))).toEqual([])
		expect(planApply(srv('no-logrotate'), W, 'traefik').skipped.map((s) => s.id)).toContain('traefik-logrotate')
		const item = (c: BootstrapFacts['traefikLogrotate']) => checkItems(srv(c), DYN, 'traefik').find((i) => i.id === 'traefik-logrotate')
		expect(item('current')?.state).toBe('ok')
		expect(item('absent')?.state).toBe('warn')
		expect(item('different')?.state).toBe('info')
		expect(checkItems(srv('absent'), DYN, 'nginx').find((i) => i.id === 'traefik-logrotate')).toBeUndefined()
	})
	it('the config rotates daily with a size cap, keeps 7 and copytruncates', () => {
		expect(TRAEFIK_LOGROTATE_LINES[0]).toBe('/var/log/traefik/*.log {')
		for (const l of ['daily', 'maxsize 100M', 'rotate 7', 'copytruncate', 'missingok']) expect(TRAEFIK_LOGROTATE_LINES).toContain(`  ${l}`)
	})
	it('the command writes the file 0644 once, the check then reads it as current, an existing file is kept', () => {
		const dir = mkdtempSync(join(tmpdir(), 'lr-'))
		const etc = join(dir, 'etc')
		mkdirSync(join(etc, 'logrotate.d'), { recursive: true })
		const sub = (c: string) => c.replaceAll('/etc/', `${etc}/`).replace('chown root:root "$C" && ', '')
		const cmd = sub(installTraefikLogrotateCommand())
		const file = join(etc, 'logrotate.d/powder-traefik')
		const check = sub(renderCheckScript(W).split('\n').find((l) => l.includes('traefik_logrotate=')) ?? '')
		expect(spawnSync('bash', ['-c', check], { encoding: 'utf8' }).stdout.trim()).toBe('traefik_logrotate=absent')
		const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })
		expect(r.status, r.stdout).toBe(0)
		expect(readFileSync(file, 'utf8')).toBe(`${TRAEFIK_LOGROTATE_LINES.join('\n')}\n`)
		expect(statSync(file).mode & 0o777).toBe(0o644)
		expect(spawnSync('ls', ['-A', join(etc, 'logrotate.d')], { encoding: 'utf8' }).stdout.trim()).toBe('powder-traefik')
		expect(spawnSync('bash', ['-c', check], { encoding: 'utf8' }).stdout.trim()).toBe('traefik_logrotate=current')
		writeFileSync(file, 'mine\n')
		expect(spawnSync('bash', ['-c', check], { encoding: 'utf8' }).stdout.trim()).toBe('traefik_logrotate=different')
		const again = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })
		expect(again.stdout).toContain('exists, left as is')
		expect(readFileSync(file, 'utf8')).toBe('mine\n')
		expect(TRAEFIK_LOGROTATE_FILE).toBe('/etc/logrotate.d/powder-traefik')
	})
})

describe('replacing an outdated helper is opt-in', () => {
	const script = readFileSync(join(__dirname, '../../../../../bin/server-bootstrap.sh'), 'utf8')
	it('the plan marks it replaces; an install id never matches it', () => {
		const shipped = { migrate: 'a'.repeat(64), imagePrune: 'b'.repeat(64) }
		const f = facts({
			helpers: { migrate: 'present', imagePrune: 'present', resourceGuard: 'absent' },
			helperShas: { migrate: 'c'.repeat(64), imagePrune: shipped.imagePrune },
		})
		const steps = planApply(f, W, 'traefik', shipped).steps
		expect(steps.map((s) => s.id)).toEqual(['replace-powder-migrate'])
		expect(steps[0]?.replaces).toBe(true)
		expect(steps.some((s) => s.id === 'install-powder-migrate')).toBe(false)
		// Adds never carry the flag.
		expect(planApply(fresh, W, 'traefik', shipped).steps.every((s) => !s.replaces)).toBe(true)
	})
	it('the shell twin replaces only with --replace-helpers and otherwise reports outdated', () => {
		expect(script).toContain('--replace-helpers) REPLACE=1 ;;')
		expect(script).toMatch(/^REPLACE=0$/m)
		expect(script).toContain('elif [ "$REPLACE" = 1 ]; then STEPS+=("replace_powder_$_h")')
		expect(script).toContain('else SKIPPED+=("$_b: outdated, left as is; rerun with --replace-helpers to replace it"); fi')
		expect(script).toContain('elif [ "$_st" = absent ]; then STEPS+=("install_powder_$_h")')
	})
	it('the shell twin adds the cron only when the helper is there or being installed', () => {
		expect(script).toContain('STEPS+=(install_image_prune_cron)')
		expect(script).toContain("SKIPPED+=('image-prune-cron: powder-image-prune is not installed; install it first')")
	})
})
