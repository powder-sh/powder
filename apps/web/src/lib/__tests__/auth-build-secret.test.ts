// `next build` without BETTER_AUTH_SECRET: a random build-only secret instead of
// better-auth's default-secret error; never at runtime, never over a real secret.
import { describe, expect, it } from 'vitest'
import { buildOnlySecret } from '../auth'
import { productionConfigProblems } from '../startup-checks'

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv

describe('buildOnlySecret', () => {
	it('only in the build phase and only when the secret is unset; random each time', () => {
		const a = buildOnlySecret(env({ NEXT_PHASE: 'phase-production-build' }))
		expect(a).toMatch(/^[0-9a-f]{64}$/)
		expect(buildOnlySecret(env({ NEXT_PHASE: 'phase-production-build' }))).not.toBe(a)
		expect(buildOnlySecret(env({ NEXT_PHASE: 'phase-production-build', BETTER_AUTH_SECRET: 'x'.repeat(64) }))).toBeUndefined()
		expect(buildOnlySecret(env({ NEXT_PHASE: 'phase-production-server' }))).toBeUndefined()
		expect(buildOnlySecret(env({}))).toBeUndefined()
	})
	it('the boot check still refuses a missing secret', () => {
		expect(productionConfigProblems(env({ NODE_ENV: 'production' })).join('\n')).toContain('BETTER_AUTH_SECRET is not set')
	})
})
