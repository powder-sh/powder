import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../llm-redact'

const R = '[redacted]'

describe('llm-redact rules', () => {
	it('keeps existing behaviour: KEY=value and URL credentials', () => {
		expect(redactSecrets('API_KEY=abc123')).toBe(`API_KEY=${R}`)
		expect(redactSecrets('postgres://u:p@host/db')).toBe(`postgres://${R}@host/db`)
	})
	it('JSON "password": "x" (quote between name and separator)', () => {
		const out = redactSecrets('{"password": "hunter2", "db_token":"abc"}')
		expect(out).not.toContain('hunter2')
		expect(out).not.toContain('abc')
		expect(out).toContain(`"password": ${R}`)
	})
	it('PEM private key block', () => {
		const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----'
		const out = redactSecrets(`before\n${pem}\nafter`)
		expect(out).not.toContain('MIIEow')
		expect(out).toBe(`before\n${R}\nafter`)
		expect(redactSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA')).toBe(R)
	})
	it('sk_live_ / sk_test_', () => {
		expect(redactSecrets('use sk_' + 'live_51HabcDEF123 now')).toBe(`use ${R} now`)
		expect(redactSecrets('sk_' + 'test_abcdef123')).toBe(R)
	})
	it('rk_live_ / rk_test_', () => {
		expect(redactSecrets('rk_live_abcDEF123')).toBe(R)
		expect(redactSecrets('rk_test_abcDEF123')).toBe(R)
	})
	it('slack xox[abpr]- tokens', () => {
		for (const k of ['xoxb', 'xoxa', 'xoxp', 'xoxr']) expect(redactSecrets(`t ${k}-123-abc-DEF`)).toBe(`t ${R}`)
	})
	it('JWTs', () => {
		const jwt = 'eyJhbGciOiJIUzI1' + 'NiJ9.eyJzdWIiOiIxMjMifQ.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
		expect(redactSecrets(`auth ${jwt} end`)).toBe(`auth ${R} end`)
	})
	it('40-char AWS secret after an AWS secret-like key', () => {
		const v = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
		expect(v.length).toBe(40)
		expect(redactSecrets(`aws_secret_access_key = ${v}`)).not.toContain(v)
		expect(redactSecrets(`AWS secret access key: "${v}"`)).not.toContain(v)
	})
})

describe('llm-redact gaps', () => {
	it('more name hints: PASS, PWD, CRED, AUTH, DSN, PRIVATE', () => {
		for (const n of ['DB_PASS', 'MYSQL_PWD', 'AWS_CREDENTIALS', 'AUTH_HEADER', 'SENTRY_DSN', 'PRIVATE_THING']) {
			expect(redactSecrets(`${n}=hunter2value`)).toBe(`${n}=${R}`)
		}
	})
	it('URL credentials with / or : inside the password', () => {
		expect(redactSecrets('postgres://app:pa/ss:wo@rd@db:5432/app')).not.toContain('rd@')
		expect(redactSecrets('postgres://app:pa/ss:wo@rd@db:5432/app')).toBe(`postgres://${R}@db:5432/app`)
		expect(redactSecrets('https://user:p%2Fw@host/x')).toBe(`https://${R}@host/x`)
	})
	it('base64 runs of 64+ chars are masked, short ones are not', () => {
		const b = 'QUJD'.repeat(20)
		expect(redactSecrets(`blob ${b} end`)).toBe(`blob ${R} end`)
		expect(redactSecrets('abc/def+ghi==')).toBe('abc/def+ghi==')
	})
})
