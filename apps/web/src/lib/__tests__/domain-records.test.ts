import { describe, expect, it } from 'vitest'
import { domainRecords, isApex, needsDnsRecords } from '../domain-records'

const base = {
	hostname: 'shop.example.com',
	status: 'pending',
	verifyChallenge: 'pwdr-abc',
	autoAssigned: 'storefront.apps.example.com',
	ingressIp: '192.0.2.10',
}

describe('domain records', () => {
	it('a pending subdomain needs the TXT and a CNAME to the default host', () => {
		expect(domainRecords(base).records).toEqual([
			{ purpose: 'ownership', type: 'TXT', name: '_powder.shop.example.com', value: 'pwdr-abc' },
			{
				purpose: 'routing',
				type: 'CNAME',
				name: 'shop.example.com',
				value: 'storefront.apps.example.com',
			},
		])
	})
	it('an apex gets an A record to the public IP', () => {
		const r = domainRecords({ ...base, hostname: 'example.com' })
		expect(r.records[1]).toEqual({
			purpose: 'routing',
			type: 'A',
			name: 'example.com',
			value: '192.0.2.10',
		})
	})
	it('no base domain and no public IP: says what is missing instead of guessing', () => {
		const r = domainRecords({ ...base, autoAssigned: null, ingressIp: null })
		expect(r.records.map((x) => x.type)).toEqual(['TXT'])
		expect(r.routingMissing).toContain('public IP')
	})
	it('live and verified rows need nothing; failed rows still show records', () => {
		expect(domainRecords({ ...base, status: 'live' }).records).toEqual([])
		expect(domainRecords({ ...base, status: 'verified' }).records).toEqual([])
		expect(needsDnsRecords('verify_failed')).toBe(true)
		expect(needsDnsRecords('failed')).toBe(true)
		expect(isApex('example.com')).toBe(true)
		expect(isApex('www.example.com')).toBe(false)
	})
})
