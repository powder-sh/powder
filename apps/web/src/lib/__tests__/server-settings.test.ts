import { describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_NEW_SERVER_PROXY,
	dnsProbeName,
	dnsVerdict,
	validateBaseDomain,
	validateBuildHost,
	validateIngressIp,
	validateServerSettings,
} from '../server-settings'

describe('validateBaseDomain', () => {
	it('accepts a bare lowercase hostname and trims a trailing dot', () => {
		expect(validateBaseDomain('apps.example.com')).toEqual({ ok: true, value: 'apps.example.com' })
		expect(validateBaseDomain('  apps.example.com.  ')).toEqual({
			ok: true,
			value: 'apps.example.com',
		})
	})
	it('empty / null clears the column', () => {
		expect(validateBaseDomain('')).toEqual({ ok: true, value: null })
		expect(validateBaseDomain('   ')).toEqual({ ok: true, value: null })
		expect(validateBaseDomain(null)).toEqual({ ok: true, value: null })
	})
	it('rejects a scheme', () => {
		const r = validateBaseDomain('https://apps.example.com')
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.error).toMatch(/scheme/)
	})
	it('rejects a wildcard', () => {
		for (const v of ['*.apps.example.com', 'a*.example.com']) {
			const r = validateBaseDomain(v)
			expect(r.ok).toBe(false)
			if (!r.ok) expect(r.error).toMatch(/wildcard/)
		}
	})
	it('rejects uppercase', () => {
		const r = validateBaseDomain('Apps.Example.com')
		expect(r.ok).toBe(false)
		if (!r.ok) expect(r.error).toMatch(/lowercase/)
	})
	it('rejects paths, ports, spaces and shell metacharacters', () => {
		for (const v of [
			'apps.example.com/x',
			'apps.example.com:443',
			'apps example.com',
			"apps.example.com';rm -rf /",
			'apps.example.com$(id)',
			'localhost',
			'-bad.example.com',
			`${'a'.repeat(64)}.example.com`,
		]) {
			expect(validateBaseDomain(v).ok, v).toBe(false)
		}
	})
	it('rejects non-strings', () => {
		expect(validateBaseDomain(42).ok).toBe(false)
	})
})

describe('validateIngressIp', () => {
	it('accepts IPv4 and empty', () => {
		expect(validateIngressIp('203.0.113.10')).toEqual({ ok: true, value: '203.0.113.10' })
		expect(validateIngressIp('')).toEqual({ ok: true, value: null })
	})
	it('rejects hostnames, IPv6 and junk', () => {
		for (const v of ['example.com', '2001:db8::1', '300.1.1.1', '1.2.3.4; id']) {
			expect(validateIngressIp(v).ok, v).toBe(false)
		}
	})
})

describe('validateServerSettings', () => {
	it('accepts all three proxy values', () => {
		for (const proxy of ['traefik', 'nginx', 'nginx-container']) {
			expect(validateServerSettings({ proxy })).toEqual({ ok: true, value: { proxy } })
		}
	})
	it('rejects unknown proxy and tls modes', () => {
		expect(validateServerSettings({ proxy: 'caddy' }).ok).toBe(false)
		expect(validateServerSettings({ tlsMode: 'dns-01' }).ok).toBe(false)
	})
	it('returns only provided fields, normalised', () => {
		expect(
			validateServerSettings({
				tlsMode: 'origin-cert',
				baseDomain: 'apps.example.com.',
				ingressIp: '',
				other: 'ignored',
			}),
		).toEqual({
			ok: true,
			value: { tlsMode: 'origin-cert', baseDomain: 'apps.example.com', ingressIp: null },
		})
	})
	it('fails on an invalid field even when others are fine', () => {
		expect(validateServerSettings({ proxy: 'traefik', baseDomain: 'https://x.com' }).ok).toBe(false)
	})
	it('rejects empty and non-object bodies', () => {
		expect(validateServerSettings({}).ok).toBe(false)
		expect(validateServerSettings(null).ok).toBe(false)
		expect(validateServerSettings('proxy=traefik').ok).toBe(false)
	})
	it('new servers default to traefik', () => {
		expect(DEFAULT_NEW_SERVER_PROXY).toBe('traefik')
	})
})

describe('DNS check verdict', () => {
	it('probes a random label under the base domain', () => {
		expect(dnsProbeName('apps.example.com', () => 'x1')).toBe('x1.apps.example.com')
		const a = dnsProbeName('apps.example.com')
		const b = dnsProbeName('apps.example.com')
		expect(a).toMatch(/^powder-dns-check-[0-9a-f]{8}\.apps\.example\.com$/)
		expect(a).not.toBe(b)
	})
	it('ok when the expected IP is among the answers, mismatch otherwise', () => {
		expect(dnsVerdict('p.x.com', '203.0.113.10', { ips: ['203.0.113.10'] }).state).toBe('ok')
		expect(dnsVerdict('p.x.com', '203.0.113.10', { ips: ['104.16.0.1'] }).state).toBe('mismatch')
	})
	it('unresolved and no-target', () => {
		expect(dnsVerdict('p.x.com', '203.0.113.10', { error: 'ENOTFOUND' }).state).toBe('unresolved')
		expect(dnsVerdict('p.x.com', null, { ips: ['1.2.3.4'] }).state).toBe('no-target')
	})
})

describe('validateBuildHost', () => {
	it('accepts a hostname (lowercased, trailing dot dropped) or an IP literal', () => {
		expect(validateBuildHost('Builder.Example.com.')).toEqual({ ok: true, value: 'builder.example.com' })
		expect(validateBuildHost('198.51.100.7')).toEqual({ ok: true, value: '198.51.100.7' })
		expect(validateBuildHost('2001:db8::1')).toEqual({ ok: true, value: '2001:db8::1' })
		expect(validateBuildHost('builder')).toEqual({ ok: true, value: 'builder' })
	})
	it('empty / null clears the column', () => {
		expect(validateBuildHost('')).toEqual({ ok: true, value: null })
		expect(validateBuildHost(null)).toEqual({ ok: true, value: null })
	})
	it('rejects loopback / link-local literals, schemes, users, paths and ports', () => {
		for (const v of ['127.0.0.1', '::1', '169.254.169.254', 'https://b.example.com', 'root@b.example.com', 'b.example.com/x', 'b.example.com:22', 'b c', '-b.example.com']) {
			expect(validateBuildHost(v).ok).toBe(false)
		}
		expect(validateBuildHost(3).ok).toBe(false)
	})
	it('validateServerSettings carries it', () => {
		expect(validateServerSettings({ buildHost: 'b.example.com' })).toEqual({ ok: true, value: { buildHost: 'b.example.com' } })
	})
})

describe('checkBuildHost', () => {
	it('refuses a name that does not resolve or resolves to loopback', async () => {
		const { checkBuildHost } = await import('../server-host-guard')
		expect((await checkBuildHost('b.example.com', async () => [])).ok).toBe(false)
		expect((await checkBuildHost('b.example.com', async () => ['127.0.0.1'])).ok).toBe(false)
		expect((await checkBuildHost('b.example.com', async () => ['203.0.113.9'])).ok).toBe(true)
	})
})

describe('resolveHostIps (getaddrinfo)', () => {
	it('returns every address lookup gives, v4 and v6, deduplicated', async () => {
		const { resolveHostIps } = await import('../server-host-guard')
		const lookup = async () => [{ address: '203.0.113.9' }, { address: '2001:db8::9' }, { address: '203.0.113.9' }]
		expect(await resolveHostIps('builder', lookup)).toEqual(['203.0.113.9', '2001:db8::9'])
	})
	it('a failed lookup is no addresses; an IP literal skips the lookup', async () => {
		const { resolveHostIps } = await import('../server-host-guard')
		const fail = async () => {
			throw new Error('ENOTFOUND')
		}
		expect(await resolveHostIps('nope', fail)).toEqual([])
		expect(await resolveHostIps('203.0.113.9', fail)).toEqual(['203.0.113.9'])
	})
	it('a short name with any loopback or link-local address (v4 or v6) is refused', async () => {
		const { checkBuildHost, checkNewServerHost, resolveHostIps } = await import('../server-host-guard')
		for (const bad of ['127.0.1.1', '::1', 'fe80::1', '169.254.3.3']) {
			const lookup = async () => [{ address: '203.0.113.9' }, { address: bad }]
			const resolve = (h: string) => resolveHostIps(h, lookup)
			expect((await checkBuildHost('builder', resolve)).ok).toBe(false)
			expect(await checkNewServerHost('builder', [], resolve)).toMatchObject({ ok: false, status: 400 })
		}
	})
	it('uses dns.lookup with all: true by default', async () => {
		const dns = await import('node:dns')
		const spy = vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '203.0.113.9', family: 4 }] as never)
		const { resolveHostIps } = await import('../server-host-guard')
		expect(await resolveHostIps('builder')).toEqual(['203.0.113.9'])
		expect(spy).toHaveBeenCalledWith('builder', { all: true })
		spy.mockRestore()
	})
})
