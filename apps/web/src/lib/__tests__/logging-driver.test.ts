// logging drivers must keep the logs on the server.
import { describe, expect, it } from 'vitest'
import { composeViolations, isHighSeverity } from '../compose-safety'

const codes = (logging: unknown) =>
	composeViolations(
		{ name: 'shop', services: { shop: { image: 'shop:1', logging } } },
		{ appName: 'shop', resolved: true },
	).map((v) => v.code)

describe('logging driver', () => {
	it('passes the defaults and local drivers', () => {
		expect(codes(undefined)).toEqual([])
		expect(codes({ options: { 'max-size': '10m', 'max-file': '3' } })).toEqual([])
		for (const driver of ['json-file', 'local', 'journald', 'none'])
			expect(codes({ driver, options: { tag: 'CRON' } })).toEqual([])
	})
	it('refuses remote drivers and endpoint options', () => {
		expect(
			codes({ driver: 'syslog', options: { 'syslog-address': 'udp://10.0.0.1:514' } }),
		).toEqual(['logging', 'logging'])
		expect(codes({ driver: 'gelf' })).toEqual(['logging'])
		expect(codes({ driver: 'json-file', options: { 'fluentd-address': 'x' } })).toEqual(['logging'])
		expect(codes({ driver: 'local', options: { 'splunk-url': 'x', 'loki-host': 'y' } })).toEqual([
			'logging',
			'logging',
		])
		expect(isHighSeverity({ code: 'logging', message: '' })).toBe(true)
	})
})
