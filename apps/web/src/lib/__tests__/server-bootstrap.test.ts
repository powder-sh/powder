import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ExpectStatic, describe, expect, it } from 'vitest'
import { pathWithout } from './hermetic'
import {
	type BootstrapFacts,
	type BootstrapProxy,
	DOCKER_APT_KEY_FINGERPRINT,
	DOCKER_MAJOR,
	DOCKER_VERSION,
	DYNAMIC_DIR_MISSING,
	DYNAMIC_DIR_UNUSED,
	INSPECT_MARKER,
	NETWORK_INTERNAL_ABSENT,
	NETWORK_WEB_ABSENT,
	NETWORK_WEB_MISSING,
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
	missingPieces,
	mkdirCommand,
	networkCommand,
	parseCheckOutput,
	planApply,
	renderCheckScript,
	startTraefikCommand,
	fileProviderUnused,
	networkWebNotUsed,
	traefikBlocker,
	traefikNetworkMissing,
	traefikNotAttached,
} from '../server-bootstrap'
import { type InspectJson, traefikConfigHostPath, traefikNetworkFrom } from '../traefik-network'
import { renderComposeYaml } from '../compose-render'
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
	it('a missing file provider or network web fails the check on a traefik server', () => {
		expect(
			isCheckGreen(checkItems(facts({ traefikFileProvider: 'missing' }), DYN, 'traefik')),
		).toBe(false)
		expect(
			isCheckGreen(
				checkItems(facts({ networks: { web: 'absent', internal: 'present' } }), DYN, 'traefik'),
			),
		).toBe(false)
	})
	it('network web is required on traefik servers only (the new-app flow creates it elsewhere); internal is optional everywhere', () => {
		const traefikNoWeb = checkItems(facts({ networks: { web: 'absent', internal: 'present' } }), DYN, 'traefik')
		// on a Traefik server web is its routing network here (nothing names another)
		expect(traefikNoWeb.find((i) => i.id === 'traefik-network')).toMatchObject({
			label: 'network web',
			state: 'missing',
			detail: NETWORK_WEB_MISSING,
		})
		expect(isCheckGreen(traefikNoWeb)).toBe(false)
		for (const proxy of ['nginx', 'nginx-container'] as const) {
			const nginxNoNets = checkItems(
				facts({ traefik: 'absent', traefikFileProvider: 'n/a', dynamicDir: 'absent', networks: { web: 'absent', internal: 'absent' } }),
				DYN,
				proxy,
			)
			expect(nginxNoNets.find((i) => i.id === 'network-web'), proxy).toMatchObject({ state: 'info', detail: NETWORK_WEB_ABSENT })
			expect(isCheckGreen(nginxNoNets), proxy).toBe(true)
			expect(missingPieces(nginxNoNets), proxy).toEqual([])
		}
		for (const proxy of ['traefik', 'nginx', 'nginx-container'] as const) {
			const noInternal = checkItems(facts({ networks: { web: 'present', internal: 'absent' } }), DYN, proxy)
			expect(noInternal.find((i) => i.id === 'network-internal'), proxy).toMatchObject({
				state: 'info',
				detail: NETWORK_INTERNAL_ABSENT,
			})
			expect(isCheckGreen(noInternal), proxy).toBe(true)
			expect(missingPieces(noInternal), proxy).toEqual([])
		}
		// the template really names web on every proxy, and internal only on opt-in
		for (const traefik of [true, false]) {
			const yml = renderComposeYaml({
				name: 'demo',
				dockerfilePath: 'Dockerfile',
				hostPort: traefik ? null : 3100,
				containerPort: 3000,
				envFilePath: '/opt/apps/demo.env',
				publicHost: traefik ? 'demo.apps.example.com' : null,
				traefik,
				postgres: null,
				kv: null,
			})
			expect(yml, String(traefik)).toMatch(/^networks:\n {2}web:\n {4}external: true\n/m)
			expect(yml, String(traefik)).not.toMatch(/^ {2}internal:/m)
		}
	})
	it('the dynamic dir is required on traefik servers, for domain redirects', () => {
		const items = checkItems(facts({ dynamicDir: 'absent' }), DYN, 'traefik')
		expect(items.find((i) => i.id === 'dynamic-dir')).toMatchObject({ state: 'missing', detail: DYNAMIC_DIR_MISSING })
		expect(missingPieces(items)).toEqual([{ id: 'dynamic-dir', label: DYN, detail: DYNAMIC_DIR_MISSING }])
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
	})
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
			networkCommand('"$TNET"'),
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
	// The script's req / treq / info lines and checkItems() are two renderings of one
	// rule set: run the real script (check mode, stub docker) and compare the state of
	// every proxy-dependent item with checkItems() on the same facts. The stub docker
	// answers from env: STUB_NETS (networks that exist: name, name:internal or
	// name:internal:project), STUB_TRAEFIK (running/absent), STUB_TATT (networks traefik
	// is attached to), STUB_TPROJ (its compose project) and STUB_ARGS (its command
	// line, as a JSON array body).
	function stubDocker(): string {
		const root = mkdtempSync(join(tmpdir(), 'bs-parity-'))
		const bin = join(root, 'bin')
		mkdirSync(bin)
		writeFileSync(join(bin, 'id'), '#!/bin/sh\necho "${STUB_UID:-1000}"\n', { mode: 0o755 })
		writeFileSync(
			join(bin, 'docker'),
			[
				'#!/bin/sh',
				'case "$1" in',
				'info) exit 0 ;;',
				'version) echo 29.0.0 ;;',
				'compose) exit 0 ;;',
				'network)',
				'  if [ "$2" = ls ]; then for n in $STUB_NETS; do case "$n" in *:*:*) echo "$n" ;; *:*) echo "$n:" ;; *) echo "$n:false:" ;; esac; done; exit 0; fi',
				'  for n in $STUB_NETS; do [ "${n%%:*}" = "$3" ] && exit 0; done; exit 1 ;;',
				'inspect)',
				'  [ "$STUB_TRAEFIK" = running ] || exit 1',
				'  case "$*" in',
				'  *NetworkSettings*) echo "$STUB_TATT " ;;',
				'  *compose.project*) echo "${STUB_TPROJ:-}" ;;',
				'  *-f*) echo true ;;',
				'  *) printf \'[\\n  {\\n    "Args": [%s],\\n    "Mounts": [{"Source": "%s", "Destination": "/etc/traefik/dynamic"}%s]\\n  }\\n]\\n\' "$STUB_ARGS" "$POWDER_TRAEFIK_DYNAMIC_DIR" "${STUB_MOUNTS:-}" ;;',
				'  esac ;;',
				'esac',
				'exit 0',
			].join('\n'),
			{ mode: 0o755 },
		)
		return root
	}
	const SCRIPT = join(__dirname, '../../../../../bin/server-bootstrap.sh')
	// One script run forks a few hundred times and does little else, so on a loaded
	// machine its wall time is mostly waiting to be scheduled. The parity cases below
	// run it without blocking the event loop (spawn, not spawnSync) as concurrent tests,
	// each case its own test with its own time limit, so the waits overlap.
	const bash = (args: string[], env: NodeJS.ProcessEnv) =>
		new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
			const p = spawn('bash', args, { env, stdio: ['ignore', 'pipe', 'ignore'] })
			let stdout = ''
			p.stdout.setEncoding('utf8').on('data', (d: string) => {
				stdout += d
			})
			p.on('error', reject)
			p.on('close', (status) => resolve({ status, stdout }))
		})
	// a stub shared by the whole describe: it only reads env, so concurrent cases can use it
	const STUB = stubDocker()
	const lineStates = (out: string, label: string) =>
		out
			.split('\n')
			.map((l) => /^ {2}(ok|missing|info|warn) +(.*)$/.exec(l))
			.filter((m): m is RegExpExecArray => !!m && m[2].startsWith(`${label} `))
			.map((m) => m[1])
	// What the dashboard computes from the same stub: the shared check body run under
	// it, parsed, the Traefik network resolved (traefikNetworkFrom), then checkItems().
	async function dashboardItems(env: NodeJS.ProcessEnv, proxy: BootstrapProxy, dyn: string, redirects: boolean) {
		const out = (await bash(['-c', renderCheckScript(shq(dyn))], env)).stdout
		const { facts: partial, inspectJson } = parseCheckOutput(out)
		let inspect: InspectJson | null = null
		try {
			inspect = (JSON.parse(inspectJson) as InspectJson[])[0] ?? null
		} catch {
			inspect = null
		}
		// the config file the dashboard reads (the same lookup, then cat)
		const cfgPath = inspect ? traefikConfigHostPath(inspect) : null
		const config = cfgPath && existsSync(cfgPath) ? { text: readFileSync(cfgPath, 'utf8'), path: cfgPath } : null
		const f: BootstrapFacts = {
			...partial,
			// the stub mounts the dir; the flag is in its args or not
			traefikFileProvider:
				partial.traefik === 'absent' ? 'n/a' : inspectJson.includes('providers.file.directory') ? 'ok' : 'missing',
			traefikNetwork: traefikNetworkFrom({
				traefik: partial.traefik !== 'absent',
				inspect,
				networks: partial.dockerNetworks ?? null,
				attached: partial.traefikAttached ?? null,
				project: partial.traefikProject ?? null,
				config,
			}),
		}
		return { f, items: checkItems(f, dyn, proxy, {}, redirects), plan: planApply(f, shq(dyn), proxy, {}, redirects) }
	}
	// The same facts built by hand (no second shell run), for the wide matrix.
	function handItems(o: Opts, dyn: string) {
		const names = o.nets.split(/\s+/).filter(Boolean)
		const running = o.traefik === 'running'
		const inspect: InspectJson | null = running ? (JSON.parse(`[{"Args": [${o.args}]}]`) as InspectJson[])[0] ?? null : null
		const dockerNetworks = names.map((n) => ({ name: n.split(':')[0] ?? n, internal: n.split(':')[1] === 'true' }))
		const attached = running ? o.tatt.split(/\s+/).filter(Boolean) : null
		const f = facts({
			networks: {
				web: dockerNetworks.some((n) => n.name === 'web') ? 'present' : 'absent',
				internal: dockerNetworks.some((n) => n.name === 'internal') ? 'present' : 'absent',
			},
			dockerNetworks,
			traefik: o.traefik,
			traefikAttached: attached,
			traefikFileProvider: running ? (o.args.includes('providers.file.directory') ? 'ok' : 'missing') : 'n/a',
			traefikNetwork: traefikNetworkFrom({ traefik: running, inspect, networks: dockerNetworks, attached }),
			dynamicDir: o.dir ? 'present' : 'absent',
		})
		return { f, items: checkItems(f, dyn, o.proxy, {}, o.redirects) }
	}
	type Opts = { proxy: BootstrapProxy; nets: string; traefik: 'running' | 'absent'; tatt: string; args: string; dir: boolean; redirects: boolean; tproj?: string; mounts?: string }
	// unsure: the script cannot read the mounted config with certainty, so its network
	// lines are informational and are not compared with the dashboard's
	// ex: the calling test's own expect (concurrent tests must not share the global one)
	async function compare(ex: ExpectStatic, where: string, o: Opts, byHand = false, uid = '1000', unsure = false) {
		// a fresh dynamic dir per case, so concurrent cases never see each other's
		const dyn = join(mkdtempSync(join(STUB, 'case-')), 'dynamic')
		if (o.dir) mkdirSync(dyn)
		const env = {
			...process.env,
			PATH: `${join(STUB, 'bin')}:${process.env.PATH}`,
			POWDER_TRAEFIK_DYNAMIC_DIR: dyn,
			STUB_NETS: o.nets,
			STUB_TRAEFIK: o.traefik,
			STUB_TATT: o.tatt,
			STUB_ARGS: o.args,
			STUB_TPROJ: o.tproj ?? '',
			STUB_MOUNTS: o.mounts ?? '',
			STUB_UID: uid,
		}
		const [r, dash] = await Promise.all([
			bash([SCRIPT, '--proxy', o.proxy, '--redirects', o.redirects ? 'yes' : 'no'], env),
			byHand ? null : dashboardItems(env, o.proxy, dyn, o.redirects),
		])
		const { f, items, plan } = dash ?? { ...handItems(o, dyn), plan: null }
		// every item the two renderings share, by label
		for (const i of items) {
			if (unsure && /^(network |traefik on |traefik networks)/.test(i.label)) continue
			if (!/^(network |traefik on |traefik container|traefik file provider|traefik networks)/.test(i.label) && i.label !== dyn) continue
			ex(lineStates(r.stdout, i.label), `${where}: ${i.label}`).toEqual([i.state])
		}
		// and no line the dashboard does not have
		for (const label of unsure ? ['network internal', 'traefik file provider', dyn] : ['network web', 'network internal', 'traefik file provider', 'traefik networks', dyn]) {
			const want = items.filter((i) => i.label === label).map((i) => i.state)
			ex(lineStates(r.stdout, label), `${where}: ${label}`).toEqual(want)
		}
		return { r, f, items, plan }
	}
	const POWDER_ARGS = '"--providers.docker.network=web", "--providers.file.directory=/etc/traefik/dynamic"'
	// The script marks each piece required, optional or n/a exactly as checkItems() does:
	// every combination of proxy, networks, traefik, dynamic dir and redirects.
	const matrix: Opts[] = []
	for (const proxy of ['traefik', 'nginx', 'nginx-container'] as const) {
		for (const nets of ['web internal', 'web', 'internal', '']) {
			for (const traefik of ['running', 'absent'] as const) {
				for (const dir of [true, false]) {
					// the redirects fact only changes anything on traefik servers
					for (const redirects of proxy === 'traefik' ? [true, false] : [true]) {
						matrix.push({ proxy, nets, traefik, tatt: 'web', args: POWDER_ARGS, dir, redirects })
					}
				}
			}
		}
	}
	const where = (o: Opts) => `${o.proxy} nets=[${o.nets}] traefik=${o.traefik} dir=${o.dir} redirects=${o.redirects}`
	it.concurrent.for(matrix.map((o) => [where(o), o] as const))(
		'the script marks each piece required, optional or n/a exactly as checkItems() does: %s',
		async ([name, o], { expect: ex }) => {
			await compare(ex, name, o, true)
		},
	)
	it('the matrix covers all 64 combinations, in the same words', () => {
		expect(matrix).toHaveLength(64)
		expect(new Set(matrix.map(where)).size).toBe(64)
		// and the same words
		expect(script).toContain(`req missing 'network web' '${NETWORK_WEB_MISSING}'`)
		expect(script).toContain(`line info 'network web' '${NETWORK_WEB_ABSENT}'`)
		expect(script).toContain(`line info 'network internal' '${NETWORK_INTERNAL_ABSENT}'`)
		expect(script).toContain(`'${DYNAMIC_DIR_MISSING}' '${DYNAMIC_DIR_UNUSED}'`)
		expect(script).toContain(`"${traefikNetworkMissing('$TNET')}"`)
		expect(script).toContain(`"${networkWebNotUsed('$TNET', true)}"`)
		expect(script).toContain(`"${networkWebNotUsed('$TNET', false)}"`)
		expect(script).toContain(`"${traefikNotAttached('$TNET')}"`)
		// with --redirects no the script cannot see a file provider set in a traefik.yml:
		// it never says "not configured", only "not found in its flags"
		expect(script).not.toContain(`"${fileProviderUnused('$DYN')}"`)
		expect(script).toContain('"not found in its flags: no file provider on $DYN in the traefik flags (a traefik.yml config is only checked by the dashboard)')
	})
	describe('both renderings resolve the same Traefik network; only a declared one is routed over', () => {
		// resolved: what traefikNetworkFrom reports; route: what powder uses (flag or config, else web)
		const cases: Array<{ name: string; nets: string; tatt: string; args: string; resolved: string; route: string; green: boolean; hint: boolean; tproj?: string }> = [
			// the flag names a network other than web; web does not exist
			{ name: 'flag', nets: 'edge internal', tatt: 'edge', args: '"--providers.docker.network=edge", "--providers.file.directory=/etc/traefik/dynamic"', resolved: 'edge', route: 'edge', green: true, hint: false },
			// the flag as two arguments
			{ name: 'flag, two args', nets: 'edge', tatt: 'edge', args: '\n      "--providers.docker.network",\n      "edge"\n    ', resolved: 'edge', route: 'edge', green: true, hint: false },
			// no flag, attached to one non-web network (and an internal one): reported, powder keeps web
			{ name: 'attached', nets: 'shared private:true', tatt: 'private shared', args: '"--providers.docker=true"', resolved: 'shared', route: 'web', green: false, hint: true },
			// attached to web and others: web
			{ name: 'several with web', nets: 'web zeta', tatt: 'zeta web', args: '"--providers.docker=true"', resolved: 'web', route: 'web', green: true, hint: false },
			// attached to several non-web: the first by name is reported, powder keeps web
			{ name: 'several', nets: 'zeta alpha web', tatt: 'zeta alpha', args: '"--providers.docker=true"', resolved: 'alpha', route: 'web', green: false, hint: true },
			// a network of another compose project (an app's own) is never picked
			{ name: 'other project', nets: 'appnet:false:shop proxynet:false:edge', tatt: 'appnet proxynet', args: '"--providers.docker=true"', resolved: 'proxynet', route: 'web', green: false, hint: true, tproj: 'edge' },
			{ name: 'only another project', nets: 'appnet:false:shop web', tatt: 'appnet web', args: '"--providers.docker=true"', resolved: 'web', route: 'web', green: true, hint: false },
			// the flag names a network traefik is not attached to: required, missing
			{ name: 'not attached', nets: 'edge other', tatt: 'other', args: '"--providers.docker.network=edge"', resolved: 'edge', route: 'edge', green: false, hint: false },
			// the flag names a network that does not exist
			{ name: 'network gone', nets: 'other', tatt: 'other', args: '"--providers.docker.network=edge"', resolved: 'edge', route: 'edge', green: false, hint: false },
		]
		it.concurrent.for(cases.map((c) => [c.name, c] as const))('%s', async ([, c], { expect }) => {
			const o = { proxy: 'traefik' as const, nets: c.nets, traefik: 'running' as const, tatt: c.tatt, args: c.args, dir: true, redirects: false, tproj: c.tproj }
			// the plan, as root: the same network steps, never web when Traefik routes over
			// another network, and the attach left to the operator
			const [{ r, f, items }, asRoot] = await Promise.all([compare(expect, c.name, o), compare(expect, `${c.name} (root)`, o, false, '0')])
			expect(f.traefikNetwork?.name, c.name).toBe(c.resolved)
			expect(items.find((i) => i.id === 'traefik-network')?.label, c.name).toBe(`network ${c.route}`)
			expect(r.stdout, c.name).toMatch(new RegExp(`^ {2}(ok|missing) +network ${c.route} `, 'm'))
			expect(items.some((i) => i.id === 'traefik-network-undeclared'), c.name).toBe(c.hint)
			const routing = items.filter((i) => ['traefik-network', 'traefik-attached', 'network-web'].includes(i.id))
			expect(routing.every((i) => i.state !== 'missing'), c.name).toBe(c.green)
			const tsSteps = (asRoot.plan?.steps ?? []).map((st) => st.id).filter((id) => id.startsWith('network-') || id === 'mkdir-dynamic')
			const shSteps = [...asRoot.r.stdout.matchAll(/^--- (network_\w+|mkdir_dynamic)$/gm)].map((m) => (m[1] ?? '').replaceAll('_', '-'))
			expect(shSteps, c.name).toEqual(tsSteps)
			if (c.route !== 'web') expect(tsSteps, c.name).not.toContain('network-web')
			const exists = c.nets.split(' ').some((n) => n.split(':')[0] === c.route)
			expect(tsSteps.includes(c.route === 'web' ? 'network-web' : 'network-traefik'), c.name).toBe(!exists)
			const attachSkipped = (asRoot.plan?.skipped ?? []).some((k) => k.id === 'traefik-network')
			expect(attachSkipped, c.name).toBe(!c.tatt.split(' ').includes(c.route))
			expect(asRoot.r.stdout.includes('not done automatically: traefik-network:'), c.name).toBe(attachSkipped)
		})
		// no traefik yet: web, what powder's own Traefik runs on
		it.concurrent('no traefik', async ({ expect }) => {
			const none = await compare(expect, 'no traefik', { proxy: 'traefik', nets: 'web', traefik: 'absent', tatt: '', args: '', dir: true, redirects: false })
			expect(none.f.traefikNetwork?.name).toBe('web')
			expect(none.f.traefikNetwork?.source).toBe('default')
		})
	})
	// A network declared only in a mounted config file: the script reads it when the
	// form leaves no doubt, else says the dashboard reads it and gives no network advice.
	it.concurrent('a network declared in a mounted traefik config: the script reads a plain form, else stays silent', async ({ expect }) => {
		const box = mkdtempSync(join(tmpdir(), 'bs-cfg-'))
		const mount = (file: string, dest = '/etc/traefik/traefik.yml') =>
			`,\n      {\n        "Type": "bind",\n        "Source": "${file}",\n        "Destination": "${dest}",\n        "Mode": "ro",\n        "RW": false\n      }`
		const write = (name: string, text: string) => {
			const f = join(box, name)
			writeFileSync(f, text)
			return f
		}
		const base = { proxy: 'traefik' as const, nets: 'infra backplane:true', traefik: 'running' as const, tatt: 'infra backplane', args: '"--providers.file.directory=/etc/traefik/dynamic"', dir: true, redirects: false }
		const ADVICE = /docker network connect|set providers\.docker\.network/
		const readable: Array<[string, string, string]> = [
			// block style, sibling keys before and after network, comments
			['block', 'traefik.yml', '# static\nentryPoints:\n  web:\n    address: ":80"\nproviders:\n  docker:\n    endpoint: "unix:///var/run/docker.sock"\n    exposedByDefault: false\n    network: infra # routing\n    watch: true\n  file:\n    directory: /etc/traefik/dynamic\n    watch: true\n'],
			// flow mapping for docker
			['flow', 'traefik.yml', 'providers:\n  docker: { endpoint: "unix:///var/run/docker.sock", exposedByDefault: false, network: "infra" }\n  file:\n    directory: /etc/traefik/dynamic\n'],
			// TOML
			['toml', 'traefik.toml', '[providers.docker]\n  exposedByDefault = false\n  network = "infra"\n\n[providers.file]\n  directory = "/etc/traefik/dynamic"\n'],
		]
		const readRuns = readable.map(async ([name, file, text]) => {
			const f = write(`${name}-${file}`, text)
			const { r, f: facts_, items } = await compare(expect, `config ${name}`, { ...base, mounts: mount(f, `/etc/traefik/${file}`) })
			expect(facts_.traefikNetwork, name).toMatchObject({ name: 'infra', source: 'config' })
			expect(items.filter((i) => i.state === 'missing').map((i) => i.id), name).not.toContain('traefik-network')
			expect(lineStates(r.stdout, 'network infra'), name).toEqual(['ok'])
			expect(lineStates(r.stdout, 'traefik on infra'), name).toEqual(['ok'])
			expect(r.stdout, name).toContain(`exists; Traefik routes over it (providers.docker.network in ${f})`)
			expect(r.stdout, name).not.toMatch(ADVICE)
		})
		// a form the script cannot read with certainty (anchors and a merge key): the
		// dashboard resolves it, the script gives the caveat and no network advice
		const unsure = [
			['merge', write('merge.yml', 'x-docker: &docker\n  network: infra\nproviders:\n  docker:\n    <<: *docker\n    exposedByDefault: false\n')],
			['missing file', join(box, 'gone.yml')],
		] as const
		const unsureRuns = unsure.map(async ([name, f]) => {
			const { r, f: facts_ } = await compare(expect, `config ${name}`, { ...base, mounts: mount(f) }, false, '0', true)
			if (name === 'merge') expect(facts_.traefikNetwork, name).toMatchObject({ name: 'infra', source: 'config' })
			expect(r.stdout, name).toContain(`a static config file is mounted (${f}) that only the dashboard reads fully`)
			expect(r.stdout, name).not.toMatch(ADVICE)
			expect(r.stdout, name).not.toMatch(/^ {2}missing +(network |traefik on )/m)
			expect(r.stdout, name).not.toMatch(/^--- network_(web|traefik)$/m)
		})
		// a mounted config without a docker network: the attached rule, as without one
		const plain = write('plain.yml', 'providers:\n  file:\n    directory: /etc/traefik/dynamic\n    watch: true\n')
		const [{ r, f: facts_ }] = await Promise.all([compare(expect, 'config without network', { ...base, mounts: mount(plain) }), ...readRuns, ...unsureRuns])
		expect(facts_.traefikNetwork).toMatchObject({ name: 'infra', source: 'attached' })
		expect(lineStates(r.stdout, 'network web')).toEqual(['missing'])
		expect(r.stdout).toContain('traefik is attached to infra; set providers.docker.network')
	}, 90_000)
	// "Handled elsewhere" counts only files cron and logrotate really load: the real
	// script and the dashboard (shared check body, parsed) under a sandboxed /etc.
	describe('only files the daemons load count as handled elsewhere: script and dashboard agree', () => {
		const LIVE = '17 * * * * root /usr/local/bin/powder-image-prune >> /var/log/powder-image-prune.log 2>&1\n'
		const STANZA = '/var/log/traefik/*.log {\n  weekly\n}\n'
		const cases: Array<{ name: string; files: Record<string, string>; cron: string; cronStep: boolean; lr: string; lrStep: boolean }> = [
			// a backup copy (a dotted name cron skips) next to the live file: no warning
			{ name: 'cron .bak copy next to the live file', files: { 'cron.d/powder-image-prune': LIVE, 'cron.d/powder-image-prune.bak-old': LIVE }, cron: 'ok', cronStep: false, lr: 'warn', lrStep: true },
			// only the backup copy: not handled, the install is planned
			{ name: 'only a cron .bak copy', files: { 'cron.d/powder-image-prune.bak-old': LIVE }, cron: 'warn', cronStep: true, lr: 'warn', lrStep: true },
			// a live line in /etc/crontab counts
			{ name: 'crontab line', files: { crontab: LIVE }, cron: 'ok', cronStep: false, lr: 'warn', lrStep: true },
			// a .dpkg-old logrotate file only (a taboo extension logrotate skips): not handled
			{ name: 'only a .dpkg-old logrotate file', files: { 'logrotate.d/traefik.dpkg-old': STANZA }, cron: 'warn', cronStep: true, lr: 'warn', lrStep: true },
			// a commented-out stanza: not handled
			{ name: 'commented-out stanza', files: { 'logrotate.d/traefik': STANZA.split('\n').map((l) => (l ? `# ${l}` : l)).join('\n') }, cron: 'warn', cronStep: true, lr: 'warn', lrStep: true },
			// a live stanza: handled, no second file
			{ name: 'live stanza', files: { 'logrotate.d/traefik': STANZA }, cron: 'warn', cronStep: true, lr: 'ok', lrStep: false },
			// logrotate loads a .bak file (not a taboo extension): it counts
			{ name: 'logrotate .bak', files: { 'logrotate.d/traefik.bak': STANZA }, cron: 'warn', cronStep: true, lr: 'ok', lrStep: false },
			// and a hidden file (it skips only . and ..)
			{ name: 'logrotate dotfile', files: { 'logrotate.d/.traefik': STANZA }, cron: 'warn', cronStep: true, lr: 'ok', lrStep: false },
			// .dpkg-tmp is in logrotate's built-in taboo table
			{ name: 'logrotate .dpkg-tmp', files: { 'logrotate.d/traefik.dpkg-tmp': STANZA }, cron: 'warn', cronStep: true, lr: 'warn', lrStep: true },
		]
		it.concurrent.for(cases.map((c) => [c.name, c] as const))('%s', async ([, c], { expect }) => {
			const box = mkdtempSync(join(tmpdir(), 'bs-etc-'))
			const etc = join(box, 'etc')
			const ubin = join(box, 'usrbin')
			for (const d of ['cron.d', 'logrotate.d']) mkdirSync(join(etc, d), { recursive: true })
			mkdirSync(ubin)
			for (const h of ['powder-migrate', 'powder-image-prune']) writeFileSync(join(ubin, h), '#!/bin/sh\n', { mode: 0o755 })
			const sandbox = (t: string) => t.replaceAll('/etc/', `${etc}/`).replaceAll('/usr/local/bin/', `${ubin}/`)
			for (const [f, text] of Object.entries(c.files)) writeFileSync(join(etc, f), sandbox(text))
			mkdirSync(join(box, 'bin'))
			const sh = join(box, 'bin/server-bootstrap.sh')
			writeFileSync(sh, sandbox(script), { mode: 0o755 })
			const env = { ...process.env, PATH: `${join(STUB, 'bin')}:${process.env.PATH}`, STUB_UID: '0', STUB_TRAEFIK: 'absent', STUB_NETS: 'web internal', POWDER_TRAEFIK_DYNAMIC_DIR: join(box, 'dyn') }
			const [r, { stdout: out }] = await Promise.all([
				bash([sh, '--proxy', 'traefik', '--redirects', 'no'], env),
				bash(['-c', sandbox(renderCheckScript(shq(join(box, 'dyn'))))], env),
			])
			const f: BootstrapFacts = { ...parseCheckOutput(out).facts, traefikFileProvider: 'n/a' }
			const items = checkItems(f, join(box, 'dyn'), 'traefik', {}, false)
			const plan = planApply(f, shq(join(box, 'dyn')), 'traefik', {}, false).steps.map((st) => st.id)
			expect(items.find((i) => i.id === 'image-prune-cron')?.state, c.name).toBe(c.cron)
			expect(lineStates(r.stdout, 'image prune cron'), c.name).toEqual([c.cron])
			expect(items.find((i) => i.id === 'traefik-logrotate')?.state, c.name).toBe(c.lr)
			expect(lineStates(r.stdout, 'traefik log rotation'), c.name).toEqual([c.lr])
			expect(plan.includes('install-image-prune-cron'), c.name).toBe(c.cronStep)
			expect(/^--- install_image_prune_cron$/m.test(r.stdout), c.name).toBe(c.cronStep)
			expect(plan.includes('install-traefik-logrotate'), c.name).toBe(c.lrStep)
			expect(/^--- install_traefik_logrotate$/m.test(r.stdout), c.name).toBe(c.lrStep)
		})
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
		expect(script).toContain('[ "$PROXY" = traefik ] && [ "$REDIRECTS" = yes ] && STEPS+=(mkdir_dynamic)')
		expect(script).toMatch(/^REDIRECTS=yes$/m)
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
				.replaceAll('/etc/crontab', join(dir, 'crontab'))
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

describe('a helper the operator already has elsewhere is never added twice', () => {
	const tmpEtc = () => {
		const etc = join(mkdtempSync(join(tmpdir(), 'dup-')), 'etc')
		mkdirSync(join(etc, 'logrotate.d'), { recursive: true })
		mkdirSync(join(etc, 'cron.d'), { recursive: true })
		return etc
	}
	const sub = (etc: string, c: string) => c.replaceAll('/etc/', `${etc}/`).replace('chown root:root "$C" && ', '')
	const checkLine = (key: string) => renderCheckScript(W).split('\n').find((l) => l.includes(`echo "${key}=`)) ?? ''
	it('logrotate: another file naming /var/log/traefik is found by the path, not the file name', () => {
		const etc = tmpEtc()
		const run = () => spawnSync('bash', ['-c', sub(etc, checkLine('traefik_logrotate_other'))], { encoding: 'utf8' }).stdout.trim()
		expect(run()).toBe('traefik_logrotate_other=')
		writeFileSync(join(etc, 'logrotate.d/proxy'), '# rotates /var/log/traefik/access.log\n')
		expect(run()).toBe('traefik_logrotate_other=')
		writeFileSync(join(etc, 'logrotate.d/proxy'), '/var/log/traefik/access.log {\n  weekly\n}\n')
		expect(run()).toBe('traefik_logrotate_other=proxy')
		// powder's own file is not "another" one
		spawnSync('rm', [join(etc, 'logrotate.d/proxy')])
		writeFileSync(join(etc, 'logrotate.d/powder-traefik'), `${TRAEFIK_LOGROTATE_LINES.join('\n')}\n`)
		expect(run()).toBe('traefik_logrotate_other=')
	})
	it('logrotate: handled elsewhere is ok and planned nowhere; both files is a warning; the step re-checks', () => {
		const f = (traefikLogrotate: BootstrapFacts['traefikLogrotate'], other: string | null) =>
			facts({ traefikLogrotate, traefikLogrotateOther: other })
		const item = (x: BootstrapFacts) => checkItems(x, DYN, 'traefik').find((i) => i.id === 'traefik-logrotate')
		expect(item(f('absent', 'proxy'))).toMatchObject({ state: 'ok' })
		expect(item(f('absent', 'proxy'))?.detail).toContain('/etc/logrotate.d/proxy already rotates /var/log/traefik')
		expect(planApply(f('absent', 'proxy'), W, 'traefik').steps.map((s) => s.id)).not.toContain('install-traefik-logrotate')
		expect(item(f('current', 'proxy'))).toMatchObject({ state: 'warn' })
		expect(item(f('current', 'proxy'))?.detail).toContain('duplicate entry')
		expect(parseCheckOutput('traefik_logrotate_other=proxy\n').facts.traefikLogrotateOther).toBe('proxy')
		expect(parseCheckOutput('traefik_logrotate_other=\n').facts.traefikLogrotateOther).toBeNull()
		expect(parseCheckOutput('traefik_logrotate_other=../x\n').facts.traefikLogrotateOther).toBeNull()
		// the step itself: another file appeared since the check, so nothing is written
		const etc = tmpEtc()
		writeFileSync(join(etc, 'logrotate.d/proxy'), '/var/log/traefik/*.log {\n  daily\n}\n')
		const r = spawnSync('bash', ['-c', sub(etc, installTraefikLogrotateCommand())], { encoding: 'utf8' })
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('already rotates /var/log/traefik')
		expect(existsSync(join(etc, 'logrotate.d/powder-traefik'))).toBe(false)
	})
	it('image prune cron: a line in /etc/crontab or another cron.d file counts as handled', () => {
		const etc = tmpEtc()
		const run = () => spawnSync('bash', ['-c', sub(etc, checkLine('prune_cron_other'))], { encoding: 'utf8' }).stdout.trim()
		expect(run()).toBe('prune_cron_other=')
		writeFileSync(join(etc, 'crontab'), '# 17 * * * * root /usr/local/bin/powder-image-prune\n')
		expect(run()).toBe('prune_cron_other=')
		writeFileSync(join(etc, 'cron.d/maintenance'), '5 * * * * root /usr/local/bin/powder-image-prune\n')
		expect(run()).toBe('prune_cron_other=cron.d/maintenance')
		const f = (pruneCron: BootstrapFacts['pruneCron']) =>
			facts({
				helpers: { migrate: 'present', imagePrune: 'present', resourceGuard: 'absent' },
				pruneCron,
				pruneCronOther: 'cron.d/maintenance',
			})
		const item = (x: BootstrapFacts) => checkItems(x, DYN, 'traefik').find((i) => i.id === 'image-prune-cron')
		expect(item(f('absent'))).toMatchObject({ state: 'ok' })
		expect(planApply(f('absent'), W, 'traefik').steps.map((s) => s.id)).not.toContain('install-image-prune-cron')
		expect(planApply(f('no-crond'), W, 'traefik').skipped.map((s) => s.id)).not.toContain('image-prune-cron')
		expect(item(f('current'))).toMatchObject({ state: 'warn' })
		// the step re-checks: no second line
		const bin = mkdtempSync(join(tmpdir(), 'dupbin-'))
		writeFileSync(join(bin, 'powder-image-prune'), '#!/bin/sh\n', { mode: 0o755 })
		const cmd = sub(etc, installPruneCronCommand()).replaceAll("'/usr/local/bin/powder-image-prune'", `'${bin}/powder-image-prune'`)
		const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('already runs powder-image-prune')
		expect(existsSync(join(etc, 'cron.d/powder-image-prune'))).toBe(false)
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
