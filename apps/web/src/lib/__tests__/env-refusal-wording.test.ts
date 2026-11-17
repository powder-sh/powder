// The env key refusal names who is refused: "a token cannot" for a token,
// "only an admin can" for a human session that is not an admin's. Same rule.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({ db: {} }))

import { envKeyDeleteDenied, envKeyWriteDenied, tokenEnvWriteRefusal } from '../env-key-policy'

describe('env refusal wording', () => {
	const cases: Array<[string, string]> = [
		['NODE_ENV', 'production'],
		['LD_PRELOAD', '/x.so'],
		['DATABASE_URL', 'postgres://x'],
		['API_TOKEN', 'a\nb'],
	]

	it('a token keeps "a token cannot"', () => {
		for (const [k, v] of cases) {
			const msg = tokenEnvWriteRefusal(k, v)
			expect(msg, k).toContain('a token cannot')
			expect(msg, k).not.toContain('only an admin can')
		}
	})

	it('a non-admin session reads "only an admin can", never "a token"', () => {
		for (const [k, v] of cases) {
			const msg = envKeyWriteDenied(k, v, false, 'session')
			expect(msg, k).toContain('only an admin can set it')
			expect(msg, k).not.toMatch(/\btoken (cannot|may|write)/)
		}
		expect(envKeyDeleteDenied('NODE_ENV', false, 'session')).toContain('only an admin can delete it')
	})

	it('the rule itself does not change with the wording', () => {
		for (const [k, v] of [...cases, ['STRIPE_SECRET_KEY', 'sk']]) {
			expect(envKeyWriteDenied(k, v, false, 'session') === null).toBe(envKeyWriteDenied(k, v, false) === null)
		}
		expect(envKeyWriteDenied('NODE_ENV', 'x', true, 'session')).toBeNull()
	})
})
