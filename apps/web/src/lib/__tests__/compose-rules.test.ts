// Compose-safety rules (invented app names).
import { describe, expect, it } from 'vitest'
import { type ComposeGuardContext, MAX_SCALE, composeViolations, localCacheEntry } from '../compose-safety'

const ctx: ComposeGuardContext = {
	appName: 'shop',
	projectDir: '/opt/apps/shop',
	otherApps: ['bank'],
	protectedPaths: [
		'/opt/apps/shop/docker-compose.yml',
		'/opt/apps/shop/.deploy-key',
		'/opt/apps/shop.env',
		'/opt/apps/shop/src/.git',
		'/opt/apps/shop/.git',
	],
}
const doc = (svc: Record<string, unknown>, top: Record<string, unknown> = {}) => ({
	name: 'shop',
	services: { shop: { image: 'shop:latest', ...svc } },
	...top,
})
const found = (d: unknown) => composeViolations(d, ctx).map((v) => `${v.code}: ${v.message}`)
const codes = (d: unknown) => composeViolations(d, ctx).map((v) => v.code)

describe('localCacheEntry', () => {
	it('matches local caches in any case and any src= / dest= key', () => {
		for (const e of ['type=local,dest=/x', 'TYPE=LOCAL', 'Type=Local,Src=./a', '"type=local",dest=/x', 'ref=a/b,DEST=/etc', 'src=/x'])
			expect(localCacheEntry(e), e).toBe(true)
		for (const e of ['type=registry,ref=a/b', 'a/b:cache', 'type=gha,scope=x', 'type=inline', 'type=localx,ref=a/b'])
			expect(localCacheEntry(e), e).toBe(false)
	})
})

describe('Traefik service references', () => {
	const lbl = (labels: Record<string, string>) => found(doc({ labels }))
	it('checks errors.service and any key ending in .service / .services', () => {
		expect(lbl({ 'traefik.http.middlewares.shop-err.errors.service': 'bank' }).join('\n')).toMatch(/traefik_name.*"bank" is not this app's/)
		expect(lbl({ 'traefik.http.middlewares.shop-err.ERRORS.Service': 'bank@docker' }).join('\n')).toMatch(/traefik_name/)
		expect(lbl({ 'traefik.http.middlewares.shop-err.errors.service': 'bank@file' }).join('\n')).toMatch(/traefik_name/)
		expect(lbl({ 'traefik.http.middlewares.shop-err.errors.service': 'bank@consul' }).join('\n')).toMatch(/consul provider/)
		expect(lbl({ 'traefik.http.services.shop-w.weighted.services': 'bank' }).join('\n')).toMatch(/traefik_name/)
		expect(codes(doc({ labels: { 'traefik.http.middlewares.shop-err.errors.service': 'api@internal' } }))).toContain('traefik_internal')
	})
	it('passes own names', () => {
		expect(codes(doc({ labels: { 'traefik.http.middlewares.shop-err.errors.service': 'shop-web@docker', 'traefik.http.middlewares.shop-err.errors.status': '500-599' } }))).toEqual([])
		expect(codes(doc({ labels: { 'traefik.http.routers.shop.service': 'shop' } }))).toEqual([])
	})
})

describe('build extension keys', () => {
	it('refuses build x-bake and every build.x-* key', () => {
		expect(found(doc({ build: { context: '.', 'x-bake': { platforms: ['linux/amd64'] } } })).join('\n')).toContain('build.x-bake is not allowed')
		expect(found(doc({ build: { context: '.', 'x-anything': 1 } })).join('\n')).toContain('build.x-anything is not allowed')
		expect(codes(doc({ build: { context: '.' } }))).toEqual([])
	})
})

describe('top-level secrets / configs files: protected paths', () => {
	const sec = (file: string, kind: 'secrets' | 'configs' = 'secrets') => found(doc({}, { [kind]: { s: { file } } }))
	it('refuses the deploy key, compose files, git metadata and a folder holding them', () => {
		expect(sec('./.deploy-key').join('\n')).toMatch(/^secret: .*protected path \/opt\/apps\/shop\/\.deploy-key/m)
		expect(sec('./docker-compose.yml', 'configs').join('\n')).toMatch(/^config: .*docker-compose\.yml/m)
		expect(sec('./src/.git/config').join('\n')).toMatch(/src\/\.git/)
		expect(sec('./src').join('\n')).toMatch(/src\/\.git/)
		expect(sec('.').join('\n')).toMatch(/protected path/)
	})
	it('passes plain app files and keeps the outside-app finding as it was', () => {
		expect(sec('./secrets/token.txt')).toEqual([])
		expect(sec('/opt/apps/shop/src/config/app.json')).toEqual([])
		expect(sec('/opt/apps/shop.build-env')).toEqual(['secret: secret "s" reads "/opt/apps/shop.build-env", outside the app directory'])
	})
	it('the app own env file inside the app dir stays readable', () => {
		const d = doc({ env_file: ['./.env'] }, { secrets: { e: { file: './.env' } } })
		expect(composeViolations(d, { ...ctx, protectedPaths: [...(ctx.protectedPaths ?? []), '/opt/apps/shop/.env'] }).map((v) => v.code)).toEqual([])
	})
})

describe('scale / deploy.replicas', () => {
	it('caps both at MAX_SCALE', () => {
		expect(MAX_SCALE).toBe(10)
		expect(codes(doc({ scale: 3 }))).toEqual([])
		expect(codes(doc({ deploy: { replicas: 10 } }))).toEqual([])
		expect(codes(doc({ scale: 11 }))).toEqual(['scale'])
		expect(codes(doc({ scale: '500' }))).toEqual(['scale'])
		expect(codes(doc({ deploy: { replicas: 1000 } }))).toEqual(['scale'])
		expect(codes(doc({ scale: -1 }))).toEqual(['scale'])
		expect(codes(doc({ scale: 'x' }))).toEqual(['scale'])
	})
})
