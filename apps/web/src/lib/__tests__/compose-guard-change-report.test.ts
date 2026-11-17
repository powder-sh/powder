// A hand edit of the server compose switches the app from `network_mode: host` to
// bridge ports, with DATABASE_URL on 127.0.0.1:5441 (the port the db container publishes
// on the server). The refusal lists what changed versus the last successful deploy, and
// the env_loopback rule refuses the switch itself.
import { describe, expect, it, vi } from 'vitest'

const state = { probe: '' }
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		const sep = cmd.match(/__POWDER_CG_SEP_[0-9a-f]+__/)?.[0]
		if (sep) return { stdout: state.probe.split('__POWDER_CG_SEP__').join(sep), stderr: '', code: 0 }
		return { stdout: '', stderr: '', code: 0 }
	},
}))

import { envLoopbackViolations, loopbackTargets } from '../compose-env-loopback'
import { checkComposeForDeploy, structuralComposeHash, structuralComposeView } from '../deploy/compose-check'
import { type ComposeView, composeViewDiff, composeViewOf, parseComposeView } from '../deploy/compose-diff'

const server = { id: 's1', name: 's1', host: 'h', user: 'root', port: 22, kind: 'compose' as const }
const SECRET = 's3cretpw'
const DB_URL = `postgres://app:${SECRET}@127.0.0.1:5441/app`
const db = {
	image: 'postgres:16',
	ports: [{ mode: 'ingress', host_ip: '127.0.0.1', target: 5432, published: '5441', protocol: 'tcp' }],
}
const uploads = { type: 'bind', source: '/opt/apps/acme-uploads', target: '/app/uploads' }

/** the resolved config (env_file contents inlined into environment) */
const hostMode = (env: Record<string, string> = { DATABASE_URL: DB_URL }) => ({
	name: 'acme',
	services: {
		app: { image: 'acme:latest', container_name: 'acme', network_mode: 'host', environment: env, volumes: [uploads] },
		db,
	},
})
const bridgeMode = (env: Record<string, string> = { DATABASE_URL: DB_URL }, extra: Record<string, unknown> = {}) => ({
	name: 'acme',
	services: {
		app: {
			image: 'acme:latest',
			container_name: 'acme',
			environment: env,
			volumes: [uploads],
			ports: [{ mode: 'ingress', host_ip: '127.0.0.1', target: 3004, published: '3004', protocol: 'tcp' }],
			labels: { 'powder.bridge.enabled': 'true', 'powder.bridge.host-port': '13004' },
			networks: { default: null },
			...extra,
		},
		db,
	},
})
const probe = (doc: unknown) => ['a'.repeat(64), JSON.stringify(doc), JSON.stringify(doc), '', JSON.stringify(doc)].join('\n__POWDER_CG_SEP__\n')

const HOST_HASH = structuralComposeHash(hostMode())
const HOST_VIEW = structuralComposeView(hostMode())
const files = ['/opt/apps/acme/docker-compose.yml']
const check = (doc: unknown, env: Record<string, string | undefined>, approved: { hash: string | null; view?: unknown } = { hash: HOST_HASH, view: HOST_VIEW }) => {
	state.probe = probe(doc)
	return checkComposeForDeploy(
		server as never,
		'-f /opt/apps/acme/docker-compose.yml',
		{
			appName: 'acme',
			workingDir: '/opt/apps/acme',
			composeFiles: files,
			routeHosts: null,
			approvedHash: approved.hash,
			approvedView: parseComposeView(approved.view ?? null),
		},
		env,
	)
}
const WARN = { POWDER_COMPOSE_GUARD: 'warn' }
const errOf = async (p: Promise<unknown>) => {
	try {
		await p
	} catch (e) {
		return (e as Error).message
	}
	throw new Error('expected a refusal')
}

describe('acme: host -> bridge switch by a server-side compose edit', () => {
	it('an unchanged host-mode config still passes (warn mode: findings only warn)', async () => {
		const r = await check(hostMode(), WARN)
		expect(r.structuralHash).toBe(HOST_HASH)
		expect(r.log).not.toContain('env_loopback')
		expect(r.log).not.toContain('What changed')
	})

	it('is refused with env_loopback, and the refusal lists what changed', async () => {
		const msg = await errOf(check(bridgeMode(), WARN))
		expect(msg).toContain('the compose config differs from the last successful deploy')
		expect(msg).toContain('service app: env DATABASE_URL points at 127.0.0.1:5441 but the service is not on host networking')
		expect(msg).toContain('[env_loopback]')
		expect(msg).toContain('services.app.network_mode: host -> (unset)')
		expect(msg).toContain('services.app.ports: added 127.0.0.1:3004:3004')
		expect(msg).toContain('services.app.labels: added powder.bridge.enabled, powder.bridge.host-port')
		expect(msg).toContain('services.app.networks: added default')
		expect(msg).toContain('A hand edit of the compose on the server (/opt/apps/acme/docker-compose.yml)')
		// no secret value: not the env value, not a label value
		expect(msg).not.toContain(SECRET)
		expect(msg).not.toContain('13004')
	})

	// without the old uploads bind (its own finding), as a compose that only switched networking
	const noBind = () => {
		const d = bridgeMode()
		d.services.app.volumes = []
		return d
	}

	it('is refused on env_loopback alone when nothing else trips', async () => {
		const msg = await errOf(check(noBind(), WARN))
		expect(msg).toMatch(/high-severity safety rule:\n {2}- service app: env DATABASE_URL points at 127\.0\.0\.1:5441[^\n]*\[env_loopback\]\nWhat changed/)
	})

	it('env_loopback is exemptable by variable name', async () => {
		// the exemption list is read from powder's own environment
		vi.stubEnv('POWDER_COMPOSE_GUARD_EXEMPT', JSON.stringify({ 's1/acme': { env_loopback: ['DATABASE_URL'] } }))
		try {
			const r = await check(noBind(), WARN)
			expect(r.log).toContain('What changed since the last successful deploy')
			expect(r.log).toContain('(exempt: env_loopback=DATABASE_URL)')
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it('enforce mode refuses the switch on env_loopback too', async () => {
		const msg = await errOf(check(noBind(), {}))
		expect(msg).toContain("breaks powder's safety rules")
		expect(msg).toContain('[env_loopback]')
		expect(msg).toContain('services.app.network_mode: host -> (unset)')
	})

	it('without a stored view the refusal says so', async () => {
		const msg = await errOf(check(bridgeMode(), WARN, { hash: HOST_HASH, view: null }))
		expect(msg).toContain('no copy of the last successful config is stored')
		expect(msg).toContain('[env_loopback]')
	})
})

describe('bridge apps that must pass', () => {
	const ok = (env: Record<string, string>) => {
		const doc = bridgeMode(env)
		doc.services.app.volumes = []
		return doc
	}
	it('DATABASE_URL on the db service name', async () => {
		const r = await check(ok({ DATABASE_URL: `postgres://app:${SECRET}@db:5432/app` }), WARN)
		expect(r.log).toContain('resolved config passes')
		expect(r.log).toContain('services.app.network_mode: host -> (unset)')
		expect(r.log).not.toContain(SECRET)
	})
	it('its own port on loopback (published container port, PORT)', async () => {
		const r = await check(ok({ API_URL: 'http://localhost:3004', PORT: '3005', SELF_URL: 'http://127.0.0.1:3005/api' }), WARN)
		expect(r.log).toContain('resolved config passes')
	})
	it('browser-facing and allow-list values with localhost pass', async () => {
		const r = await check(
			ok({
				NEXTAUTH_URL: 'http://localhost:3000',
				BETTER_AUTH_URL: 'http://localhost:3000',
				CORS_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
				ALLOWED_HOSTS: 'localhost:8000,127.0.0.1:8000',
				NEXT_PUBLIC_API_URL: 'http://localhost:4000',
				OAUTH_REDIRECT_URL: 'http://localhost:3000/cb',
				SITE_URL: 'http://localhost:3000',
				APP_BASE_URL: 'http://localhost:3000',
				GREETING: 'see http://localhost:9999',
			}),
			WARN,
		)
		expect(r.log).toContain('resolved config passes')
	})
	it('postgres on loopback is still refused next to them', async () => {
		const msg = await errOf(check(ok({ NEXTAUTH_URL: 'http://localhost:3000', DATABASE_URL: DB_URL }), WARN))
		expect(msg).toContain('env DATABASE_URL points at 127.0.0.1:5441')
		expect(msg).not.toContain('NEXTAUTH_URL')
	})
	it('a port the running image EXPOSEs is its own port', async () => {
		const doc = ok({ INTERNAL_API_URL: 'http://127.0.0.1:9000' })
		// probe sections: ps (4th), details (7th), image configs (8th)
		const ps = 'acme\tacme:latest\tacme\trunning\tapp\tacme_default'
		const detail = 'acme\tacme\tacme:latest\tsha256:img1\tnull\t[]'
		const image = `sha256:img1\t${JSON.stringify({ ExposedPorts: { '9000/tcp': {} } })}`
		const c = JSON.stringify(doc)
		state.probe = ['a'.repeat(64), c, c, ps, c, '', detail, image].join('\n__POWDER_CG_SEP__\n')
		const r = await checkComposeForDeploy(
			server as never,
			'-f x',
			{ appName: 'acme', workingDir: '/opt/apps/acme', composeFiles: files, routeHosts: null, approvedHash: HOST_HASH, approvedView: parseComposeView(HOST_VIEW) },
			WARN,
		)
		expect(r.log).toContain('resolved config passes')
		// the same without the image config: refused
		state.probe = ['a'.repeat(64), c, c, ps, c, '', detail, ''].join('\n__POWDER_CG_SEP__\n')
		await expect(
			checkComposeForDeploy(
				server as never,
				'-f x',
				{ appName: 'acme', workingDir: '/opt/apps/acme', composeFiles: files, routeHosts: null, approvedHash: HOST_HASH },
				WARN,
			),
		).rejects.toThrow(/INTERNAL_API_URL points at 127\.0\.0\.1:9000/)
	})
})

describe('repo change: env_loopback runs only when the structure moved', () => {
	const bridge = bridgeMode()
	bridge.services.app.volumes = []
	const bridgeHash = structuralComposeHash(bridge)
	const run = (doc: unknown, prior: string) => {
		state.probe = probe(doc)
		return checkComposeForDeploy(
			server as never,
			'-f x',
			{ appName: 'acme', workingDir: '/opt/apps/acme', composeFiles: files, routeHosts: null, approvedHash: null, repoChanged: true, priorStructuralHash: prior },
			WARN,
		)
	}
	it('an env-only change (same structure as the first check) is not judged on it', async () => {
		const r = await run(bridge, bridgeHash)
		expect(r.log).not.toContain('env_loopback')
	})
	it('a structural move in the sync is', async () => {
		await expect(run(bridge, HOST_HASH)).rejects.toThrow(/the repo changed the compose config[\s\S]*\[env_loopback\]/)
	})
})

describe('envLoopbackViolations', () => {
	const svc = (environment: unknown, extra: Record<string, unknown> = {}) => ({ app: { image: 'x', environment, ...extra } })
	it('ignores loopback words without a port, and host networking', () => {
		expect(envLoopbackViolations(svc({ ALLOWED_HOSTS: 'localhost,127.0.0.1', HOSTNAME: '0.0.0.0', DB: 'localhost' }))).toEqual([])
		expect(envLoopbackViolations(svc({ DATABASE_URL: DB_URL }, { network_mode: 'host' }))).toEqual([])
	})
	it('a listen address is the service itself', () => {
		expect(envLoopbackViolations(svc({ METRICS_ADDR: '0.0.0.0:9100', LISTEN_ADDR: '127.0.0.1:9000', BIND_HOST: 'localhost:9001' }))).toEqual([])
	})
	it('judges only connection targets', () => {
		const names = (env: Record<string, string>) => envLoopbackViolations(svc(env)).map((x) => x.value)
		expect(names({ CORS: 'http://localhost:5173', NEXTAUTH_URL: 'http://localhost:3000', TRUSTED_ORIGINS: 'http://127.0.0.1:1' })).toEqual([])
		expect(names({ DOCS: 'http://localhost:8080', CACHE: 'localhost:6379', WS_URL: 'ws://localhost:1234' })).toEqual([])
		expect(names({ SEARCH_URL: 'http://localhost:7700', ANYNAME: 'mysql://u:p@localhost:3306/x', REDIS_HOST: 'localhost:6379' })).toEqual([
			'SEARCH_URL',
			'ANYNAME',
			'REDIS_HOST',
		])
	})
	it('name exclusions match whole word parts, backend schemes match with a driver suffix', () => {
		const names = (env: Record<string, string>) => envLoopbackViolations(svc(env)).map((x) => x.value)
		expect(
			names({
				DATABASE_URL: 'postgresql+asyncpg://u:p@127.0.0.1:5441/app',
				DB_URL: 'mysql+pymysql://u:p@localhost:3306/x',
				CACHE_URL: 'redis+sentinel://localhost:26379/m',
				MSSQL_URL: 'sqlserver://localhost:1433',
				CRDB: 'cockroachdb://root@127.0.0.1:26257/d',
				DEPOSITE_HOST: 'localhost:7000',
				DATABASE_ENDPOINT: 'http://localhost:7001',
			}),
		).toEqual(['DATABASE_URL', 'DB_URL', 'CACHE_URL', 'MSSQL_URL', 'CRDB', 'DEPOSITE_HOST', 'DATABASE_ENDPOINT'])
		// a DATABASE_URL over http is a target too (BASE_URL does not match inside it)
		expect(names({ DATABASE_URL: 'http://127.0.0.1:8123' })).toEqual(['DATABASE_URL'])
		expect(names({ APP_BASE_URL: 'http://localhost:1', SITES_URL: 'http://localhost:2', CORS_ORIGINS: 'http://localhost:3' })).toEqual([])
	})
	it('flags bare and URL forms, the list form of environment, and only the name and host:port', () => {
		const v = envLoopbackViolations(svc([`REDIS=redis://:${SECRET}@localhost:6379/0`, 'DB_HOSTS=10.0.0.1:1,127.0.0.1:5441']))
		expect(v.map((x) => [x.code, x.value])).toEqual([
			['env_loopback', 'REDIS'],
			['env_loopback', 'DB_HOSTS'],
		])
		expect(v[0]?.message).toContain('localhost:6379')
		expect(JSON.stringify(v)).not.toContain(SECRET)
	})
	it('a password holding @ does not hide the loopback host', () => {
		const v = envLoopbackViolations(svc({ DATABASE_URL: 'postgres://app:p@ss@word@127.0.0.1:5441/app' }))
		expect(v.map((x) => x.message)).toEqual([expect.stringContaining('points at 127.0.0.1:5441')])
		expect(v[0]?.message).not.toContain('ss@word')
	})
	it('a shared namespace (network_mode: service:x, two or more members) is skipped', () => {
		const services = {
			app: { image: 'x', environment: { DATABASE_URL: DB_URL } },
			proxy: { image: 'y', network_mode: 'service:app', environment: { UPSTREAM_URL: 'http://127.0.0.1:1' } },
		}
		expect(envLoopbackViolations(services)).toEqual([])
	})
	it('image EXPOSE ports, a Traefik service port label or a healthcheck port are its own ports', () => {
		expect(envLoopbackViolations(svc({ API_URL: 'http://localhost:9000' }), { app: [9000] })).toEqual([])
		expect(
			envLoopbackViolations(svc({ API_URL: 'http://localhost:3000' }, { labels: { 'traefik.http.services.app.loadbalancer.server.port': '3000' } })),
		).toEqual([])
		expect(
			envLoopbackViolations(svc({ APP_URL: 'http://localhost:8080' }, { healthcheck: { test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:8080/health'] } })),
		).toEqual([])
	})
	it('[::1] with a port is loopback too', () => {
		expect(loopbackTargets('http://[::1]:5432/x')).toEqual([{ host: '[::1]', port: 5432, scheme: 'http' }])
	})
})

describe('composeViewDiff', () => {
	const SALT = '0'.repeat(32)
	it('never prints build args or command values', () => {
		const a = composeViewOf({ services: { app: { build: { context: '.', args: { TOKEN: 'aaa' } }, command: ['run', 'x'] } } }, SALT) as ComposeView
		const b = composeViewOf({ services: { app: { build: { context: '.', args: { TOKEN: 'bbb' } }, command: ['run', 'y'] } } }, SALT) as ComposeView
		const d = composeViewDiff(a, b).join('\n')
		expect(d).toContain('services.app.build: changed args (values not shown)')
		expect(d).toContain('services.app.command: changed (value not shown)')
		expect(d).not.toMatch(/aaa|bbb|run/)
	})
	it('hidden value hashes are keyed: another salt or another encryption key gives other hashes', () => {
		const doc = { services: { app: { labels: { 'x.pass': 'hunter2' } } } }
		const h = (salt: string, pepper: string) => (composeViewOf(doc, salt, pepper) as ComposeView).services.app?.labels
		expect(h(SALT, 'k1')).toEqual(h(SALT, 'k1'))
		expect(h(SALT, 'k1')).not.toEqual(h('1'.repeat(32), 'k1'))
		expect(h(SALT, 'k1')).not.toEqual(h(SALT, 'k2'))
		// a fresh view gets a fresh random salt
		expect((composeViewOf(doc) as ComposeView).salt).not.toBe((composeViewOf(doc) as ComposeView).salt)
	})
	it('views with different salts compare hidden keys by name only', () => {
		const a = composeViewOf({ services: { app: { labels: { a: '1' } } } }, SALT) as ComposeView
		const b = composeViewOf({ services: { app: { labels: { a: '1', b: '2' } } } }, '1'.repeat(32)) as ComposeView
		expect(composeViewDiff(a, b)).toEqual(['services.app.labels: added b'])
	})
	it('reports added and removed services', () => {
		const a = composeViewOf({ services: { app: {} } }, SALT) as ComposeView
		const b = composeViewOf({ services: { app: {}, worker: { image: 'w' } } }, SALT) as ComposeView
		expect(composeViewDiff(a, b)).toEqual(['services.worker: added (new service)'])
		expect(composeViewDiff(b, a)).toEqual(['services.worker: removed'])
	})
	it('a stored view that is not one reads as null', () => {
		expect(parseComposeView({ v: 1, services: {}, top: {} })).toBeNull()
		expect(parseComposeView({ v: 2, salt: 'x', services: {}, top: {} })).toBeNull()
		expect(parseComposeView(HOST_VIEW)).toEqual(HOST_VIEW)
	})
})
