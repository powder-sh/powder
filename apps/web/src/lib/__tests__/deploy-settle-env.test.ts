// The install-wide settle window comes from POWDER_DEPLOY_SETTLE_SECONDS and is stored
// in the powder_meta row every reader (deploys.ts, heldSql) reads.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEPLOY_SETTLE_MAX_SECONDS } from '../deploy-settle'
import { settleEnvPlan } from '../deploy-settle-env'

describe('settleEnvPlan', () => {
	it('unset or empty leaves the stored default alone', () => {
		expect(settleEnvPlan({})).toEqual({ skip: 'unset' })
		expect(settleEnvPlan({ POWDER_DEPLOY_SETTLE_SECONDS: '  ' })).toEqual({ skip: 'unset' })
	})
	it('a number of seconds is written, 0 included (off), capped at the maximum', () => {
		expect(settleEnvPlan({ POWDER_DEPLOY_SETTLE_SECONDS: '120' })).toEqual({ write: '120' })
		expect(settleEnvPlan({ POWDER_DEPLOY_SETTLE_SECONDS: ' 0 ' })).toEqual({ write: '0' })
		expect(settleEnvPlan({ POWDER_DEPLOY_SETTLE_SECONDS: '90.7' })).toEqual({ write: '90' })
		expect(settleEnvPlan({ POWDER_DEPLOY_SETTLE_SECONDS: '99999' })).toEqual({ write: String(DEPLOY_SETTLE_MAX_SECONDS) })
	})
	it('an unreadable value is a warning and writes nothing', () => {
		for (const v of ['-5', 'ten', '1e3', '5s']) {
			const p = settleEnvPlan({ POWDER_DEPLOY_SETTLE_SECONDS: v })
			expect('warn' in p, v).toBe(true)
		}
	})
	it('boot applies it (instrumentation)', () => {
		const src = readFileSync(resolve(__dirname, '..', '..', 'instrumentation.ts'), 'utf8')
		expect(src).toContain('await syncSettleDefaultFromEnv()')
	})
})
