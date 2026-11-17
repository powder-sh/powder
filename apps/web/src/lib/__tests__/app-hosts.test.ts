import { describe, expect, it, vi } from 'vitest'
import {
	branchSlug,
	defaultHostFor,
	firstLiveHostByRepo,
	healthPathFor,
	hostForLabel,
	readableBranchSlug,
	previewContainerName,
	previewHostFor,
	resolveBaseDomain,
} from '../app-hosts'
import { bridgeRuleFor, snapshotHost } from '../deploy-snapshots'
import { renderComposeYaml } from '../compose-render'
import { resolveUrl } from '../uptime'
import { resolveCronUrl } from '../cron-scheduler'
import { renderLabelsBlock } from '../app-domains'

vi.mock('../db', () => ({}))
vi.mock('../crypto', () => ({}))
vi.mock('../rate-limit', () => ({}))
vi.mock('../powder-config', () => ({ buildTraefikLabels: () => ({ middlewareLabels: [], middlewareChain: [] }), readPowderConfig: async () => null }))
vi.mock('../ssh', () => ({}))
vi.mock('../servers', () => ({}))
vi.mock('../traefik-servers', () => ({}))
vi.mock('../notifications', () => ({}))

const withBase = { id: 'server', baseDomain: 'apps.example.com' }
const noBase = { id: 'server', baseDomain: null }

describe('app-hosts helper', () => {
	it('defaultHostFor builds <app>.<base_domain>', () => {
		expect(defaultHostFor(withBase, 'blog')).toBe('blog.apps.example.com')
	})
	it('returns null without a base domain', () => {
		expect(defaultHostFor(noBase, 'blog')).toBeNull()
		expect(defaultHostFor({ id: 'server' }, 'blog')).toBeNull()
		expect(previewHostFor(noBase, 'blog', 'feat/x')).toBeNull()
		expect(hostForLabel(noBase, 'x')).toBeNull()
	})
	it('previewHostFor uses the pv- name and branch slug', () => {
		expect(previewHostFor(withBase, 'blog', 'Feat/New Thing')).toBe(
			`${previewContainerName('blog', branchSlug('Feat/New Thing'))}.apps.example.com`,
		)
		expect(previewHostFor(withBase, 'blog', 'feat/x')).toBe(`pv-blog-${branchSlug('feat/x')}.apps.example.com`)
	})
	it('branches that slugify alike get distinct slugs (hash suffix)', () => {
		expect(readableBranchSlug('feat/x')).toBe(readableBranchSlug('feat-x'))
		expect(branchSlug('feat/x')).not.toBe(branchSlug('feat-x'))
		expect(branchSlug('feat/x')).toMatch(/^feat-x-[0-9a-f]{6}$/)
		expect(branchSlug('feat/x')).toBe(branchSlug('feat/x'))
		expect(branchSlug('///')).toMatch(/^b-[0-9a-f]{6}$/)
		expect(previewHostFor(withBase, 'blog', 'feat/x')).not.toBe(previewHostFor(withBase, 'blog', 'feat-x'))
	})
	it('normalises a pasted wildcard', () => {
		expect(resolveBaseDomain('server', '*.Apps.Example.com')).toBe('apps.example.com')
	})
	it('has no per-server fallback: a null column is null for every server', () => {
		expect(resolveBaseDomain('cloud-1', null)).toBeNull()
		expect(resolveBaseDomain('cloud-1', 'own.dev')).toBe('own.dev')
		expect(resolveBaseDomain('server-a', null)).toBeNull()
	})
})

describe('replaced sites, null and set', () => {
	it('snapshot host', () => {
		expect(snapshotHost(withBase, 'blog', 'dep_ABC123')).toBe('dep-abc123-blog.apps.example.com')
		expect(snapshotHost(noBase, 'blog', 'dep_ABC123')).toBeNull()
	})
	it('uptime url: explicit and live domain win, default host needs a base domain', () => {
		const repo = { containerName: 'blog', healthUrl: null }
		expect(resolveUrl(repo, null, withBase)).toBe('https://blog.apps.example.com/')
		expect(resolveUrl(repo, null, noBase)).toBeNull()
		expect(resolveUrl(repo, null, undefined)).toBeNull()
		expect(resolveUrl(repo, 'blog.io', noBase)).toBe('https://blog.io/')
		expect(resolveUrl({ ...repo, healthUrl: 'https://h/x' }, null, noBase)).toBe('https://h/x')
	})
	it('wizard compose: no labels without a host, origin-cert drops the resolver', () => {
		const base = {
			name: 'blog',
			dockerfilePath: './Dockerfile',
			hostPort: null,
			containerPort: 3000,
			envFilePath: '/e',
			postgres: null,
			kv: null,
		}
		expect(renderComposeYaml({ ...base, publicHost: null })).not.toContain('traefik.')
		const acme = renderComposeYaml({ ...base, publicHost: 'blog.apps.example.com' })
		expect(acme).toContain('Host(`blog.apps.example.com`)')
		expect(acme).toContain('tls.certresolver=le')
		const oc = renderComposeYaml({ ...base, publicHost: 'blog.apps.example.com', tlsMode: 'origin-cert' })
		expect(oc).toContain('routers.blog.tls=true')
		expect(oc).not.toContain('certresolver')
	})
})

describe('cron host and labels', () => {
	it('live host pick is the oldest live domain per app, whatever the row order', () => {
		const t = (d: string) => new Date(`2026-01-0${d}T00:00:00Z`)
		const rows = [
			{ appRepoId: 'r1', hostname: 'www.blog.io', createdAt: t('3') },
			{ appRepoId: 'r2', hostname: 'b.io', createdAt: t('2') },
			{ appRepoId: 'r1', hostname: 'blog.io', createdAt: t('1') },
			{ appRepoId: 'r2', hostname: 'a.io', createdAt: t('2') },
		]
		const want = new Map([
			['r1', 'blog.io'],
			['r2', 'a.io'],
		])
		expect(firstLiveHostByRepo(rows)).toEqual(want)
		expect(firstLiveHostByRepo([...rows].reverse())).toEqual(want)
	})
	it('cron url: resolved like uptime (live custom domain, else default host, else error)', () => {
		expect(resolveCronUrl(withBase, 'blog', ['c.io'], '/api/cron/x')).toBe('https://c.io/api/cron/x')
		expect(resolveCronUrl(withBase, 'blog', [], '/api/cron/x')).toBe('https://blog.apps.example.com/api/cron/x')
		expect(resolveCronUrl(noBase, 'blog', ['c.io'], '/a?b=1')).toBe('https://c.io/a?b=1')
		expect(() => resolveCronUrl(noBase, 'blog', [], '/a')).toThrow(/no base domain/)
	})
	it('labels: no hosts routes nothing; origin-cert default host has tls=true', () => {
		const opts = { containerName: 'blog', containerPort: 3000, redirects: { redirects: [], rewrites: [], headers: {} } }
		expect(renderLabelsBlock({ ...opts, hosts: [] })).toContain('traefik.enable=false')
		const oc = renderLabelsBlock({ ...opts, hosts: ['blog.apps.example.com'], tlsMode: 'origin-cert' })
		expect(oc).toContain('routers.blog.tls=true')
		expect(oc).not.toContain('certresolver')
	})
})

describe('health check path', () => {
	const opts = { containerName: 'blog', containerPort: 3000, redirects: { redirects: [], rewrites: [], headers: {} }, hosts: ['a.b.c'] }
	it('uses the path of health_url', () => {
		const out = renderLabelsBlock({ ...opts, healthUrl: 'http://127.0.0.1:3040/api/health' })
		expect(out).toContain('healthcheck.path=/api/health\n')
	})
	it('empty or null emits /', () => {
		expect(renderLabelsBlock({ ...opts, healthUrl: '' })).toContain('healthcheck.path=/\n')
		expect(renderLabelsBlock({ ...opts })).toContain('healthcheck.path=/\n')
	})
	it('strips query and fragment, rejects junk', () => {
		expect(healthPathFor('https://x.io/api/health?a=1#f')).toBe('/api/health')
		expect(healthPathFor('/ready?x=1')).toBe('/ready')
		expect(healthPathFor('not a url')).toBe('/')
		expect(healthPathFor('ftp://x/y')).toBe('/')
	})
	it('wizard compose follows health_url too', () => {
		const y = renderComposeYaml({ name: 'blog', dockerfilePath: './D', hostPort: null, containerPort: 3000, envFilePath: '/e', publicHost: 'h.io', postgres: null, kv: null, healthUrl: 'https://h.io/up' })
		expect(y).toContain('healthcheck.path=/up')
	})
})

describe('rollback bridge, wizard no-host, health path $', () => {
	it('bridge rule is the default host only', () => {
		expect(bridgeRuleFor(withBase, 'blog')).toBe('Host(`blog.apps.example.com`)')
		expect(bridgeRuleFor(noBase, 'blog')).toBeNull()
		expect(bridgeRuleFor(withBase, 'blog')).not.toContain('||')
	})
	it('wizard on a traefik server without a host emits traefik.enable=false', () => {
		const base = { name: 'blog', dockerfilePath: './D', hostPort: null, containerPort: 3000, envFilePath: '/e', postgres: null, kv: null, publicHost: null }
		expect(renderComposeYaml({ ...base, traefik: true })).toContain('traefik.enable=false')
		expect(renderComposeYaml(base)).not.toContain('traefik.')
	})
	it('health path with $ falls back to /', () => {
		expect(healthPathFor('https://x.io/a/${HOME}')).toBe('/')
	})
})
