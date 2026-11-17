import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({ appDomains: {}, appRepos: {}, db: {}, deploys: {}, eq: () => 0, and: () => 0, desc: () => 0, sql: () => 0, createId: () => 'x', prefixes: {} }))
vi.mock('../servers', () => ({ getServer: async () => undefined }))
vi.mock('../ssh', () => ({ inspectContainer: vi.fn(), runCommand: vi.fn() }))

import { ingressTargetFor, isValidHostname } from '../app-domains'
import { hqConfigured } from '../hq'

describe('ingressTargetFor', () => {
	it('uses servers.ingress_ip first', async () => {
		expect(await ingressTargetFor({ host: '100.1.2.3', ingressIp: '203.0.113.7', baseDomain: 'a.dev' })).toEqual({
			ip: '203.0.113.7',
			cnameTarget: 'a.dev.',
		})
	})
	it('defaults to the host when it is an IPv4 literal', async () => {
		expect((await ingressTargetFor({ host: '198.51.100.9' }))?.ip).toBe('198.51.100.9')
	})
	it('resolves a host name otherwise, null when it does not resolve', async () => {
		expect((await ingressTargetFor({ host: 'server.example.com' }, async () => ['198.51.100.2']))?.ip).toBe('198.51.100.2')
		expect(
			await ingressTargetFor({ host: 'server.example.com' }, async () => {
				throw new Error('ENOTFOUND')
			}),
		).toBeNull()
	})
	it('ignores a garbage ingress_ip', async () => {
		expect((await ingressTargetFor({ host: '1.2.3.4', ingressIp: 'not-an-ip' }))?.ip).toBe('1.2.3.4')
	})
})

describe('isValidHostname', () => {
	it('has no platform host it refuses: a subdomain of any domain is valid', () => {
		expect(isValidHostname('blog.apps.example.com')).toBe(true)
		expect(isValidHostname('not a host')).toBe(false)
	})
})

describe('hqConfigured', () => {
	it('needs the token and at least one URL', () => {
		const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv
		expect(hqConfigured(env({}))).toBe(false)
		expect(hqConfigured(env({ POWDER_HQ_INGEST_TOKEN: 't' }))).toBe(false)
		expect(hqConfigured(env({ POWDER_HQ_INGEST_URL: 'https://x' }))).toBe(false)
		expect(hqConfigured(env({ POWDER_HQ_INGEST_TOKEN: 't', POWDER_HQ_CRON_URL: 'https://x' }))).toBe(true)
	})
})
