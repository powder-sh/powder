// The one authority for "which Docker network does this server's Traefik route over"
// (traefik-network.ts), and everything that follows it: the server check, the setup
// checklist, the new-app template, previews, the compose guard. Invented server,
// network and app names; no real docker and no network (ssh and the db are mocked).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	check: '',
	files: {} as Record<string, string>,
	commands: [] as string[],
	redirects: false,
	saved: [] as Array<[string, string, string]>,
}))

vi.mock('../domain-ownership', () => ({}))
vi.mock('../server-helpers', () => ({ shippedHelperShas: () => ({}), shippedHelper: () => null }))
vi.mock('../servers', () => ({
	saveServerCheck: async () => {},
	saveTraefikNetwork: async (id: string, net: string, source: string) => {
		state.saved.push([id, net, source])
	},
	serverRedirectsInUse: async () => state.redirects,
}))
vi.mock('../ssh', () => ({
	writeFileViaSftp: async () => {},
	runCommand: async (_server: unknown, command: string) => {
		state.commands.push(command)
		const cat = /^cat '([^']+)'$/.exec(command)
		if (cat) {
			const text = state.files[cat[1] ?? '']
			return text === undefined ? { code: 1, stdout: '', stderr: 'No such file' } : { code: 0, stdout: text, stderr: '' }
		}
		return { code: 0, stdout: state.check, stderr: '' }
	},
}))

import { checkComposeSafe } from '../compose-guard'
import { renderComposeYaml } from '../compose-render'
import { renderPreviewCompose } from '../preview-deploys'
import { INSPECT_MARKER, checkItems, isCheckGreen, missingPieces, planApply } from '../server-bootstrap'
import { runBootstrapCheck } from '../server-bootstrap-run'
import { type ChecklistServer, buildChecklist } from '../setup-checklist'
import {
	type InspectJson,
	cacheTraefikNetwork,
	dockerNetworkFromConfig,
	isDockerNetworkName,
	knownTraefikNetwork,
	pickAttachedNetwork,
	redirectRowInUse,
	routingNetwork,
	traefikConfigHostPath,
	traefikNetworkFrom,
} from '../traefik-network'
import { TRAEFIK_NETWORK_PROBE, resolveTraefikNetwork } from '../traefik-network-run'

const DYN = '/opt/infra/traefik/dynamic'

beforeEach(() => {
	state.commands = []
	state.saved = []
	state.files = {}
	state.redirects = false
	;(globalThis as { __powderTraefikNetworkCache?: Map<string, unknown> }).__powderTraefikNetworkCache?.clear()
	;(globalThis as { __powderBootstrapCache?: Map<string, unknown> }).__powderBootstrapCache?.clear()
})

const nets = (...names: string[]) => Object.fromEntries(names.map((n) => [n, {}]))

describe('traefikNetworkFrom: the resolution order', () => {
	it('the --providers.docker.network flag, = form or two arguments, Entrypoint, Cmd or Args', () => {
		for (const inspect of [
			{ Args: ['--providers.docker.network=edge'] },
			{ Args: ['--providers.docker.network', 'edge'] },
			{ Config: { Entrypoint: ['traefik', '--providers.docker.network=edge'] } },
			{ Config: { Cmd: ['-providers.docker.network=edge'] } },
		] satisfies InspectJson[]) {
			const r = traefikNetworkFrom({ traefik: true, inspect: { ...inspect, NetworkSettings: { Networks: nets('edge', 'web') } } })
			expect(r, JSON.stringify(inspect)).toMatchObject({ name: 'edge', source: 'flag', attached: ['edge', 'web'] })
		}
	})
	it('the flag wins over the config file; an invalid flag value is passed over', () => {
		const config = { text: 'providers:\n  docker:\n    network: infra\n', path: '/srv/proxy/traefik.yml' }
		expect(traefikNetworkFrom({ traefik: true, inspect: { Args: ['--providers.docker.network=edge'] }, config }).name).toBe('edge')
		expect(
			traefikNetworkFrom({ traefik: true, inspect: { Args: ['--providers.docker.network=$(touch x)'] }, config }),
		).toMatchObject({ name: 'infra', source: 'config' })
	})
	it('providers.docker.network in a mounted traefik.yml, .yaml or .toml', () => {
		const yml = 'entryPoints:\n  web:\n    address: ":80"\nproviders:\n  docker:\n    network: infra\n    exposedByDefault: false\n  file:\n    directory: /etc/traefik/dynamic\n    watch: true\n'
		expect(dockerNetworkFromConfig(yml, '/srv/proxy/traefik.yml')).toBe('infra')
		expect(dockerNetworkFromConfig(yml, '/srv/proxy/traefik.yaml')).toBe('infra')
		const toml = '# static\n[entryPoints.web]\n  address = ":80"\n\n[providers.docker]\n  exposedByDefault = false\n  network = "infra" # routing\n'
		expect(dockerNetworkFromConfig(toml, '/srv/proxy/traefik.toml')).toBe('infra')
		expect(dockerNetworkFromConfig('[providers.file]\n  network = "nope"\n', '/x/traefik.toml')).toBeNull()
		expect(dockerNetworkFromConfig('providers:\n  docker: {}\n', '/x/traefik.yml')).toBeNull()
		expect(dockerNetworkFromConfig(': not yaml : [', '/x/traefik.yml')).toBeNull()
		const r = traefikNetworkFrom({
			traefik: true,
			inspect: { NetworkSettings: { Networks: nets('infra', 'backplane') } },
			config: { text: yml, path: '/srv/proxy/traefik.yml' },
		})
		expect(r).toMatchObject({ name: 'infra', source: 'config' })
		expect(r.why).toContain('/srv/proxy/traefik.yml')
	})
	it('the config file is found the way the file provider check finds it', () => {
		const m = (Source: string, Destination: string) => ({ Source, Destination })
		expect(traefikConfigHostPath({ Mounts: [m('/srv/proxy/traefik.yml', '/etc/traefik/traefik.yml')] })).toBe('/srv/proxy/traefik.yml')
		expect(traefikConfigHostPath({ Mounts: [m('/srv/proxy/traefik.toml', '/etc/traefik/traefik.toml')] })).toBe('/srv/proxy/traefik.toml')
		expect(traefikConfigHostPath({ Mounts: [m('/srv/proxy/conf', '/etc/traefik')] })).toBe('/srv/proxy/conf/traefik.yml')
		expect(
			traefikConfigHostPath({ Args: ['--configFile=/config/static.yml'], Mounts: [m('/srv/proxy', '/config')] }),
		).toBe('/srv/proxy/static.yml')
		expect(traefikConfigHostPath({ Mounts: [m('/var/run/docker.sock', '/var/run/docker.sock')] })).toBeNull()
	})
	it('unset: the network traefik is attached to; several: web if there, else the first by name that is not internal', () => {
		expect(traefikNetworkFrom({ traefik: true, inspect: { NetworkSettings: { Networks: nets('infra') } } })).toMatchObject({
			name: 'infra',
			source: 'attached',
		})
		expect(pickAttachedNetwork(['zeta', 'web', 'alpha'], null)).toBe('web')
		expect(pickAttachedNetwork(['zeta', 'alpha'], null)).toBe('alpha')
		// an internal network (no way out) and Docker's built-ins are passed over
		expect(pickAttachedNetwork(['alpha', 'zeta'], [{ name: 'alpha', internal: true }])).toBe('zeta')
		expect(pickAttachedNetwork(['bridge', 'zeta'], null)).toBe('zeta')
		expect(pickAttachedNetwork(['bridge', 'host'], null)).toBeNull()
		const several = traefikNetworkFrom({
			traefik: true,
			inspect: { NetworkSettings: { Networks: nets('zeta', 'alpha') } },
			networks: [
				{ name: 'zeta', internal: false },
				{ name: 'alpha', internal: false },
			],
		})
		expect(several.name).toBe('alpha')
		expect(several.why).toContain('powder does not route over until it is declared')
		// a network of another compose project than Traefik's own is never picked
		const projects = [
			{ name: 'appnet', internal: false, project: 'shop' },
			{ name: 'proxynet', internal: false, project: 'edge' },
		]
		expect(pickAttachedNetwork(['appnet', 'proxynet'], projects, 'edge')).toBe('proxynet')
		expect(pickAttachedNetwork(['appnet'], projects, 'edge')).toBeNull()
		expect(pickAttachedNetwork(['appnet', 'proxynet'], projects, null)).toBeNull()
		expect(
			traefikNetworkFrom({
				traefik: true,
				inspect: { Config: { Labels: { 'com.docker.compose.project': 'edge' } }, NetworkSettings: { Networks: nets('appnet', 'proxynet') } },
				networks: projects,
			}).name,
		).toBe('proxynet')
		// but a flag or config naming it wins: the operator declared it
		expect(
			traefikNetworkFrom({ traefik: true, inspect: { Args: ['--providers.docker.network=appnet'], NetworkSettings: { Networks: nets('appnet') } }, networks: projects }),
		).toMatchObject({ name: 'appnet', source: 'flag' })
	})
	it('no traefik yet, or nothing names a network: web', () => {
		expect(traefikNetworkFrom({ traefik: false, inspect: null })).toMatchObject({ name: 'web', source: 'default' })
		expect(traefikNetworkFrom({ traefik: true, inspect: {} })).toMatchObject({ name: 'web', source: 'default' })
		expect(traefikNetworkFrom({ traefik: true, inspect: { NetworkSettings: { Networks: nets('bridge') } } }).name).toBe('web')
	})
	it('only valid Docker network names come out', () => {
		for (const bad of ['', '-x', 'a b', 'a;b', '$(x)', 'x'.repeat(129), 'a/b']) expect(isDockerNetworkName(bad), bad).toBe(false)
		for (const good of ['web', 'infra', 'proxy_default', 'a.b-c', '0net']) expect(isDockerNetworkName(good), good).toBe(true)
	})
})

describe('redirectRowInUse: when the file provider is needed', () => {
	it('a www mode other than none, or a non-empty custom list', () => {
		expect(redirectRowInUse({ wwwMode: 'none', customRedirectsJson: '[]' })).toBe(false)
		expect(redirectRowInUse({ wwwMode: 'none', customRedirectsJson: '' })).toBe(false)
		expect(redirectRowInUse({ wwwMode: 'apex', customRedirectsJson: '[]' })).toBe(true)
		expect(redirectRowInUse({ wwwMode: 'www', customRedirectsJson: '[]' })).toBe(true)
		expect(redirectRowInUse({ wwwMode: 'none', customRedirectsJson: '[{"from":"/a","to":"/b","status":301}]' })).toBe(true)
		// unreadable: the cautious side
		expect(redirectRowInUse({ wwwMode: 'none', customRedirectsJson: '{oops' })).toBe(true)
	})
})

// The two server shapes the rule was written for, as the check output reports them.
const KV_COMMON = [
	'uid=0',
	'os=ubuntu',
	'docker=present',
	'docker_version=29.0.0',
	'compose=present',
	'apps_dir=present',
	'ufw=inactive',
	'port_80=busy',
	'port_443=busy',
	'nginx=absent',
	'nginx_bin=absent',
	'nginx_unit=absent',
	'port_bindings=bound',
	'proxy_containers=present',
	'disk_free_kb=104857600',
	'mem_total_kb=8388608',
	'mem_avail_kb=4194304',
	'cmd_git=present',
	'cmd_flock=present',
	'prune_cron=absent',
	'prune_cron_other=',
	'traefik=running',
]
// A hand-run Traefik configured by a mounted traefik.yml (docker network infra, file
// provider on the dynamic dir), attached to infra and an internal network; no web.
const SERVER_A = {
	check: [
		...KV_COMMON,
		'net_web=absent',
		'net_internal=absent',
		'docker_networks=bridge:false host:false none:false infra:false backplane:true ',
		'traefik_networks=backplane infra ',
		'dynamic_dir=present',
		'traefik_logrotate=current',
		'traefik_logrotate_other=',
		INSPECT_MARKER,
		JSON.stringify([
			{
				Args: [],
				Config: { Entrypoint: ['/entrypoint.sh'], Cmd: ['traefik'] },
				Mounts: [
					{ Source: '/srv/proxy/traefik.yml', Destination: '/etc/traefik/traefik.yml' },
					{ Source: DYN, Destination: '/etc/traefik/dynamic' },
				],
				NetworkSettings: { Networks: nets('backplane', 'infra') },
			},
		]),
	].join('\n'),
	files: {
		'/srv/proxy/traefik.yml':
			'providers:\n  docker:\n    network: infra\n    exposedByDefault: false\n  file:\n    directory: /etc/traefik/dynamic\n    watch: true\n',
	},
}
// A hand-run Traefik configured by flags on web, docker provider only: no file
// provider, no dynamic dir, and its log rotated by another logrotate file.
const SERVER_B = {
	check: [
		...KV_COMMON,
		'net_web=present',
		'net_internal=absent',
		'docker_networks=bridge:false web:false ',
		'traefik_networks=web ',
		'dynamic_dir=absent',
		'traefik_logrotate=absent',
		'traefik_logrotate_other=traefik',
		INSPECT_MARKER,
		JSON.stringify([
			{
				Args: ['--providers.docker=true', '--providers.docker.network=web', '--entrypoints.websecure.address=:443'],
				Config: { Cmd: ['--providers.docker=true', '--providers.docker.network=web', '--entrypoints.websecure.address=:443'] },
				Mounts: [{ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }],
				NetworkSettings: { Networks: nets('web') },
			},
		]),
	].join('\n'),
	files: {},
}
const srv = (id: string) => ({ id, name: id, host: 'h', user: 'root', port: 22, kind: 'compose' as const, proxy: 'traefik' as const })
const checklistServer = (id: string, r: Awaited<ReturnType<typeof runBootstrapCheck>>): ChecklistServer => ({
	id,
	name: id,
	status: 'connected',
	proxy: 'traefik',
	baseDomain: 'apps.example.com',
	checkGreen: r.green,
	checkMissing: missingPieces(r.items),
	dnsState: 'ok',
	needsDefaultHost: false,
})
const serverRow = (servers: ChecklistServer[]) =>
	buildChecklist({ githubOAuth: true, backups: true, deployFailureRoutes: ['ops-endpoint'], adminPersisted: true, servers }).find(
		(i) => i.id === 'server',
	)

describe('the server check on a real Traefik setup (dashboard path, ssh mocked)', () => {
	it('Traefik on infra via traefik.yml, no web network: green, web is an info line, nothing to create', async () => {
		state.check = SERVER_A.check
		state.files = SERVER_A.files
		const r = await runBootstrapCheck(srv('srv-a'), { fresh: true })
		expect(r.facts.traefikNetwork).toMatchObject({ name: 'infra', source: 'config' })
		const item = (id: string) => r.items.find((i) => i.id === id)
		expect(item('traefik-network')).toMatchObject({ label: 'network infra', state: 'ok' })
		expect(item('network-web')).toMatchObject({ state: 'info' })
		expect(item('network-web')?.detail).toContain('Traefik here routes over infra')
		expect(item('traefik-attached')).toMatchObject({ label: 'traefik on infra', state: 'ok' })
		expect(item('traefik-file-provider')?.state).toBe('ok')
		expect(r.green).toBe(true)
		expect(r.plan.steps.map((s) => s.id).filter((id) => id.startsWith('network-'))).toEqual(['network-internal'])
		// the config file was read once, for both the file provider and the network
		expect(state.commands.filter((c) => c.startsWith('cat ')).length).toBe(1)
		// remembered: the compose guard of the next deploy knows it without ssh
		expect(state.saved).toEqual([['srv-a', 'infra', 'config']])
		expect(knownTraefikNetwork({ id: 'srv-a', proxy: 'traefik', traefikNetwork: null })).toBe('infra')
		// its real shape: attached to infra and an internal private network, config mounted read-only
		expect(r.items.some((i) => i.id === 'traefik-network-undeclared')).toBe(false)
	})
	it('Traefik on web via flags, no file provider, no redirect set up: green; with a redirect: both required', async () => {
		state.check = SERVER_B.check
		state.redirects = false
		const r = await runBootstrapCheck(srv('srv-b'), { fresh: true })
		expect(r.facts.traefikNetwork).toMatchObject({ name: 'web', source: 'flag' })
		const item = (id: string) => r.items.find((i) => i.id === id)
		expect(item('traefik-network')).toMatchObject({ label: 'network web', state: 'ok' })
		expect(r.items.filter((i) => i.label === 'network web')).toHaveLength(1)
		expect(item('traefik-file-provider')).toMatchObject({ state: 'info' })
		expect(item('traefik-file-provider')?.detail).toContain('domain redirects are unavailable on this server')
		expect(item('dynamic-dir')).toMatchObject({ state: 'info' })
		// rotated by the operator's own file: handled, no second file planned
		expect(item('traefik-logrotate')).toMatchObject({ state: 'ok' })
		expect(item('traefik-logrotate')?.detail).toContain('/etc/logrotate.d/traefik')
		expect(r.green).toBe(true)
		expect(r.plan.steps.map((s) => s.id)).not.toContain('mkdir-dynamic')
		expect(r.plan.steps.map((s) => s.id)).not.toContain('install-traefik-logrotate')
		// no flagless config to read
		expect(state.commands.some((c) => c.startsWith('cat '))).toBe(false)

		state.redirects = true
		const withRedirect = await runBootstrapCheck(srv('srv-b'), { fresh: true })
		expect(withRedirect.green).toBe(false)
		expect(missingPieces(withRedirect.items).map((m) => m.id)).toEqual(['traefik-file-provider', 'dynamic-dir'])
		expect(withRedirect.plan.steps.map((s) => s.id)).toContain('mkdir-dynamic')
	})
	it('the setup checklist reads done with both servers', async () => {
		state.check = SERVER_A.check
		state.files = SERVER_A.files
		const a = await runBootstrapCheck(srv('srv-a'), { fresh: true })
		state.check = SERVER_B.check
		state.files = {}
		const b = await runBootstrapCheck(srv('srv-b'), { fresh: true })
		expect(serverRow([checklistServer('srv-a', a), checklistServer('srv-b', b)])?.state).toBe('done')
	})
	it('a Traefik not attached to the network it routes over is a missing piece the plan leaves to the operator', async () => {
		state.check = SERVER_A.check.replace('traefik_networks=backplane infra ', 'traefik_networks=backplane ').replace(
			JSON.stringify(nets('backplane', 'infra')),
			JSON.stringify(nets('backplane')),
		)
		state.files = SERVER_A.files
		const r = await runBootstrapCheck(srv('srv-c'), { fresh: true })
		expect(missingPieces(r.items).map((m) => m.id)).toEqual(['traefik-attached'])
		expect(r.plan.skipped.find((s) => s.id === 'traefik-network')?.reason).toContain('docker network connect infra traefik')
		expect(serverRow([checklistServer('srv-c', r)])?.detail).toContain('traefik on infra missing on srv-c')
	})
})

describe('resolveTraefikNetwork: cached, read from the container, never on other servers', () => {
	const probe = (inspect: InspectJson | null, list: string) =>
		`${inspect ? JSON.stringify([inspect]) : '[]\n[]'}\n===POWDER_DOCKER_NETWORKS===\n${list}`
	it('not a Traefik server: web, no ssh', async () => {
		const r = await resolveTraefikNetwork({ ...srv('srv-n'), proxy: 'nginx' })
		expect(r.name).toBe('web')
		expect(state.commands).toEqual([])
	})
	it('reads the container once, then serves the cache; the config file only without a flag', async () => {
		state.check = probe({ Args: ['--providers.docker.network=edge'], NetworkSettings: { Networks: nets('edge') } }, 'edge:false')
		expect((await resolveTraefikNetwork(srv('srv-f'))).name).toBe('edge')
		expect((await resolveTraefikNetwork(srv('srv-f'))).name).toBe('edge')
		expect(state.commands).toEqual([TRAEFIK_NETWORK_PROBE])
		expect(state.saved).toEqual([['srv-f', 'edge', 'flag']])

		state.commands = []
		state.check = probe(
			{ Mounts: [{ Source: '/srv/proxy/traefik.yml', Destination: '/etc/traefik/traefik.yml' }], NetworkSettings: { Networks: nets('infra') } },
			'infra:false',
		)
		state.files = SERVER_A.files
		expect((await resolveTraefikNetwork(srv('srv-y'))).name).toBe('infra')
		expect(state.commands).toEqual([TRAEFIK_NETWORK_PROBE, "cat '/srv/proxy/traefik.yml'"])
	})
	it('no traefik container: web; an unreadable answer: the stored one, else web', async () => {
		state.check = probe(null, 'web:false')
		expect((await resolveTraefikNetwork(srv('srv-0'))).name).toBe('web')
		state.check = 'garbage'
		const failed = await resolveTraefikNetwork({ ...srv('srv-x'), traefikNetwork: 'infra', traefikNetworkSource: 'config' })
		expect(failed).toMatchObject({ name: 'infra', source: 'config' })
		expect((await resolveTraefikNetwork({ ...srv('srv-z'), traefikNetwork: 'infra' })).name).toBe('web')
	})
	it('knownTraefikNetwork (the deploy guard, no ssh): cache, else the stored value, else web', () => {
		const k = (traefikNetwork: string, traefikNetworkSource: string | null, proxy = 'traefik') =>
			knownTraefikNetwork({ id: 'srv-k', proxy, traefikNetwork, traefikNetworkSource })
		expect(k('infra', 'config')).toBe('infra')
		expect(k('infra', 'flag')).toBe('infra')
		// attachment alone never widens the guard
		expect(k('infra', 'attached')).toBe('web')
		expect(k('infra', null)).toBe('web')
		expect(k('bad name', 'flag')).toBe('web')
		expect(k('infra', 'config', 'nginx')).toBe('web')
		cacheTraefikNetwork('srv-k', { name: 'edge', source: 'flag', attached: ['edge'], why: '' })
		expect(k('infra', 'config')).toBe('edge')
		cacheTraefikNetwork('srv-k', { name: 'edge', source: 'attached', attached: ['edge'], why: '' })
		expect(k('infra', 'config')).toBe('web')
	})
})

// Pinned from the renderers before the Traefik network existed: on a `web` server the
// rendered composes must stay byte-identical.
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const APP = { name: 'demo', dockerfilePath: 'Dockerfile', containerPort: 3000, envFilePath: '/opt/apps/demo.env' }
const COMBOS = {
	traefikHost: {
		hostPort: null,
		publicHost: 'demo.apps.example.com',
		traefik: true,
		tlsMode: 'acme' as const,
		postgres: { password: 'pw', dataDir: '/opt/apps/demo/pgdata' },
		kv: { dataDir: '/opt/apps/demo/kvdata' },
		sharedInternal: true,
	},
	traefikNoHost: { hostPort: null, publicHost: null, traefik: true, postgres: null, kv: null },
	traefikOrigin: {
		hostPort: null,
		publicHost: 'demo.apps.example.com',
		traefik: true,
		tlsMode: 'origin-cert' as const,
		postgres: null,
		kv: null,
		healthUrl: 'https://demo.apps.example.com/healthz',
	},
	nginx: { hostPort: 3100, publicHost: null, traefik: false, postgres: { password: 'pw', dataDir: '/opt/apps/demo/pgdata' }, kv: null },
	nginxInternal: { hostPort: 3101, publicHost: null, traefik: false, postgres: null, kv: null, sharedInternal: true },
}
const PINNED: Record<string, string> = {
	traefikHost: '17b6f54613e7c65fc8fdfbc75c6bfd13f6fbe7433dade897a5352e896043b42c',
	traefikNoHost: '250103dbcb98272416273c7557beecf4088950825868e7749c489d2c290da325',
	traefikOrigin: '507ad749e1706afe19268e7c78d726fdeb29cf4ad7761a34bbc06a94da0c77f8',
	nginx: '24037dee050b715df9a9d186fd1a279008f6dd549e55f59f8f4b2bfa7af9efc1',
	nginxInternal: '29db6f106e028df8eb9a559ffd67d4dc5fd88cc1c2569fefc5ee4ecd2612ae35',
	previewAcme: 'fab7f3b7ac524933870095ef54c0b427692b0b79b5972fcb8f699c54247c0eea',
	previewOrigin: '0225e5a358d34da240026d2f1f9475cc4d3a0c43e375f6f12b8f6938efe304d8',
}
const PREVIEWS = {
	previewAcme: { name: 'pv-demo-feat', dockerfilePath: 'Dockerfile', containerPort: 3000, envFiles: ['/opt/apps/demo.preview.env'], host: 'pv-demo-feat.apps.example.com' },
	previewOrigin: {
		name: 'pv-demo-feat',
		dockerfilePath: 'app/Dockerfile',
		containerPort: 8080,
		envFiles: ['/opt/apps/demo.preview.env'],
		host: 'pv-demo-feat.apps.example.com',
		healthUrl: '/up',
		tlsMode: 'origin-cert' as const,
	},
}

describe('the rendered composes follow the Traefik network', () => {
	it('web (or none given): byte-identical to before', () => {
		for (const [k, opts] of Object.entries(COMBOS)) {
			expect(sha(renderComposeYaml({ ...APP, ...opts })), k).toBe(PINNED[k])
			expect(sha(renderComposeYaml({ ...APP, ...opts, traefikNetwork: 'web' })), k).toBe(PINNED[k])
		}
		for (const [k, opts] of Object.entries(PREVIEWS)) {
			expect(sha(renderPreviewCompose(opts)), k).toBe(PINNED[k])
			expect(sha(renderPreviewCompose({ ...opts, traefikNetwork: 'web' })), k).toBe(PINNED[k])
		}
	})
	it('another network: joined instead of web, with traefik.docker.network, also before a host exists', () => {
		const yml = renderComposeYaml({ ...APP, ...COMBOS.traefikHost, traefikNetwork: 'edge' })
		expect(yml).toMatch(/^networks:\n {2}edge:\n {4}external: true\n {2}internal:\n {4}external: true\n/m)
		expect(yml).toContain('      - traefik.enable=true\n      - traefik.docker.network=edge\n')
		expect(yml).toMatch(/ {4}networks:\n {6}- edge\n {6}- internal\n {6}- demo-db\n {6}- demo-kv\n/)
		expect(yml).not.toMatch(/\bweb\b/)
		const noHost = renderComposeYaml({ ...APP, ...COMBOS.traefikNoHost, traefikNetwork: 'edge' })
		expect(noHost).toContain('      - traefik.enable=false\n      - traefik.docker.network=edge\n')
		expect(() => renderComposeYaml({ ...APP, ...COMBOS.traefikNoHost, traefikNetwork: 'a b' })).toThrow(/invalid docker network name/)
		const pv = renderPreviewCompose({ ...PREVIEWS.previewAcme, traefikNetwork: 'edge' })
		expect(pv).toContain('      - traefik.enable=true\n      - traefik.docker.network=edge\n')
		expect(pv).toMatch(/ {4}networks:\n {6}- edge\n {6}- default\n\nnetworks:\n {2}edge:\n {4}external: true\n$/)
		// branch code never joins the shared internal network
		expect(() => renderPreviewCompose({ ...PREVIEWS.previewAcme, traefikNetwork: 'internal' })).toThrow(/internal/)
	})
	it('the compose guard accepts the template on its own server only, without widening the shared list', () => {
		const yml = renderComposeYaml({ ...APP, ...COMBOS.traefikHost, traefikNetwork: 'edge' })
		expect(checkComposeSafe(yml, 'demo')).toMatch(/network "edge"/)
		expect(checkComposeSafe(yml, 'demo', { traefikNetwork: 'edge' })).toBeNull()
		// infra was already a shared network
		expect(checkComposeSafe(renderComposeYaml({ ...APP, ...COMBOS.traefikHost, traefikNetwork: 'infra' }), 'demo')).toBeNull()
	})
})

describe('check items and plan without ssh', () => {
	it('the plan creates the routing network Traefik uses, never web where Traefik routes over another', () => {
		const f = {
			root: true,
			os: 'ubuntu',
			docker: 'present' as const,
			dockerVersion: '29.0.0',
			compose: 'present' as const,
			networks: { web: 'absent' as const, internal: 'present' as const },
			dockerNetworks: [{ name: 'internal', internal: false }],
			traefik: 'running' as const,
			traefikFileProvider: 'ok' as const,
			traefikNetwork: { name: 'edge', source: 'flag' as const, attached: ['edge'], why: '' },
			appsDir: 'present' as const,
			dynamicDir: 'present' as const,
			ufw: 'inactive' as const,
			port80: 'busy' as const,
			port443: 'busy' as const,
			nginx: 'absent' as const,
			nginxBinary: 'absent' as const,
			nginxUnit: 'absent' as const,
			portBindings: 'bound' as const,
			proxyContainers: 'present' as const,
			diskFreeBytes: null,
			memTotalBytes: null,
			memAvailBytes: null,
		}
		const plan = planApply(f, `'${DYN}'`, 'traefik')
		expect(plan.steps.map((s) => [s.id, s.command])).toEqual([
			['network-traefik', 'docker network inspect edge >/dev/null 2>&1 || docker network create edge'],
		])
		const items = checkItems(f, DYN, 'traefik')
		expect(isCheckGreen(items)).toBe(false)
		expect(missingPieces(items).map((m) => m.id)).toEqual(['traefik-network'])
	})
})

describe('the apply route accepts every planned step', () => {
	it('each StepId is in the route allowlist (a new step would otherwise never run)', () => {
		const lib = readFileSync(join(__dirname, '../server-bootstrap.ts'), 'utf8')
		const union = /export type StepId =([\s\S]*?)\n\n/.exec(lib)?.[1] ?? ''
		const ids = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
		expect(ids).toContain('network-traefik')
		const route = readFileSync(join(__dirname, '../../app/api/servers/[id]/bootstrap/route.ts'), 'utf8')
		for (const id of ids) expect(route, id).toContain(`'${id}'`)
	})
})

describe('which network powder routes over, by source (the behaviour table)', () => {
	const r = (inspect: InspectJson | null, extra: Partial<Parameters<typeof traefikNetworkFrom>[0]> = {}) => {
		const t = traefikNetworkFrom({ traefik: inspect !== null, inspect, ...extra })
		return { resolved: t.name, source: t.source, route: routingNetwork(t) }
	}
	it('flag and config are routed over; attachment and nothing are not', () => {
		expect(r({ Args: ['--providers.docker.network=edge'], NetworkSettings: { Networks: nets('edge') } })).toEqual({ resolved: 'edge', source: 'flag', route: 'edge' })
		expect(
			r({ Mounts: [{ Source: '/srv/proxy/traefik.yml', Destination: '/etc/traefik/traefik.yml' }], NetworkSettings: { Networks: nets('infra', 'backplane') } }, {
				config: { text: 'providers:\n  docker:\n    network: infra\n', path: '/srv/proxy/traefik.yml' },
				networks: [{ name: 'infra', internal: false }, { name: 'backplane', internal: true }],
			}),
		).toEqual({ resolved: 'infra', source: 'config', route: 'infra' })
		expect(r({ NetworkSettings: { Networks: nets('web', 'zeta') } })).toEqual({ resolved: 'web', source: 'attached', route: 'web' })
		expect(r({ NetworkSettings: { Networks: nets('zeta') } })).toEqual({ resolved: 'zeta', source: 'attached', route: 'web' })
		expect(r({ NetworkSettings: { Networks: nets('zeta', 'alpha') } })).toEqual({ resolved: 'alpha', source: 'attached', route: 'web' })
		expect(r(null)).toEqual({ resolved: 'web', source: 'default', route: 'web' })
	})
})

describe('dockerNetworkFromConfig: the forms Traefik accepts', () => {
	it('TOML literal strings, quoted and dotted keys, key case', () => {
		expect(dockerNetworkFromConfig("[providers.docker]\n  network = 'infra'\n", 'a.toml')).toBe('infra')
		expect(dockerNetworkFromConfig('[Providers.Docker]\nNetwork = "infra"\n', 'a.toml')).toBe('infra')
		expect(dockerNetworkFromConfig('[providers]\n  docker.network = "infra"\n', 'a.toml')).toBe('infra')
		expect(dockerNetworkFromConfig('[ "providers" . docker ]\n  "network" = "infra"\n', 'a.toml')).toBe('infra')
		expect(dockerNetworkFromConfig('providers.docker.network = "infra"\n', 'a.toml')).toBe('infra')
		// a later table resets the scope; arrays of tables are never the providers table
		expect(dockerNetworkFromConfig('[providers.docker]\n[entryPoints.web]\nnetwork = "x"\n', 'a.toml')).toBeNull()
		expect(dockerNetworkFromConfig('[[providers.docker]]\nnetwork = "x"\n', 'a.toml')).toBeNull()
		// escapes or anything unreadable: no answer, never a guess
		expect(dockerNetworkFromConfig('[providers.docker]\nnetwork = "in\\u0066ra"\n', 'a.toml')).toBeNull()
		expect(dockerNetworkFromConfig('[providers.docker\nnetwork = "x"\n', 'a.toml')).toBeNull()
		expect(dockerNetworkFromConfig('\u0000\u0001', 'a.toml')).toBeNull()
	})
	it('YAML merge keys and key case', () => {
		expect(dockerNetworkFromConfig('base: &b\n  network: infra\nproviders:\n  docker:\n    <<: *b\n', 'a.yml')).toBe('infra')
		expect(dockerNetworkFromConfig('Providers:\n  Docker:\n    Network: infra\n', 'a.yml')).toBe('infra')
		expect(dockerNetworkFromConfig('providers:\n  docker:\n    network: [infra]\n', 'a.yml')).toBeNull()
		expect(dockerNetworkFromConfig('a: *missing\n', 'a.yml')).toBeNull()
	})
})
