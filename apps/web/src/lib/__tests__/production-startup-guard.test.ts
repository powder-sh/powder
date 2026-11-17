import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import {
	assertProductionConfig,
	ENCRYPTION_KEY_MIN_BITS,
	authUrlWarnings,
	estimatedEntropyBits,
	productionConfigProblems,
} from '../startup-checks'

// Fixed, random-looking 64-hex values (what `openssl rand -hex 32` produces).
const hex = (seed: string) => createHash('sha256').update(seed).digest('hex')
const good = {
	NODE_ENV: 'production',
	BETTER_AUTH_SECRET: hex('auth'),
	POWDER_ENCRYPTION_KEY: hex('enc'),
	BETTER_AUTH_URL: 'https://deploy.example.com',
} as unknown as NodeJS.ProcessEnv
const withEnv = (over: Record<string, string | undefined>) =>
	({ ...good, ...over }) as NodeJS.ProcessEnv

// getKey() reads process.env.POWDER_ENCRYPTION_KEY, so run each case with it set.
function check(env: NodeJS.ProcessEnv) {
	const saved = process.env.POWDER_ENCRYPTION_KEY
	if (env.POWDER_ENCRYPTION_KEY === undefined) delete process.env.POWDER_ENCRYPTION_KEY
	else process.env.POWDER_ENCRYPTION_KEY = env.POWDER_ENCRYPTION_KEY
	try {
		return productionConfigProblems(env)
	} finally {
		if (saved === undefined) delete process.env.POWDER_ENCRYPTION_KEY
		else process.env.POWDER_ENCRYPTION_KEY = saved
	}
}

describe('production startup guard', () => {
	it('passes a good config and ignores non-production', () => {
		expect(check(good)).toEqual([])
		expect(productionConfigProblems({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toEqual([])
	})
	it('refuses the example auth secret and any change-me placeholder', () => {
		expect(check(withEnv({ BETTER_AUTH_SECRET: 'change-me-to-a-random-secret' })).join()).toMatch(
			/BETTER_AUTH_SECRET/,
		)
		expect(check(withEnv({ BETTER_AUTH_SECRET: 'CHANGE_ME' })).join()).toMatch(/placeholder/)
		expect(check(withEnv({ BETTER_AUTH_SECRET: undefined })).join()).toMatch(/not set/)
	})
	it('refuses a missing or invalid encryption key', () => {
		expect(check(withEnv({ POWDER_ENCRYPTION_KEY: undefined })).join()).toMatch(
			/POWDER_ENCRYPTION_KEY/,
		)
		expect(check(withEnv({ POWDER_ENCRYPTION_KEY: 'abc' })).join()).toMatch(/POWDER_ENCRYPTION_KEY/)
	})
	it('refuses a short or low-entropy auth secret', () => {
		expect(check(withEnv({ BETTER_AUTH_SECRET: 'abc123' })).join()).toMatch(
			/BETTER_AUTH_SECRET is only 6 characters/,
		)
		expect(check(withEnv({ BETTER_AUTH_SECRET: 'f'.repeat(64) })).join()).toMatch(
			/BETTER_AUTH_SECRET looks low-entropy/,
		)
		expect(check(withEnv({ BETTER_AUTH_SECRET: 'abcd'.repeat(10) })).join()).toMatch(/low-entropy/)
		// openssl rand -base64 32 shape passes
		expect(
			check(withEnv({ BETTER_AUTH_SECRET: Buffer.from(hex('b64'), 'hex').toString('base64') })),
		).toEqual([])
	})
	it('refuses a well-formed but low-entropy encryption key', () => {
		for (const k of ['a'.repeat(64), '0'.repeat(64), 'ab'.repeat(32)])
			expect(check(withEnv({ POWDER_ENCRYPTION_KEY: k })).join(), k).toMatch(
				/POWDER_ENCRYPTION_KEY looks low-entropy/,
			)
		expect(estimatedEntropyBits(hex('x'))).toBeGreaterThan(200)
	})
	it('accepts 64-char lowercase hex (openssl rand -hex 32) for both secrets', () => {
		for (let i = 0; i < 2000; i++) {
			const v = randomBytes(32).toString('hex')
			expect(v).toMatch(/^[0-9a-f]{64}$/)
			expect(estimatedEntropyBits(v)).toBeGreaterThan(ENCRYPTION_KEY_MIN_BITS)
		}
		for (let i = 0; i < 50; i++) {
			const env = withEnv({
				BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
				POWDER_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
			})
			expect(check(env)).toEqual([])
		}
	})
	it('warns when BETTER_AUTH_URL is not https (localhost is fine)', () => {
		const w = (u: string) =>
			authUrlWarnings({
				NODE_ENV: 'production',
				BETTER_AUTH_URL: u,
			} as unknown as NodeJS.ProcessEnv)
		expect(w('http://powder.example.com').join()).toMatch(/not https/)
		expect(w('https://powder.example.com')).toEqual([])
		expect(w('http://localhost:3050')).toEqual([])
		expect(w('http://127.0.0.1:3050')).toEqual([])
		// an invalid value is a boot problem below, not a warning
		expect(w('not a url')).toEqual([])
	})
	it('refuses to boot without a valid BETTER_AUTH_URL (links and webhooks are built from it)', () => {
		expect(check(withEnv({ BETTER_AUTH_URL: undefined })).join()).toMatch(/BETTER_AUTH_URL is not set/)
		expect(check(withEnv({ BETTER_AUTH_URL: '  ' })).join()).toMatch(/BETTER_AUTH_URL is not set/)
		expect(check(withEnv({ BETTER_AUTH_URL: 'not a url' })).join()).toMatch(/BETTER_AUTH_URL is not a valid http\(s\) URL/)
		expect(check(withEnv({ BETTER_AUTH_URL: 'ftp://deploy.example.com' })).join()).toMatch(/not a valid http\(s\) URL/)
		expect(check(withEnv({ BETTER_AUTH_URL: 'http://localhost:3050' }))).toEqual([])
	})
	it('refuses CHANGE_ME database credentials', () => {
		expect(check(withEnv({ POWDER_DB_PASSWORD: 'CHANGE_ME' })).join()).toMatch(/POWDER_DB_PASSWORD/)
		expect(check(withEnv({ POWDER_DB_PASSWORD: 'CHANGE_ME' })).join()).toContain('in /opt/apps/powder.env)')
		expect(check(withEnv({ POWDER_DB_PASSWORD: 'CHANGE_ME', POWDER_ENV_FILE: '/etc/powder/powder.env' })).join()).toContain('in /etc/powder/powder.env)')
		expect(
			check(withEnv({ DATABASE_URL: 'postgres://admin:CHANGE_ME@postgres:5432/powder' })).join(),
		).toMatch(/DATABASE_URL/)
	})
	it('assertProductionConfig throws with every reason', () => {
		const saved = process.env.POWDER_ENCRYPTION_KEY
		delete process.env.POWDER_ENCRYPTION_KEY
		try {
			expect(() => assertProductionConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
				/refusing to start/,
			)
		} finally {
			if (saved !== undefined) process.env.POWDER_ENCRYPTION_KEY = saved
		}
	})
})

describe('example env files', () => {
	const root = join(__dirname, '../../../../..')
	for (const f of ['apps/web/.env.example', 'docker/powder.env.example']) {
		const text = readFileSync(join(root, f), 'utf8')
		const val = (k: string) => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]
		it(`${f} ships empty secrets with generation hints, no accepted placeholder`, () => {
			expect(val('BETTER_AUTH_SECRET')).toBe('')
			expect(val('POWDER_ENCRYPTION_KEY')).toBe('')
			expect(text).toContain('openssl rand -hex 32')
			expect(val('BETTER_AUTH_SECRET') ?? '').not.toMatch(/change/i)
		})
	}
})

describe('fail fast', () => {
	it('logs the problems and exits 1 on a bad production config', async () => {
		const { exitOnBadProductionConfig } = await import('../startup-checks')
		const err = vi.spyOn(console, 'error').mockImplementation(() => {})
		const exit = vi.fn()
		exitOnBadProductionConfig(
			{ NODE_ENV: 'production', BETTER_AUTH_SECRET: 'change-me-x' } as never,
			exit,
		)
		expect(exit).toHaveBeenCalledWith(1)
		expect(String(err.mock.calls[0]?.[0])).toContain('BETTER_AUTH_SECRET')
		err.mockRestore()
	})
	it('does not exit outside production', async () => {
		const { exitOnBadProductionConfig } = await import('../startup-checks')
		const exit = vi.fn()
		exitOnBadProductionConfig({ NODE_ENV: 'development' } as never, exit)
		expect(exit).not.toHaveBeenCalled()
	})
})
