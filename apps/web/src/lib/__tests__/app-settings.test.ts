import { describe, expect, it } from 'vitest'
import { healthPathFor } from '../app-hosts'
import { parseHealthUrl } from '../deploys'
import { backupDbProblem, validateAppSettings, validateHealthUrl } from '../app-settings'
import { resolveUrl } from '../uptime'

describe('validateHealthUrl', () => {
	it('accepts a path and an absolute http(s) URL', () => {
		expect(validateHealthUrl('/api/health')).toEqual({ ok: true, value: '/api/health' })
		expect(validateHealthUrl(' https://app.example.com/healthz ')).toEqual({
			ok: true,
			value: 'https://app.example.com/healthz',
		})
		expect(validateHealthUrl('http://198.51.100.7/up')).toEqual({ ok: true, value: 'http://198.51.100.7/up' })
	})
	it('empty / null clears the column', () => {
		expect(validateHealthUrl('')).toEqual({ ok: true, value: null })
		expect(validateHealthUrl('  ')).toEqual({ ok: true, value: null })
		expect(validateHealthUrl(null)).toEqual({ ok: true, value: null })
	})
	it('refuses what the readers would not use the same way', () => {
		for (const v of [
			'api/health',
			'//evil.example.com/x',
			'ftp://app.example.com/',
			'javascript:alert(1)',
			'/api/he alth',
			'/api/$(id)',
			"/a'b",
			'/include/x',
			'https://user:pw@app.example.com/',
			'https:///nohost',
		]) {
			expect(validateHealthUrl(v).ok, v).toBe(false)
		}
		expect(validateHealthUrl(42).ok).toBe(false)
		expect(validateHealthUrl(`/${'a'.repeat(3000)}`).ok).toBe(false)
	})
	it('refuses loopback, link-local and private IP literals (the uptime guard set)', () => {
		for (const v of [
			'http://127.0.0.1/health',
			'http://169.254.169.254/latest',
			'http://10.0.0.5/health',
			'http://172.17.0.2/health',
			'http://[::1]/health',
		]) {
			expect(validateHealthUrl(v).ok, v).toBe(false)
		}
	})
	it('an accepted value means the same path to uptime, the deploy gate and Traefik', () => {
		for (const v of ['/api/health', 'https://app.example.com/api/health']) {
			const r = validateHealthUrl(v)
			expect(r.ok).toBe(true)
			expect(healthPathFor(v)).toBe('/api/health')
			expect(parseHealthUrl(v)?.path).toBe('/api/health')
			expect(resolveUrl({ containerName: 'app', healthUrl: v }, 'app.example.com')).toBe(
				'https://app.example.com/api/health',
			)
		}
	})
})

describe('validateAppSettings', () => {
	it('takes any subset of the fields', () => {
		expect(validateAppSettings({ syncDeploymentMd: true })).toEqual({ ok: true, value: { syncDeploymentMd: true } })
		expect(
			validateAppSettings({ uptimeEnabled: true, previewsEnabled: false, healthUrl: '/up', other: 1 }),
		).toEqual({ ok: true, value: { uptimeEnabled: true, previewsEnabled: false, healthUrl: '/up' } })
		expect(validateAppSettings({ healthUrl: '' })).toEqual({ ok: true, value: { healthUrl: null } })
	})
	it('a non-boolean toggle, a bad health URL or an empty body is an error', () => {
		expect(validateAppSettings({ uptimeEnabled: 'yes' })).toEqual({
			ok: false,
			error: 'uptimeEnabled must be a boolean',
		})
		expect(validateAppSettings({ previewsEnabled: 1 }).ok).toBe(false)
		expect(validateAppSettings({ healthUrl: 'ftp://x.example.com/' }).ok).toBe(false)
		expect(validateAppSettings({}).ok).toBe(false)
		expect(validateAppSettings(null).ok).toBe(false)
	})
	it('autoRollback is a boolean toggle (the per-app opt-out)', () => {
		expect(validateAppSettings({ autoRollback: false })).toEqual({ ok: true, value: { autoRollback: false } })
		expect(validateAppSettings({ autoRollback: true })).toEqual({ ok: true, value: { autoRollback: true } })
		for (const v of ['false', 0, null, 'off'])
			expect(validateAppSettings({ autoRollback: v })).toEqual({
				ok: false,
				error: 'autoRollback must be a boolean',
			})
	})
	it('deploySettleSeconds is whole seconds from 0 to 1800, or null for the install-wide value', () => {
		for (const v of [0, 1, 600, 1800, null])
			expect(validateAppSettings({ deploySettleSeconds: v })).toEqual({ ok: true, value: { deploySettleSeconds: v } })
		for (const v of [-1, 1801, 1.5, '600', Number.NaN, Number.POSITIVE_INFINITY, true, {}]) {
			const r = validateAppSettings({ deploySettleSeconds: v })
			expect(r.ok, String(v)).toBe(false)
			if (!r.ok) expect(r.error).toMatch(/deploySettleSeconds must be a whole number of seconds from 0 to 1800/)
		}
	})
})

describe('backup database fields', () => {
	it('takes container, host, database, user and password; empty is the default', () => {
		expect(
			validateAppSettings({
				hasPostgres: true,
				backupDbContainer: 'pg-shared_1.x',
				backupDbHost: 'db.example.internal:6543',
				backupDbName: 'shop',
				backupDbUser: 'shop_rw',
				backupDbPassword: ' with spaces ',
			}),
		).toEqual({
			ok: true,
			value: {
				hasPostgres: true,
				backupDbContainer: 'pg-shared_1.x',
				backupDbHost: 'db.example.internal:6543',
				backupDbName: 'shop',
				backupDbUser: 'shop_rw',
				backupDbPassword: ' with spaces ',
			},
		})
		expect(validateAppSettings({ backupDbContainer: '', backupDbHost: null, backupDbPassword: '' })).toEqual({
			ok: true,
			value: { backupDbContainer: null, backupDbHost: null, backupDbPassword: null },
		})
		expect(validateAppSettings({ backupDbHost: '10.0.0.5' }).ok).toBe(true)
	})
	it('refuses values that are not a container, host or postgres name', () => {
		for (const body of [
			{ backupDbContainer: '-x' },
			{ backupDbContainer: 'a b' },
			{ backupDbContainer: 'x;rm' },
			{ backupDbContainer: 'a'.repeat(129) },
			{ backupDbHost: 'db:0' },
			{ backupDbHost: 'db:70000' },
			{ backupDbHost: 'http://db' },
			{ backupDbHost: '[::1]:5432' },
			{ backupDbHost: 'db host' },
			{ backupDbName: 'a'.repeat(64) },
			{ backupDbName: "x'y" },
			{ backupDbUser: '$(id)' },
			{ backupDbUser: 1 },
			{ backupDbPassword: 'a\nb' },
			{ backupDbPassword: 'a\u0000' },
			{ backupDbPassword: 'x'.repeat(1025) },
			{ backupDbPassword: 5 },
			{ hasPostgres: 'yes' },
		]) {
			const r = validateAppSettings(body)
			expect(r.ok, JSON.stringify(body)).toBe(false)
		}
	})
	it('a container and a host exclude each other; a host needs a password', () => {
		expect(backupDbProblem({ container: null, host: null, passwordSet: false })).toBeNull()
		expect(backupDbProblem({ container: 'pg', host: null, passwordSet: false })).toBeNull()
		expect(backupDbProblem({ container: null, host: 'db', passwordSet: true })).toBeNull()
		expect(backupDbProblem({ container: null, host: 'db', passwordSet: false })).toMatch(/needs backupDbPassword/)
		expect(backupDbProblem({ container: 'pg', host: 'db', passwordSet: true })).toMatch(/not both/)
	})
})
