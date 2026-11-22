// The failure summary on logs in the shapes real deploys print (fixtures/
// deploy-failure-logs.ts): each case names the summary it must give. Only
// parseDeployFailure is imported, so the same file runs against any version of
// the reader.
import { describe, expect, it } from 'vitest'
import { parseDeployFailure } from '../deploy-failure'
import { DEPLOY_FAILURE_LOG_CASES } from './fixtures/deploy-failure-logs'

describe('the failure summary on real log shapes', () => {
	for (const c of DEPLOY_FAILURE_LOG_CASES) {
		it(`${c.was}: ${c.name}`, () => {
			const s = String(parseDeployFailure(c.log).errorSummary)
			expect(s).toBe(c.summary)
			expect(s).not.toContain('\n')
			expect(s).not.toMatch(/__POWDER_/)
		})
	}

	it('covers every class it guards', () => {
		for (const was of ['vague', 'wrong', 'right'] as const)
			expect(DEPLOY_FAILURE_LOG_CASES.filter((c) => c.was === was).length).toBeGreaterThanOrEqual(3)
	})
})
