// Each hostile compose below once passed composeViolations with zero findings
// (names invented). Each must now be refused, and the
// common real-world shapes must still pass with zero findings.
import { describe, expect, it } from 'vitest'
import { type ComposeGuardContext, composeViolations, publishedPorts } from '../compose-safety'
import {
	type ComposeCheckInput,
	deployGuardContext,
	parseComposeProbe,
	parseDetailProbe,
	parseImageProbe,
} from '../deploy/compose-check'

const base: ComposeGuardContext = {
	appName: 'mallory',
	projectDir: '/opt/apps/mallory',
	otherApps: ['acme-portal', 'teashop', 'web-app'],
	foreignImages: ['ghcr.io/acme-org/acme-portal:latest', 'registry.example.com/team/teaimg:v3'],
	foreignBuiltImages: ['ghcr.io/acme-org/acme-portal:latest', 'registry.example.com/team/teaimg:v3'],
	foreignContainers: ['acme-portal', 'teashop'],
	foreignNamesByNetwork: { web: [] },
	resolved: true,
}
const codes = (c: unknown, ctx: ComposeGuardContext = base) => composeViolations(c, ctx).map((v) => v.code)
const svc = (def: Record<string, unknown>, top: Record<string, unknown> = {}) => ({
	name: 'mallory',
	services: { mallory: { image: 'nginx', ...def } },
	...top,
})

describe('foreign image on a service without build', () => {
	it('refuses another app name as the last path segment (pull_policy never too)', () => {
		expect(codes(svc({ image: 'ghcr.io/acme-org/acme-portal:latest', pull_policy: 'never' }))).toContain('image')
		expect(codes(svc({ image: 'ghcr.io/other-org/teashop:v1' }))).toContain('image')
	})
	it('refuses an image another project built, by repository (other tag, digest pin)', () => {
		expect(codes(svc({ image: 'registry.example.com/team/teaimg:v3' }))).toContain('image')
		expect(codes(svc({ image: 'registry.example.com/team/teaimg:deploy-abc' }))).toContain('image')
		expect(codes(svc({ image: `registry.example.com/team/teaimg@sha256:${'a'.repeat(64)}` }))).toContain('image')
	})
	it('applies the owner rule to digest-pinned refs', () => {
		expect(codes(svc({ image: `ghcr.io/x/teashop@sha256:${'b'.repeat(64)}` }))).toContain('image')
	})
	it('common shapes pass: shared public DB images, own app image under an org', () => {
		const d = `@sha256:${'c'.repeat(64)}`
		const ctx: ComposeGuardContext = {
			...base,
			appName: 'shop',
			otherApps: ['blog', 'wiki'],
			// another project runs the same public DB image: not a build, not foreign
			foreignImages: ['pgvector/pgvector:pg16', 'postgres:17-alpine', 'ghcr.io/acme-org/blog:latest'],
			foreignBuiltImages: ['ghcr.io/acme-org/blog:latest'],
		}
		for (const image of [
			`pgvector/pgvector:pg16${d}`,
			`pgvector/pgvector:pg17${d}`,
			`postgres:17-alpine${d}`,
			`postgres:16${d}`,
			'pgvector/pgvector:pg16',
			'alpine:3.21',
			'ghcr.io/acme-org/shop:latest',
		])
			expect(composeViolations({ name: 'shop', services: { worker: { image } } }, ctx)).toEqual([])
	})
	it('deploy context: built = other apps main images and foreign compose-built images, not shared DB images', () => {
		const input: ComposeCheckInput = {
			resolved: {},
			raw: null,
			hash: 'x',
			containers: [],
			details: [
				{ name: 'blog', project: 'blog', image: 'ghcr.io/acme-org/blog:latest', imageId: 'sha256:p', ports: [{ hostIp: '127.0.0.1', port: 3016, protocol: 'tcp' }] },
				// a public image is digest-pinned (or run by two other projects)
				{ name: 'blog-db', project: 'blog', image: `pgvector/pgvector:pg16@sha256:${'e'.repeat(64)}`, imageId: 'sha256:pg', ports: [] },
				{ name: 'blog-render', project: 'blog', image: 'blog-render:latest', imageId: 'sha256:r', ports: [] },
				{ name: 'shop', project: 'shop', image: 'ghcr.io/acme-org/shop:latest', imageId: 'sha256:c', ports: [{ hostIp: '127.0.0.1', port: 3000, protocol: 'tcp' }] },
				{ name: 'shop-powder-bridge', project: '', image: 'ghcr.io/acme-org/shop:latest', imageId: 'sha256:c', ports: [{ hostIp: '127.0.0.1', port: 3001, protocol: 'tcp' }] },
			],
			imageProjects: { 'sha256:p': '', 'sha256:pg': '', 'sha256:r': 'blog', 'sha256:c': 'shop' },
		}
		const ctx = deployGuardContext(input, {
			appName: 'shop',
			workingDir: '/opt/apps/shop',
			composeFiles: ['/opt/apps/shop/docker-compose.yml'],
			serverId: 'server',
			routeHosts: null,
			otherApps: ['blog'],
		})
		expect(ctx.foreignBuiltImages?.sort()).toEqual(['blog-render:latest', 'ghcr.io/acme-org/blog:latest'])
		expect(ctx.foreignPorts).toEqual([{ hostIp: '127.0.0.1', port: 3016, protocol: 'tcp', owner: 'blog' }])
	})
	it('parses the detail and image probe sections', () => {
		const d = parseDetailProbe(
			'/blog\tblog\tghcr.io/a/blog:latest\tsha256:p\t{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"3016"}]}\n/x\t\talpine\tsha256:a\tnull\n',
		)
		expect(d[0]).toEqual({ name: 'blog', project: 'blog', image: 'ghcr.io/a/blog:latest', imageId: 'sha256:p', ports: [{ hostIp: '127.0.0.1', port: 3016, protocol: 'tcp' }] })
		expect(d[1]?.ports).toEqual([])
		expect(parseImageProbe('sha256:r\t{"Labels":{"com.docker.compose.project":"blog"}}\nsha256:p\t{"Cmd":["x"]}\nsha256:q\tnull\n')).toEqual({
			'sha256:r': 'blog',
			'sha256:p': '',
			'sha256:q': '',
		})
		const sep = '\n__POWDER_CG_SEP__\n'
		const out = parseComposeProbe(['h', '{}', '{}', '', '', '', '/a\tp\ti\tsha256:1\t{}', 'sha256:1\tnull'].join(sep))
		expect(out?.details?.[0]?.name).toBe('a')
		expect(out?.imageProjects).toEqual({ 'sha256:1': '' })
		// an older 6-section probe still parses, without details
		expect(parseComposeProbe(['h', '{}', '{}', '', '', ''].join(sep))?.details).toBeUndefined()
	})
})

describe('network addresses', () => {
	it('refuses ipam config, enable_ipv6, fixed addresses, per-network driver_opts and mac_address', () => {
		expect(
			codes({
				name: 'mallory',
				services: { mallory: { image: 'nginx', networks: { hj: { ipv4_address: '198.51.100.1' } } } },
				networks: { hj: { driver: 'bridge', ipam: { driver: 'default', config: [{ subnet: '198.51.100.0/24', gateway: '198.51.100.254' }] } } },
			}),
		).toEqual(['network_address', 'network_address'])
		expect(codes(svc({}, { networks: { n6: { enable_ipv6: true } } }))).toEqual(['network_address'])
		for (const k of ['ipv4_address', 'ipv6_address', 'link_local_ips', 'mac_address', 'driver_opts'])
			expect(codes(svc({ networks: { default: { [k]: k === 'driver_opts' ? { a: 'b' } : 'x' } } }))).toEqual(['network_address'])
		expect(codes(svc({ mac_address: '02:42:ac:11:00:02' }))).toEqual(['network_address'])
	})
	it('passes ipam driver default with no config, aliases and priority', () => {
		expect(codes(svc({ networks: { n: { aliases: ['mallory-api'], priority: 10 } } }, { networks: { n: { ipam: { driver: 'default' } } } }))).toEqual([])
		expect(codes(svc({}, { networks: { n: { ipam: {} , enable_ipv6: false } } }))).toEqual([])
	})
})

describe('names on shared networks, any state', () => {
	const web = { networks: { web: { external: true, name: 'web' } } }
	it('refuses an alias that is a registered app, its -db or a stopped container of another project', () => {
		for (const alias of ['teashop', 'web-app-db', 'web-app'])
			expect(codes(svc({ networks: { web: { aliases: [alias] } } }, web))).toContain('network_alias')
		const ctx = { ...base, foreignContainers: [...(base.foreignContainers ?? []), 'stopped-sidecar'] }
		expect(codes(svc({ networks: { web: { aliases: ['stopped-sidecar'] } } }, web), ctx)).toContain('network_alias')
	})
	it('refuses a service key that is a registered app on a shared or external network', () => {
		expect(codes({ name: 'mallory', services: { teashop: { image: 'nginx', networks: ['web'] } }, networks: { web: { external: true } } })).toContain('service_key')
		expect(codes({ name: 'mallory', services: { teashop: { image: 'nginx', networks: ['ext'] } }, networks: { ext: { external: true, name: 'mallory-ext' } } })).toContain('service_key')
	})
	it('external (non-shared) networks: any-state names only, no powder-name or service-key ambiguity', () => {
		const ext = { networks: { lan: { external: true, name: 'mallory_lan' } } }
		// own external network, alias postgres: the powder-name check is for shared networks only
		expect(codes(svc({ networks: { lan: { aliases: ['postgres'] } } }, ext))).toEqual([])
		// N projects each with a service `db` on one external network
		const ctx: ComposeGuardContext = { ...base, foreignNamesByNetwork: { mallory_lan: ['db', 'app'] } }
		expect(composeViolations({ name: 'mallory', services: { db: { image: 'postgres:16', networks: ['lan'] }, app: { image: 'nginx', networks: ['lan'] } }, ...ext }, ctx)).toEqual([])
		// registered app, <other>-db, a stopped other container: refused, case-insensitively
		const stopped = { ...base, foreignContainers: [...(base.foreignContainers ?? []), 'old-worker'] }
		for (const n of ['teashop', 'TeaShop', 'web-app-db', 'old-worker', 'OLD-WORKER']) {
			expect(codes(svc({ networks: { lan: { aliases: [n] } } }, ext), stopped)).toContain('network_alias')
			expect(codes({ name: 'mallory', services: { [n]: { image: 'nginx', networks: ['lan'] } }, ...ext }, stopped)).toContain('service_key')
		}
	})
	it('common shapes pass: own app name alias on an external network, an unregistered name on infra, own network aliases', () => {
		const ctx: ComposeGuardContext = { appName: 'clubapp', otherApps: [], foreignContainers: [], foreignNamesByNetwork: {}, resolved: true }
		expect(composeViolations({ name: 'clubapp', services: { db: { image: 'postgres:17-alpine', networks: { pg: { aliases: ['clubapp'] } } } }, networks: { pg: { external: true, name: 'postgres' } } }, { ...ctx, exempt: ['network'] })).toEqual([])
		const ctx2: ComposeGuardContext = { appName: 'mktapp', otherApps: [], foreignContainers: ['traefik', 'mktapp-feeds-proxy'], foreignNamesByNetwork: { infra: ['traefik'] }, resolved: true }
		expect(composeViolations({ name: 'mktapp', services: { db: { image: 'alpine:3.21', networks: { infra: { aliases: ['oldname-db'] } } } }, networks: { infra: { external: true, name: 'infra' } } }, ctx2)).toEqual([])
		expect(codes(svc({ networks: { own: { aliases: ['teashop'] } } }, { networks: { own: {} } }))).toEqual([])
	})
})

describe('host ports', () => {
	const ctx: ComposeGuardContext = { ...base, foreignPorts: [{ hostIp: '127.0.0.1', port: 3016, protocol: 'tcp', owner: 'teashop' }] }
	it('refuses 22, 80, 443 and a port another project publishes (any state)', () => {
		expect(codes(svc({ ports: ['127.0.0.1:3016:80'] }), ctx)).toEqual(['ports'])
		expect(codes(svc({ ports: ['3016:80'] }), ctx)).toEqual(['ports'])
		expect(codes(svc({ ports: [{ target: 80, published: '3010-3020', host_ip: '0.0.0.0', protocol: 'tcp' }] }), ctx)).toEqual(['ports'])
		for (const p of ['443:443', '127.0.0.1:80:80', '22:22', '[::1]:443:8443'])
			expect(codes(svc({ ports: [p] }), ctx)).toEqual(['ports'])
	})
	it('passes the common shape: distinct 127.0.0.1 ports, another protocol or address, container-only ports', () => {
		expect(codes(svc({ ports: ['127.0.0.1:3017:3000'] }), ctx)).toEqual([])
		expect(codes(svc({ ports: [{ target: 3000, published: '3017', host_ip: '127.0.0.1', protocol: 'tcp', mode: 'ingress' }] }), ctx)).toEqual([])
		expect(codes(svc({ ports: ['127.0.0.2:3016:3000', '127.0.0.1:3016:3000/udp', '3000', 3000] }), ctx)).toEqual([])
	})
	it('parses the short and long forms', () => {
		expect(publishedPorts('127.0.0.1:3016:3000')).toEqual({ hostIp: '127.0.0.1', from: 3016, to: 3016, protocol: 'tcp' })
		expect(publishedPorts('8000-8010:8000-8010/udp')).toEqual({ hostIp: '', from: 8000, to: 8010, protocol: 'udp' })
		expect(publishedPorts('3000')).toBeNull()
		expect(publishedPorts('127.0.0.1::3000')).toBeNull()
		expect(publishedPorts('a:b:c:d')).toBe('bad')
	})
})

describe('local build caches', () => {
	it('refuses every local cache entry, any case, and any src= / dest= key', () => {
		for (const e of ['type=local,src=./x,dest=/etc/cron.d', 'type=local,src=./cache', 'TYPE=local,DEST=/etc/x', 'type=LOCAL,dest=./c', ' Type = Local ,src=./c', 'dest=/etc/x', 'ref=x/y,SRC=/etc'])
			expect(codes(svc({ build: { context: '.', cache_to: [e] }, image: 'mallory' })), e).toContain('build')
		// every cache_from / cache_to is refused now (root's registry logins)
		expect(codes(svc({ build: { context: '.', cache_from: ['type=registry,ref=x/y', 'x/y:cache', 'type=gha'] }, image: 'mallory' }))).toEqual(['build', 'build', 'build'])
		expect(codes(svc({ build: { context: '.', cache_from: [{ type: 'local' }] }, image: 'mallory' }))).toContain('build')
	})
})

describe('DoS keys', () => {
	it('refuses rtprio / nice / unlimited ulimits, negative oom_score_adj, oom_kill_disable, unlimited pids', () => {
		expect(codes(svc({ ulimits: { rtprio: 99 } }))).toEqual(['ulimits'])
		expect(codes(svc({ ulimits: { nice: -20 } }))).toEqual(['ulimits'])
		expect(codes(svc({ ulimits: { memlock: -1 } }))).toEqual(['ulimits'])
		expect(codes(svc({ ulimits: { nofile: { soft: 1024, hard: -1 } } }))).toEqual(['ulimits'])
		expect(codes(svc({ oom_score_adj: -1000 }))).toEqual(['oom'])
		expect(codes(svc({ oom_kill_disable: true }))).toEqual(['oom'])
		expect(codes(svc({ pids_limit: -1 }))).toEqual(['pids_limit'])
		expect(codes(svc({ pids_limit: 0 }))).toEqual(['pids_limit'])
		expect(codes(svc({ deploy: { resources: { limits: { pids: -1 } } } }))).toEqual(['pids_limit'])
	})
	it('passes bounded ulimits, a positive oom score and pids_limit 256', () => {
		expect(codes(svc({ ulimits: { nofile: { soft: 65536, hard: 65536 }, nproc: 4096, core: 0 }, oom_score_adj: 500, oom_kill_disable: false, pids_limit: 256 }))).toEqual([])
	})
})

describe('forwardAuth and annotations', () => {
	it('refuses a forwardAuth middleware address', () => {
		expect(
			codes(svc({ labels: { 'traefik.http.middlewares.mallory-a.forwardauth.address': 'http://powder:3000/api/admin', 'traefik.http.routers.mallory.middlewares': 'mallory-a' } })),
		).toEqual(['traefik_url'])
	})
	it('refuses annotations', () => {
		expect(codes(svc({ annotations: { 'run.oci.keep_original_groups': '1' } }))).toEqual(['annotations'])
	})
})
