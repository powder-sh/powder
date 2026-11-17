// One TLS rule for every Traefik router powder writes (lib/traefik-tls.ts):
// acme -> resolver le, origin-cert -> tls=true / tls: {}. The renderers of the
// /new compose, the app domain labels, previews and file-provider redirects all
// follow servers.tls_mode, and no other file spells the label out.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { renderLabelsBlock } from '../app-domains'
import { renderComposeYaml } from '../compose-render'
import { renderTraefikRedirects } from '../domain-redirects'
import { renderPreviewCompose } from '../preview-deploys'
import { traefikFileRouterTls, traefikRouterTlsLabel } from '../traefik-tls'

const modes = ['acme', 'origin-cert'] as const
const expected = (router: string, mode: (typeof modes)[number]) =>
	mode === 'origin-cert' ? `traefik.http.routers.${router}.tls=true` : `traefik.http.routers.${router}.tls.certresolver=le`

describe('traefik TLS labels', () => {
	it('the helper', () => {
		expect(traefikRouterTlsLabel('shop', 'acme')).toBe('traefik.http.routers.shop.tls.certresolver=le')
		expect(traefikRouterTlsLabel('shop', undefined)).toBe('traefik.http.routers.shop.tls.certresolver=le')
		expect(traefikRouterTlsLabel('shop', 'origin-cert')).toBe('traefik.http.routers.shop.tls=true')
		expect(traefikFileRouterTls('acme')).toBe('{ certResolver: le }')
		expect(traefikFileRouterTls('origin-cert')).toBe('{}')
	})

	for (const mode of modes) {
		it(`${mode}: every renderer uses the same label`, () => {
			const compose = renderComposeYaml({
				name: 'shop',
				dockerfilePath: './Dockerfile',
				hostPort: null,
				containerPort: 3000,
				envFilePath: '/opt/apps/shop.env',
				publicHost: 'shop.apps.example.com',
				traefik: true,
				tlsMode: mode,
				postgres: null,
				kv: null,
			})
			const labels = renderLabelsBlock({
				containerName: 'shop',
				hosts: ['shop.example.com'],
				containerPort: 3000,
				redirects: { redirects: [], rewrites: [], headers: {} } as never,
				tlsMode: mode,
			})
			const preview = renderPreviewCompose({
				name: 'pv-shop-x',
				dockerfilePath: './Dockerfile',
				containerPort: 3000,
				envFiles: ['/opt/apps/shop.preview.env'],
				host: 'pv-shop-x.apps.example.com',
				tlsMode: mode,
			})
			for (const [text, router] of [
				[compose, 'shop'],
				[labels, 'shop'],
				[preview, 'pv-shop-x'],
			] as const) {
				expect(text).toContain(`- ${expected(router, mode)}\n`)
				expect(text).not.toContain(mode === 'origin-cert' ? 'certresolver' : '.tls=true')
			}
			const redirects = renderTraefikRedirects('shop', [{ hostname: 'example.com', wwwMode: 'apex', custom: [] }], mode)
			expect(redirects).toContain(`tls: ${traefikFileRouterTls(mode)}`)
		})
	}

	it('no other source file spells out a router TLS setting', () => {
		const src = join(__dirname, '../..')
		const walk = (dir: string): string[] =>
			readdirSync(dir).flatMap((n) => {
				const p = join(dir, n)
				if (statSync(p).isDirectory()) return n === '__tests__' ? [] : walk(p)
				return /\.tsx?$/.test(n) ? [p] : []
			})
		const offenders = walk(src)
			.filter((f) => /certresolver=le|certResolver: le|\.tls=true`/.test(readFileSync(f, 'utf8')))
			.map((f) => relative(src, f))
		expect(offenders).toEqual(['lib/traefik-tls.ts'])
	})
})
