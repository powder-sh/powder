import { describe, expect, it, vi } from 'vitest'
import { parse, parseDocument } from 'yaml'

vi.mock('../ssh', () => ({ runCommand: vi.fn() }))

import { runCommand } from '../ssh'
import {
	assertTraefikFileProvider,
	checkFileProviderFromInspect,
	detectProxyKind,
	fileProviderFromYml,
	renderTraefikRedirects,
	traefikRedirectFile,
} from '../domain-redirects'

describe('detectProxyKind', () => {
	it('returns traefik when servers.proxy is traefik, whatever the id', () => {
		expect(detectProxyKind({ id: 'server-a', proxy: 'traefik' })).toBe('traefik')
		expect(detectProxyKind({ id: 'server-a', proxy: 'traefik' })).toBe('traefik')
	})
	it('keeps the nginx kinds', () => {
		expect(detectProxyKind({ id: 'server-a', proxy: 'nginx' })).toBe('nginx-host')
		expect(detectProxyKind({ id: 'server-a' })).toBe('unknown')
	})
	it("servers.proxy = 'nginx-container' is containerised nginx", () => {
		expect(detectProxyKind({ id: 'server-b', proxy: 'nginx-container' })).toBe('nginx-container')
		expect(detectProxyKind({ id: 'server-a', proxy: 'nginx' })).toBe('nginx-host')
		expect(detectProxyKind({ id: 'server-b', proxy: 'traefik' })).toBe('traefik')
	})
})

// the render, or a failed test when it renders nothing
function redirectsYaml(...a: Parameters<typeof renderTraefikRedirects>): string {
	const y = renderTraefikRedirects(...a)
	if (y === null) throw new Error('renderTraefikRedirects rendered nothing')
	return y
}

describe('renderTraefikRedirects', () => {
	it('file path is per app under the dynamic dir', () => {
		expect(traefikRedirectFile('widgets')).toBe('/opt/infra/traefik/dynamic/redirects-widgets.yml')
	})

	it('renders www -> apex with certresolver on acme', () => {
		const yml = renderTraefikRedirects('shop', [{ hostname: 'example.com', wwwMode: 'apex', custom: [] }])
		expect(yml).toBe(
			[
				'# Managed by Powder. Edits will be overwritten.',
				'# hostname=example.com wwwMode=apex',
				'http:',
				'  middlewares:',
				'    redir-shop-example-com-www:',
				'      redirectRegex:',
				"        regex: '^https?://www\\.example\\.com(.*)'",
				"        replacement: 'https://example.com${1}'",
				'        permanent: true',
				'  routers:',
				'    redir-shop-example-com-www:',
				"      rule: 'Host(`www.example.com`)'",
				'      entryPoints: [websecure]',
				'      priority: 300',
				'      middlewares: [redir-shop-example-com-www]',
				'      service: noop@internal',
				'      tls: { certResolver: le }',
				'',
			].join('\n'),
		)
	})

	it('uses tls: {} on origin-cert servers', () => {
		const yml = redirectsYaml(
			'shop',
			[{ hostname: 'example.com', wwwMode: 'www', custom: [] }],
			'origin-cert',
		)
		expect(yml).toContain('tls: {}')
		expect(yml).not.toContain('certResolver')
		expect(yml).toContain("rule: 'Host(`example.com`)'")
		expect(yml).toContain("replacement: 'https://www.example.com${1}'")
	})

	it('renders custom path redirects with exact match, status and host-relative targets', () => {
		const yml = redirectsYaml('shop', [
			{
				hostname: 'example.com',
				wwwMode: 'none',
				custom: [
					{ from: '/old', to: '/new' },
					{ from: '/tmp', to: 'https://other.test/x', status: 302 },
				],
			},
		])
		expect(yml).toContain("rule: 'Host(`example.com`) && Path(`/old`)'")
		expect(yml).toContain("regex: '^https?://example\\.com/old(\\?.*)?$'")
		expect(yml).toContain("replacement: 'https://example.com/new'")
		expect(yml).toContain("replacement: 'https://other.test/x'")
		expect(yml).toMatch(/redir-shop-example-com-c2:\n {6}redirectRegex:\n.*\n.*\n {8}permanent: false/)
		expect(yml.match(/priority: 300/g)).toHaveLength(2)
	})

	it('puts several hostnames of one app in one fragment', () => {
		const yml = redirectsYaml('shop', [
			{ hostname: 'a.com', wwwMode: 'apex', custom: [] },
			{ hostname: 'b.com', wwwMode: 'apex', custom: [] },
		])
		expect(yml).toContain('redir-shop-a-com-www')
		expect(yml).toContain('redir-shop-b-com-www')
		expect(yml.match(/^http:$/gm)).toHaveLength(1)
	})

	it('output is valid YAML with a router and middleware per redirect', () => {
		const yml = redirectsYaml('shop', [
			{ hostname: 'a.com', wwwMode: 'apex', custom: [{ from: '/x', to: '/y' }] },
		])
		const doc = parse(yml) as {
			http: {
				middlewares: Record<string, { redirectRegex: { regex: string; permanent: boolean } }>
				routers: Record<string, { priority: number; service: string; entryPoints: string[] }>
			}
		}
		expect(Object.keys(doc.http.middlewares)).toEqual(Object.keys(doc.http.routers))
		expect(Object.keys(doc.http.routers)).toHaveLength(2)
		for (const r of Object.values(doc.http.routers)) {
			expect(r.priority).toBe(300)
			expect(r.service).toBe('noop@internal')
			expect(r.entryPoints).toEqual(['websecure'])
		}
	})

	it('returns null when nothing redirects (caller removes the file)', () => {
		expect(renderTraefikRedirects('shop', [{ hostname: 'a.com', wwwMode: 'none', custom: [] }])).toBeNull()
		expect(renderTraefikRedirects('shop', [])).toBeNull()
	})

	it('rejects unsafe paths and hostnames', () => {
		expect(() =>
			renderTraefikRedirects('shop', [
				{ hostname: 'a.com', wwwMode: 'none', custom: [{ from: '/a`b', to: '/x' }] },
			]),
		).toThrow(/unsafe/)
		expect(() =>
			renderTraefikRedirects('shop', [{ hostname: 'a.com`)||Host(`b', wwwMode: 'apex', custom: [] }]),
		).toThrow(/unsafe/)
	})

	it('escapes $ in targets so Traefik does not expand them', () => {
		const yml = redirectsYaml('shop', [
			{ hostname: 'a.com', wwwMode: 'none', custom: [{ from: '/x', to: 'https://o.test/$1' }] },
		])
		expect(yml).toContain("replacement: 'https://o.test/$$1'")
	})
})

describe('renderTraefikRedirects unique keys', () => {
	it('apex and www rows of the same site, with customs on both, have unique keys', () => {
		const yml = redirectsYaml('shop', [
			{ hostname: 'x.com', wwwMode: 'apex', custom: [{ from: '/a', to: '/b' }] },
			{ hostname: 'www.x.com', wwwMode: 'apex', custom: [{ from: '/a', to: '/c' }] },
		])
		const doc = parseDocument(yml, { uniqueKeys: true })
		expect(doc.errors).toEqual([])
		const j = doc.toJS() as { http: { middlewares: object; routers: object } }
		expect(Object.keys(j.http.routers)).toHaveLength(4)
		expect(Object.keys(j.http.middlewares)).toEqual(Object.keys(j.http.routers))
	})
})

const DIR = '/opt/infra/traefik/dynamic'
const cliInspect = (args: string[], mounts = [{ Source: DIR, Destination: '/etc/traefik/dynamic' }]) => ({
	Args: args,
	Config: { Cmd: null, Entrypoint: ['/entrypoint.sh'] },
	Mounts: mounts,
})

describe('checkFileProviderFromInspect', () => {
	it('ok with CLI flags and the dir mounted', () => {
		expect(
			checkFileProviderFromInspect(
				cliInspect(['--providers.file.directory=/etc/traefik/dynamic', '--providers.file.watch=true']),
			),
		).toEqual({ state: 'ok' })
	})
	it('accepts a bare --providers.file.watch', () => {
		expect(
			checkFileProviderFromInspect(
				cliInspect(['--providers.file.directory=/etc/traefik/dynamic', '--providers.file.watch']),
			).state,
		).toBe('ok')
	})
	it('fails without watch, with watch=false, unmounted, or mounted from another dir', () => {
		const dir = '--providers.file.directory=/etc/traefik/dynamic'
		expect(checkFileProviderFromInspect(cliInspect([dir])).state).toBe('fail')
		expect(checkFileProviderFromInspect(cliInspect([dir, '--providers.file.watch=false'])).state).toBe('fail')
		expect(checkFileProviderFromInspect(cliInspect([dir, '--providers.file.watch=true'], [])).state).toBe('fail')
		expect(
			checkFileProviderFromInspect(
				cliInspect([dir, '--providers.file.watch=true'], [{ Source: '/srv/other', Destination: '/etc/traefik/dynamic' }]),
			).state,
		).toBe('fail')
	})
	it('docker-provider-only traefik (docker-provider shape) fails', () => {
		expect(
			checkFileProviderFromInspect(
				cliInspect(['--providers.docker=true', '--entrypoints.websecure.address=:443'], [
					{ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
				]),
			).state,
		).toBe('fail')
	})
	it('traefik.yml shape: asks for the mounted config, then reads providers.file', () => {
		const inspect = {
			Args: [],
			Mounts: [
				{ Source: '/opt/infra/traefik/traefik.yml', Destination: '/etc/traefik/traefik.yml' },
				{ Source: DIR, Destination: '/etc/traefik/dynamic' },
			],
		}
		const c = checkFileProviderFromInspect(inspect)
		expect(c).toEqual({ state: 'need-config', configHostPath: '/opt/infra/traefik/traefik.yml' })
		const yml = 'providers:\n  docker: {}\n  file:\n    directory: /etc/traefik/dynamic\n    watch: true\n'
		expect(fileProviderFromYml(yml, inspect)).toBe(true)
		expect(fileProviderFromYml(yml.replace('watch: true', 'watch: false'), inspect)).toBe(false)
		expect(fileProviderFromYml('providers:\n  docker: {}\n', inspect)).toBe(false)
		expect(fileProviderFromYml(yml.replace('/etc/traefik/dynamic', '/nowhere'), inspect)).toBe(false)
	})
	it('honours --configFile', () => {
		const c = checkFileProviderFromInspect({
			Args: ['--configFile=/cfg/t.yml'],
			Mounts: [{ Source: '/opt/cfg', Destination: '/cfg' }],
		})
		expect(c).toEqual({ state: 'need-config', configHostPath: '/opt/cfg/t.yml' })
	})
})

describe('assertTraefikFileProvider', () => {
	const server = { id: 'server-a', name: 'server-a', host: 'h', user: 'root', port: 22, kind: 'compose' as const }
	const run = vi.mocked(runCommand)
	it('throws the explicit error when traefik has no file provider', async () => {
		run.mockResolvedValueOnce({
			code: 0,
			stderr: '',
			stdout: JSON.stringify([cliInspect(['--providers.docker=true'], [])]),
		} as never)
		await expect(assertTraefikFileProvider(server)).rejects.toThrow(
			'Traefik on server-a has no file provider for /opt/infra/traefik/dynamic (add providers.file.directory + watch and mount it)',
		)
	})
	it('throws when the container is missing', async () => {
		run.mockResolvedValueOnce({ code: 1, stderr: 'No such object', stdout: '' } as never)
		await expect(assertTraefikFileProvider(server)).rejects.toThrow(/no file provider/)
	})
	it('passes for CLI flags and for a mounted traefik.yml', async () => {
		run.mockResolvedValueOnce({
			code: 0,
			stderr: '',
			stdout: JSON.stringify([
				cliInspect(['--providers.file.directory=/etc/traefik/dynamic', '--providers.file.watch=true']),
			]),
		} as never)
		await expect(assertTraefikFileProvider(server)).resolves.toBeUndefined()
		run.mockResolvedValueOnce({
			code: 0,
			stderr: '',
			stdout: JSON.stringify([
				{
					Mounts: [
						{ Source: '/opt/infra/traefik/traefik.yml', Destination: '/etc/traefik/traefik.yml' },
						{ Source: DIR, Destination: '/etc/traefik/dynamic' },
					],
				},
			]),
		} as never)
		run.mockResolvedValueOnce({
			code: 0,
			stderr: '',
			stdout: 'providers:\n  file:\n    directory: /etc/traefik/dynamic\n    watch: true\n',
		} as never)
		await expect(assertTraefikFileProvider(server)).resolves.toBeUndefined()
	})
})
