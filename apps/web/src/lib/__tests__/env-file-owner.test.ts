// who owns /opt/apps/<owner>.env. A container_name is the compose's to
// choose, so naming a sidecar after another app (`shop.preview`, `shop.db`) must not
// make that app's env file readable. Own forms (`<app>.db.env`, `<app>-db.env`, a
// sidecar no registered app claims) keep passing.
import { describe, expect, it } from 'vitest'
import {
	type ComposeGuardContext,
	composeViolations,
	envFileOwnerAllowed,
	registeredOwnerOf,
} from '../compose-safety'

function ctxFor(appName: string, otherApps: string[]): ComposeGuardContext {
	return {
		appName,
		projectDir: `/opt/apps/${appName}`,
		otherApps,
		foreignContainers: [],
		ownProjectContainers: [appName],
		resolved: true,
	}
}

function cfg(app: string, extra: Record<string, unknown>) {
	return {
		name: app,
		services: {
			[app]: { image: `${app}:latest`, container_name: app, env_file: [`/opt/apps/${app}.env`] },
			...extra,
		},
	}
}

const codes = (v: { code: string }[]) => v.map((x) => x.code)

describe('env_file owner', () => {
	const evil = ctxFor('evil', ['shop', 'shop-api', 'pv-shop-feat-1a2b3c'])

	it('refuses another app env file through a made-up container_name (shop.preview)', () => {
		const v = composeViolations(
			cfg('evil', {
				x: {
					image: 'alpine:3',
					container_name: 'shop.preview',
					env_file: [{ path: '/opt/apps/shop.preview.env', required: true }],
				},
			}),
			evil,
		)
		expect(codes(v)).toContain('env_file')
		expect(codes(v)).toContain('container_name')
	})

	it('refuses shop.db, shop_x and shop-x through container_name', () => {
		for (const name of ['shop.db', 'shop_x', 'shop-x', 'shop-api.y', 'pv-shop-feat-1a2b3c.z']) {
			const v = composeViolations(
				cfg('evil', {
					y: { image: 'alpine:3', container_name: name, env_file: [`/opt/apps/${name}.env`] },
				}),
				evil,
			)
			expect(v.filter((x) => x.code === 'env_file').length, name).toBe(1)
		}
	})

	it('refuses the bare other-app env file and a preview env file of another app', () => {
		for (const p of [
			'/opt/apps/shop.env',
			'/opt/apps/shop.preview.env',
			'/opt/apps/pv-shop-feat-1a2b3c.env',
		]) {
			const v = composeViolations(cfg('evil', { y: { image: 'alpine:3', env_file: [p] } }), evil)
			expect(codes(v), p).toContain('env_file')
		}
	})

	it('container_name refuses <other>.<x> and <other>_<x>, keeps <other>-<x> free', () => {
		const cn = (name: string) =>
			codes(
				composeViolations(cfg('evil', { y: { image: 'alpine:3', container_name: name } }), evil),
			)
		expect(cn('shop.preview')).toContain('container_name')
		expect(cn('shop_worker')).toContain('container_name')
		expect(cn('pv-shop-feat-1a2b3c.x')).toContain('container_name')
		expect(cn('shop-sidecar')).not.toContain('container_name')
		expect(cn('evil.worker')).not.toContain('container_name')
	})

	it('own forms pass: <app>.db.env, <app>-db.env, a sidecar no app claims', () => {
		// the sidecar already runs in this project (its env file exists on the server)
		const own = { ...ctxFor('acme', ['acme-api', 'beta']), ownProjectContainers: ['acme', 'paint-renderer'] }
		const ok = composeViolations(
			cfg('acme', {
				db: {
					image: 'postgres:16',
					container_name: 'acme-db',
					env_file: ['/opt/apps/acme.db.env'],
				},
				db2: {
					image: 'postgres:16',
					container_name: 'acme-db2',
					env_file: ['/opt/apps/acme-db.env'],
				},
				r: {
					image: 'alpine:3',
					container_name: 'acme-renderer',
					env_file: ['/opt/apps/acme-renderer.env'],
				},
				s: {
					image: 'alpine:3',
					container_name: 'paint-renderer',
					env_file: ['/opt/apps/paint-renderer.env'],
				},
				t: {
					image: 'alpine:3',
					container_name: 'acme_tool',
					env_file: ['/opt/apps/acme_tool.env'],
				},
			}),
			own,
		)
		expect(ok.filter((x) => x.code === 'env_file' || x.code === 'container_name')).toEqual([])
	})

	it("a longer registered app wins: acme-api.env is not acme's", () => {
		const own = ctxFor('acme', ['acme-api'])
		const v = composeViolations(
			cfg('acme', {
				y: { image: 'alpine:3', container_name: 'acme-api', env_file: ['/opt/apps/acme-api.env'] },
			}),
			own,
		)
		expect(codes(v)).toContain('env_file')
		expect(envFileOwnerAllowed('acme-api-x', own, new Set(['acme-api-x']))).toBe(false)
		expect(envFileOwnerAllowed('acme-x', own, new Set())).toBe(true)
	})

	it('the app that owns the longer name keeps its own forms', () => {
		const api = ctxFor('acme-api', ['acme'])
		expect(envFileOwnerAllowed('acme-api.db', api, new Set())).toBe(true)
		expect(envFileOwnerAllowed('acme-api_x', api, new Set())).toBe(true)
		expect(envFileOwnerAllowed('acme.db', api, new Set(['acme.db']))).toBe(false)
		expect(envFileOwnerAllowed('acme', api, new Set(['acme']))).toBe(false)
	})

	it('registeredOwnerOf picks the longest name', () => {
		const c = { appName: 'a', otherApps: ['a-b', 'a-b-c'] }
		expect(registeredOwnerOf('a-b-c.x', c)).toBe('a-b-c')
		expect(registeredOwnerOf('a-b.x', c)).toBe('a-b')
		expect(registeredOwnerOf('a.x', c)).toBe('a')
		expect(registeredOwnerOf('ab', c)).toBeUndefined()
	})

	it('common shapes (invented names) keep passing', () => {
		// <app>.db.env from the app container and from a db sidecar
		const a = ctxFor('lark', ['lark-two', 'other'])
		expect(
			codes(
				composeViolations(
					cfg('lark', {
						db: {
							image: 'postgres:16',
							container_name: 'lark-db',
							env_file: ['/opt/apps/lark.db.env'],
						},
						app2: {
							image: 'alpine:3',
							container_name: 'lark-db2',
							env_file: ['/opt/apps/lark-db.env'],
						},
					}),
					a,
				),
			),
		).not.toContain('env_file')
		// a monorepo sidecar named after no registered app (api-new + com registered nearby)
		// the renderer runs in kite-api-new's own project (the common shape)
		const b = { ...ctxFor('kite-api-new', ['kite-com', 'kite-app-new']), ownProjectContainers: ['kite-api-new', 'kite-renderer'] }
		expect(
			codes(
				composeViolations(
					cfg('kite-api-new', {
						r: {
							image: 'alpine:3',
							container_name: 'kite-renderer',
							env_file: ['/opt/apps/kite-renderer.env'],
						},
					}),
					b,
				),
			),
		).not.toContain('env_file')
		// a shared env file named after nothing in the compose stays a finding (as before)
		expect(
			codes(
				composeViolations(
					cfg('lark', { x: { image: 'a:1', env_file: ['/opt/apps/hub-ingest.env'] } }),
					a,
				),
			),
		).toContain('env_file')
	})

	it('extraEnvFiles still pass (preview override file)', () => {
		const pv = {
			...ctxFor('pv-acme-feat-1a2b3c', []),
			extraEnvFiles: ['/opt/apps/acme.preview.env'],
		}
		const v = composeViolations(
			{
				name: 'pv-acme-feat-1a2b3c',
				services: {
					'pv-acme-feat-1a2b3c': {
						image: 'x:latest',
						container_name: 'pv-acme-feat-1a2b3c',
						env_file: ['/opt/apps/acme.preview.env'],
					},
				},
			},
			pv,
		)
		expect(codes(v)).not.toContain('env_file')
	})
})
