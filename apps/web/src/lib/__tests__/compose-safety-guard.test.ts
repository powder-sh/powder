// Guard test for the ONE compose safety authority (compose-safety.ts).
// Every known bypass class must be refused; every compose shape
// powder renders or real installs run (an ops hub, an API + renderer) must pass.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkComposeSafe } from '../compose-guard'
import { renderComposeYaml } from '../compose-render'
import {
	type ComposeGuardContext,
	composeViolations,
	exemptCodesFor,
	routerRuleHosts,
} from '../compose-safety'
import {
	composeHashGuardShell,
	deployGuardContext,
	mergeFilePaths,
	parseComposeProbe,
} from '../deploy/compose-check'
import { buildDeployScript } from '../deploy/script'
import { writeFakeDocker } from './fixtures/fake-docker'

const ctx: ComposeGuardContext = {
	appName: 'myapp',
	projectDir: '/opt/apps/myapp',
	protectedPaths: ['/opt/apps/myapp/docker-compose.yml', '/opt/apps/myapp/.deploy-key'],
	routeHosts: ['myapp.apps.example.com', 'myapp.com'],
	foreignContainers: ['victim', 'victim-db'],
	foreignImages: ['victim:latest'],
}

/** A resolved `docker compose config --format json` doc for myapp, with `svc` merged into the app service. */
function resolved(svc: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
	return {
		name: 'myapp',
		networks: { web: { name: 'web', external: true }, 'myapp-db': { name: 'myapp_myapp-db' } },
		services: {
			myapp: {
				build: { context: '/opt/apps/myapp/src', dockerfile: 'Dockerfile' },
				command: null,
				entrypoint: null,
				container_name: 'myapp',
				image: 'myapp:latest',
				environment: { A: '1' },
				labels: {
					'traefik.enable': 'true',
					'traefik.http.routers.myapp.rule': 'Host(`myapp.com`) || Host(`myapp.apps.example.com`)',
				},
				networks: { web: null, 'myapp-db': null },
				restart: 'unless-stopped',
				mem_limit: '536870912',
				volumes: [
					{
						type: 'bind',
						source: '/opt/apps/myapp/data',
						target: '/data',
						bind: { create_host_path: true },
					},
				],
				...svc,
			},
		},
		...top,
	}
}

const codes = (doc: unknown, c: ComposeGuardContext = ctx) =>
	composeViolations(doc, c).map((v) => v.code)

describe('compose safety authority: shapes that must pass', () => {
	it('every renderComposeYaml variant', () => {
		const base = {
			name: 'myapp',
			dockerfilePath: './Dockerfile',
			hostPort: null,
			containerPort: 3000,
			envFilePath: '/opt/apps/myapp.env',
			publicHost: 'myapp.apps.example.com',
			postgres: { password: 'pw', dataDir: '/opt/apps/myapp/pgdata' },
			kv: { dataDir: '/opt/apps/myapp/kvdata' },
		}
		for (const v of [
			base,
			{ ...base, postgres: null, kv: null },
			{ ...base, publicHost: null, traefik: true, hostPort: 3100 },
			{ ...base, tlsMode: 'origin-cert' as const },
		]) {
			expect(
				checkComposeSafe(renderComposeYaml(v), 'myapp', { routeHosts: ['myapp.apps.example.com'] }),
			).toBeNull()
		}
	})
	it('the resolved standard app', () => {
		expect(codes(resolved())).toEqual([])
	})
	it('the bridge mode labels (traefik, host-port, dns-alias) are not runtime markers', () => {
		const labels = {
			'powder.bridge.enabled': 'true',
			'powder.bridge.dns-alias': 'true',
			'powder.bridge.port': '3000',
			'powder.bridge.host-port': '13000',
			'powder.bridge.boot-push-ok': 'true',
		}
		expect(codes(resolved({ labels }))).toEqual([])
		expect(codes(resolved({ labels: { 'powder.bridge': '/opt/apps/victim|app' } }))).toContain('powder_label')
	})
	it('blog (workdir layout, bundled postgres, initdb binds, a port on a private address)', () => {
		const doc = {
			name: 'blog',
			networks: { default: { name: 'blog_default' } },
			services: {
				app: {
					build: { context: '/opt/apps/blog', dockerfile: 'Dockerfile' },
					container_name: 'blog',
					image: 'ghcr.io/example/blog:latest',
					environment: { PORT: '3000', HOSTNAME: '0.0.0.0' },
					env_file: [{ path: '/opt/apps/blog.env', required: true }],
					ports: [
						{
							mode: 'ingress',
							host_ip: '127.0.0.1',
							target: 3000,
							published: '3019',
							protocol: 'tcp',
						},
					],
					depends_on: { postgres: { condition: 'service_healthy', required: true } },
					restart: 'unless-stopped',
					networks: { default: null },
				},
				postgres: {
					image: 'pgvector/pgvector:pg16',
					container_name: 'blog-postgres',
					environment: { POSTGRES_USER: 'blog' },
					healthcheck: {
						test: ['CMD-SHELL', 'pg_isready -U blog -d blog'],
						interval: '5s',
						timeout: '3s',
						retries: 5,
					},
					ports: [{ host_ip: '192.0.2.10', target: 5432, published: '5433' }],
					restart: 'unless-stopped',
					volumes: [
						{
							type: 'volume',
							source: 'blog-pgdata',
							target: '/var/lib/postgresql/data',
							volume: {},
						},
						{
							type: 'bind',
							source: '/opt/apps/blog/db/schema.sql',
							target: '/docker-entrypoint-initdb.d/01-schema.sql',
							read_only: true,
							bind: {},
						},
					],
					networks: { default: null },
				},
			},
			volumes: { 'blog-pgdata': { name: 'blog_blog-pgdata' } },
		}
		expect(
			codes(doc, {
				appName: 'blog',
				projectDir: '/opt/apps/blog',
				protectedPaths: ['/opt/apps/blog/docker-compose.yml'],
				routeHosts: ['blog.example.com'],
			}),
		).toEqual([])
	})
	it('api + locked-down renderer, cross-project db over internal', () => {
		const doc = {
			name: 'api',
			networks: {
				internal: { name: 'internal', external: true },
				renderer_net: { name: 'api_renderer_net' },
				web: { name: 'web', external: true },
			},
			services: {
				'api': {
					build: {
						context: '/opt/apps/api/src',
						dockerfile: 'api/Dockerfile',
					},
					container_name: 'api',
					image: 'api:latest',
					env_file: [{ path: '/opt/apps/api.env', required: true }],
					networks: { internal: null, web: null, renderer_net: null },
					ports: [{ host_ip: '127.0.0.1', target: 3901, published: '13500' }],
				},
				'pdf-renderer': {
					build: { context: '/opt/apps/api/src', dockerfile: 'renderer/Dockerfile' },
					container_name: 'pdf-renderer',
					image: 'pdf-renderer:latest',
					env_file: [{ path: '/opt/apps/pdf-renderer.env', required: true }],
					read_only: true,
					tmpfs: ['/tmp'],
					cap_drop: ['ALL'],
					security_opt: ['no-new-privileges:true'],
					init: true,
					pids_limit: 256,
					mem_limit: '805306368',
					networks: { renderer_net: null },
				},
			},
		}
		expect(
			codes(doc, {
				appName: 'api',
				projectDir: '/opt/apps/api',
				foreignContainers: ['shared-db'],
				// the renderer already runs in this project (its env file exists)
				ownProjectContainers: ['api', 'pdf-renderer'],
			}),
			// pdf-renderer is not prefixed with the app name, so it
			// gets the image_name finding (a WARN at deploy by default; under enforce
			// the operator exempts image_name for this app or renames the image).
		).toEqual(['image_name'])
	})
})

describe('Docker Hub refs are canonical, built images cannot shadow official ones', () => {
	it('docker.io/library/<x>, index.docker.io/<x> and <x> are the same image', async () => {
		const { normImage } = await import('../compose-safety')
		for (const r of [
			'postgres:16',
			'docker.io/library/postgres:16',
			'index.docker.io/postgres:16',
			'library/postgres:16',
		])
			expect(normImage(r)).toBe('postgres:16')
		expect(normImage('docker.io/library/node')).toBe('node:latest')
		expect(normImage('docker.io/foo/bar')).toBe('foo/bar:latest')
		expect(normImage('ghcr.io/x/y:1')).toBe('ghcr.io/x/y:1')
		expect(normImage('localhost:5000/y')).toBe('localhost:5000/y:latest')
	})
	it('building docker.io/library/<victim image> is the image of another app', () => {
		const c = { ...ctx, foreignImages: ['postgres:16'] }
		expect(codes(resolved({ image: 'docker.io/library/postgres:16' }), c)).toContain('image')
		expect(codes(resolved({ image: 'index.docker.io/postgres:16' }), c)).toContain('image')
		const c2 = { ...ctx, foreignImages: ['docker.io/library/redis:7'] }
		expect(codes(resolved({ image: 'redis:7' }), c2)).toContain('image')
	})
	it('a built image named like an official one is flagged (image_name), app-prefixed is not', () => {
		expect(codes(resolved({ image: 'node:22-alpine' }))).toEqual(['image_name'])
		expect(codes(resolved({ image: 'docker.io/library/node:22-alpine' }))).toEqual(['image_name'])
		expect(codes(resolved({ image: 'postgres' }))).toEqual(['image_name'])
		expect(
			codes(resolved({ build: { context: '/opt/apps/myapp/src', tags: ['node:22-alpine'] } })),
		).toEqual(['image_name'])
		expect(codes(resolved({ image: 'myapp-web:latest' }))).toEqual([])
		expect(codes(resolved({ image: 'myapp' }))).toEqual([])
		expect(codes(resolved({ image: 'ghcr.io/me/node:22' }))).toEqual([])
		expect(codes(resolved({ image: 'myapplication:1' }))).toEqual(['image_name'])
		// Not built here: pulling an official image is normal.
		const { build: _b, ...noBuild } = resolved().services.myapp
		expect(
			codes({ ...resolved(), services: { myapp: { ...noBuild, image: 'node:22-alpine' } } }),
		).toEqual([])
	})
})

describe('compose safety authority: every bypass is refused', () => {
	const cases: Array<[string, unknown, string]> = [
		['privileged', resolved({ privileged: true }), 'privileged'],
		['cap_add', resolved({ cap_add: ['SYS_ADMIN'] }), 'cap_add'],
		['devices', resolved({ devices: [{ source: '/dev/sda', target: '/dev/sda' }] }), 'devices'],
		[
			'device_cgroup_rules',
			resolved({ device_cgroup_rules: ['a *:* rwm'] }),
			'device_cgroup_rules',
		],
		['pid host', resolved({ pid: 'host' }), 'pid'],
		['ipc host', resolved({ ipc: 'host' }), 'ipc'],
		['uts host', resolved({ uts: 'host' }), 'uts'],
		['userns host', resolved({ userns_mode: 'host' }), 'userns_mode'],
		['cgroup host', resolved({ cgroup: 'host' }), 'cgroup'],
		['network_mode host', resolved({ network_mode: 'host' }), 'network_mode'],
		['network_mode container', resolved({ network_mode: 'container:victim' }), 'network_mode'],
		['network_mode foreign service', resolved({ network_mode: 'service:victim' }), 'network_mode'],
		['seccomp unconfined', resolved({ security_opt: ['seccomp=unconfined'] }), 'security_opt'],
		['apparmor unconfined', resolved({ security_opt: ['apparmor=unconfined'] }), 'security_opt'],
		[
			'bind outside',
			resolved({ volumes: [{ type: 'bind', source: '/', target: '/host' }] }),
			'bind',
		],
		[
			'docker socket',
			resolved({ volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/s' }] }),
			'bind',
		],
		[
			'bind of another app',
			resolved({ volumes: [{ type: 'bind', source: '/opt/apps/victim', target: '/v' }] }),
			'bind',
		],
		[
			'bind prefix trick',
			resolved({ volumes: [{ type: 'bind', source: '/opt/apps/myapp-evil', target: '/v' }] }),
			'bind',
		],
		[
			'bind of the app dir itself',
			resolved({ volumes: [{ type: 'bind', source: '/opt/apps/myapp', target: '/a' }] }),
			'bind',
		],
		[
			'bind exposing the compose file',
			resolved({
				volumes: [{ type: 'bind', source: '/opt/apps/myapp/docker-compose.yml', target: '/c' }],
			}),
			'bind',
		],
		[
			'image volume of another app',
			resolved({ volumes: [{ type: 'image', source: 'victim:latest', target: '/v' }] }),
			'volume',
		],
		[
			'top-level volume bind device',
			resolved(
				{},
				{
					volumes: {
						d: {
							name: 'myapp_d',
							driver: 'local',
							driver_opts: { type: 'none', o: 'bind', device: '/etc' },
						},
					},
				},
			),
			'bind',
		],
		[
			'external volume of another project',
			resolved({}, { volumes: { pg: { name: 'victim_pgdata', external: true } } }),
			'volume_name',
		],
		[
			'named volume pointing at another project',
			resolved({}, { volumes: { pg: { name: 'victim_pgdata' } } }),
			'volume_name',
		],
		[
			'env_file of another app',
			resolved({ env_file: [{ path: '/opt/apps/victim.env', required: true }] }),
			'env_file',
		],
		[
			'env_file from a variable',
			resolved({ env_file: [{ path: '/opt/apps/myapp/${EF}', required: true }] }),
			'env_file',
		],
		['env_file host file', resolved({ env_file: ['/etc/shadow'] }), 'env_file'],
		['label_file outside', resolved({ label_file: ['/opt/apps/victim/labels'] }), 'env_file'],
		['build.context outside', resolved({ build: { context: '/opt/apps/victim/src' } }), 'build'],
		['build.context URL', resolved({ build: { context: 'https://github.com/x/y.git' } }), 'build'],
		[
			'build.additional_contexts path',
			resolved({
				build: {
					context: '/opt/apps/myapp/src',
					additional_contexts: { v: '/opt/apps/victim/src' },
				},
			}),
			'build',
		],
		[
			'build.additional_contexts image',
			resolved({
				build: {
					context: '/opt/apps/myapp/src',
					additional_contexts: { v: 'docker-image://victim:latest' },
				},
			}),
			'build',
		],
		[
			'build.ssh agent',
			resolved({ build: { context: '/opt/apps/myapp/src', ssh: ['default'] } }),
			'build',
		],
		[
			'build.network host',
			resolved({ build: { context: '/opt/apps/myapp/src', network: 'host' } }),
			'build',
		],
		[
			'build.entitlements',
			resolved({ build: { context: '/opt/apps/myapp/src', entitlements: ['security.insecure'] } }),
			'build',
		],
		[
			'build.tags over another app',
			resolved({ build: { context: '/opt/apps/myapp/src', tags: ['victim:latest'] } }),
			'image',
		],
		['built image named like another app', resolved({ image: 'victim' }), 'image'],
		[
			'build secret file outside',
			resolved({}, { secrets: { s: { file: '/root/.ssh/id_ed25519' } } }),
			'secret',
		],
		[
			'config file outside',
			resolved({}, { configs: { c: { file: '/opt/apps/victim.env' } } }),
			'config',
		],
		['container_name powder', resolved({ container_name: 'powder' }), 'container_name'],
		['container_name postgres', resolved({ container_name: 'postgres' }), 'container_name'],
		['container_name traefik', resolved({ container_name: 'traefik' }), 'container_name'],
		['container_name of another app', resolved({ container_name: 'victim' }), 'container_name'],
		[
			'traefik host of another app',
			resolved({ labels: { 'traefik.http.routers.x.rule': 'Host(`dashboard.example.com`)' } }),
			'traefik_host',
		],
		[
			'traefik catch-all',
			resolved({ labels: { 'traefik.http.routers.x.rule': 'PathPrefix(`/`)' } }),
			'traefik_host',
		],
		[
			'traefik OR widening',
			resolved({
				labels: { 'traefik.http.routers.x.rule': 'Host(`myapp.com`) || PathPrefix(`/`)' },
			}),
			'traefik_host',
		],
		[
			'traefik negation',
			resolved({
				labels: {
					'traefik.http.routers.x.rule': 'Host(`myapp.com`) && !Path(`/a`) || Host(`x.y`)',
				},
			}),
			'traefik_host',
		],
		[
			'traefik HostRegexp',
			resolved({ labels: { 'traefik.http.routers.x.rule': 'HostRegexp(`.+`)' } }),
			'traefik_host',
		],
		[
			'traefik tcp',
			resolved({ labels: { 'traefik.tcp.routers.x.rule': 'HostSNI(`*`)' } }),
			'traefik_tcp',
		],
		[
			'traefik api@internal',
			resolved({ labels: { 'traefik.http.routers.myapp.service': 'api@internal' } }),
			'traefik_internal',
		],
		[
			'traefik label in build labels',
			resolved({
				build: {
					context: '/opt/apps/myapp/src',
					labels: { 'traefik.http.routers.x.rule': 'Host(`evil.com`)' },
				},
			}),
			'traefik_host',
		],
		[
			'compose project label',
			resolved({ labels: { 'com.docker.compose.project': 'victim' } }),
			'compose_label',
		],
		[
			'powder runtime label',
			resolved({ labels: { 'powder.candidate': 'victim' } }),
			'powder_label',
		],
		[
			'volumes_from another container',
			resolved({ volumes_from: ['container:victim'] }),
			'volumes_from',
		],
		['external_links', resolved({ external_links: ['victim-db:db'] }), 'external_links'],
		['use_api_socket', resolved({ use_api_socket: true }), 'use_api_socket'],
		['provider', resolved({ provider: { type: 'evil' } }), 'provider'],
		['runtime', resolved({ runtime: 'runc-evil' }), 'runtime'],
		['gpus', resolved({ gpus: 'all' }), 'gpus'],
		[
			'alias hijacking the powder DB host',
			resolved({ networks: { web: { aliases: ['powder-postgres'] } } }),
			'network_alias',
		],
		[
			'alias hijacking another app',
			resolved({ networks: { web: { aliases: ['victim-db'] } } }),
			'network_alias',
		],
		['unknown key', resolved({ some_future_key: true }), 'unknown_key'],
		[
			'foreign network',
			resolved({}, { networks: { p: { name: 'powder-db', external: true } } }),
			'network',
		],
		[
			'another app db network',
			resolved({}, { networks: { v: { name: 'victim_victim-db', external: true } } }),
			'network',
		],
		['unresolved include', { ...resolved(), include: ['../victim/docker-compose.yml'] }, 'include'],
	]
	for (const [name, doc, code] of cases) {
		it(name, () => {
			expect(codes(doc)).toContain(code)
		})
	}

	it('the YAML merge-key bypass (`<<: *a`) is refused', () => {
		const yaml = `name: myapp
x-a: &a
  privileged: true
  volumes:
    - /:/host
services:
  myapp:
    <<: *a
    image: myapp:latest
`
		expect(checkComposeSafe(yaml, 'myapp')).toMatch(/privileged|bind/)
	})
	it('an unresolved extends is refused in a raw file', () => {
		expect(
			checkComposeSafe(
				'services:\n  a:\n    extends: { file: /opt/apps/victim/docker-compose.yml, service: x }\n',
				'myapp',
			),
		).toMatch(/extends/)
	})
})

describe('compose safety authority: helpers', () => {
	it('routerRuleHosts accepts Host disjunctions and AND-narrowing only', () => {
		expect(routerRuleHosts('Host(`a.b`) || Host(`c.d`)')).toEqual(['a.b', 'c.d'])
		expect(routerRuleHosts('Host(`a.b`) && PathPrefix(`/api`)')).toEqual(['a.b'])
		expect(routerRuleHosts('Host(`a.b`) || PathPrefix(`/`)')).toBeNull()
		expect(routerRuleHosts('PathPrefix(`/`)')).toBeNull()
	})
	it('exemptions are per code and per app, set by the operator only', () => {
		const env = JSON.stringify({ 'db-server/shop': ['network_mode'], other: ['bind'] })
		expect(exemptCodesFor('db-server', 'shop', env)).toEqual(['network_mode'])
		expect(exemptCodesFor('x', 'shop', env)).toEqual([])
		expect(exemptCodesFor('x', 'y', 'not json')).toEqual([])
		const doc = resolved({ network_mode: 'host', privileged: true })
		expect(codes(doc, { ...ctx, exempt: ['network_mode'] })).toEqual(['privileged'])
	})
	it('the deploy probe keeps env_file paths the resolved config inlines', () => {
		const r = resolved({})
		const raw = { services: { myapp: { env_file: [{ path: '/opt/apps/victim.env' }] } } }
		expect(codes(mergeFilePaths(r, raw))).toContain('env_file')
		const probe = parseComposeProbe(
			[
				'a'.repeat(64),
				JSON.stringify(r),
				JSON.stringify(raw),
				'victim\tvictim:latest\tvictim\nmyapp\tmyapp:latest\tmyapp',
			].join('\n__POWDER_CG_SEP__\n'),
		)
		expect(probe?.hash).toBe('a'.repeat(64))
		if (!probe) throw new Error('the probe did not parse')
		const c = deployGuardContext(probe, {
			appName: 'myapp',
			workingDir: '/opt/apps/myapp',
			composeFiles: ['/opt/apps/myapp/docker-compose.yml'],
			serverId: 's',
			routeHosts: null,
		})
		expect(c.foreignContainers).toEqual(['victim'])
		expect(c.protectedPaths).toContain('/opt/apps/myapp/.deploy-key')
	})
})

describe('deploy-time tripwire', () => {
	const scriptP = {
		workingDir: '/opt/apps/myapp',
		configFile: '/opt/apps/myapp/docker-compose.yml',
		service: 'myapp',
		cf: "-f '/opt/apps/myapp/docker-compose.yml'",
		declaredMode: 'build',
		prebuilt: false,
		infra: [],
		wantBranch: null,
		wantSha: null,
		shaIsStrict: false,
	}
	it('the deploy script re-checks the pinned hash after the git sync and before compose up', () => {
		const s = buildDeployScript({ ...scriptP, composeHash: 'b'.repeat(64) })
		const sync = s.indexOf('git sync (force src/ to GitHub)')
		const g1 = s.indexOf('step "compose guard"')
		const build = s.indexOf('docker compose build (local build)')
		const g2 = s.indexOf('step "compose guard (pre-up)"')
		const up = s.indexOf('step "docker compose up"')
		expect(sync).toBeGreaterThan(-1)
		expect(g1).toBeGreaterThan(sync)
		expect(build).toBeGreaterThan(g1)
		expect(g2).toBeGreaterThan(build)
		expect(up).toBeGreaterThan(g2)
	})
	it('the hash guard refuses a changed config and passes an unchanged one (real bash, stub docker)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cg-'))
		writeFakeDocker(dir, '#!/bin/sh\ncat "$CFG"\n')
		writeFileSync(join(dir, 'cfg'), '{"a":1}')
		const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CFG: join(dir, 'cfg') }
		const hash = execFileSync(
			'bash',
			['-c', '{ docker; echo ---; docker; } | sha256sum | cut -c1-64'],
			{ env },
		)
			.toString()
			.trim()
		const run = () => {
			try {
				return {
					rc: 0,
					out: execFileSync(
						'bash',
						['-c', `${composeHashGuardShell('', hash, 'during the git sync')} && echo PASSED`],
						{ env },
					).toString(),
				}
			} catch (e) {
				const err = e as { status: number; stdout: Buffer }
				return { rc: err.status, out: err.stdout.toString() }
			}
		}
		expect(run()).toEqual({ rc: 0, out: 'PASSED\n' })
		writeFileSync(join(dir, 'cfg'), '{"a":1,"privileged":true}')
		const r = run()
		expect(r.rc).toBe(1)
		expect(r.out).toContain('__POWDER_COMPOSE_CHANGED__')
	})
})

// Raw-YAML bypasses through checkComposeSafe (the /new + override entry point).
// Every one of these gets past a naive yaml checker.
describe('checkComposeSafe: raw YAML bypasses a naive checker accepts', () => {
	const svc = (x: string) => `name: myapp\nservices:\n  myapp:\n    image: myapp:latest\n${x}`
	const bypasses: Record<string, string> = {
		merge:
			'name: myapp\nx-a: &a\n  privileged: true\nservices:\n  myapp:\n    <<: *a\n    image: x\n',
		device_cgroup_rules: svc('    device_cgroup_rules: ["a *:* rwm"]\n'),
		network_container: svc('    network_mode: "container:victim"\n'),
		env_file: svc('    env_file: /opt/apps/victim.env\n'),
		build_ctx: svc('    build: { context: /opt/apps/victim/src }\n'),
		container_name: svc('    container_name: powder\n'),
		traefik: svc('    labels: ["traefik.http.routers.x.rule=Host(`dashboard.example.com`)"]\n'),
		compose_label: svc('    labels: ["com.docker.compose.project=victim"]\n'),
		volume_device: `${svc('')}volumes:\n  d:\n    driver_opts: { type: none, o: bind, device: /etc }\n`,
		use_api_socket: svc('    use_api_socket: true\n'),
	}
	for (const [k, y] of Object.entries(bypasses))
		it(k, () => expect(checkComposeSafe(y, 'myapp', { routeHosts: ['myapp.com'] })).not.toBeNull())
})
