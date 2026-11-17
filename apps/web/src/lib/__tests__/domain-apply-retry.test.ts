import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canApplyDomain } from '../app-domains'

// The domains page offers "apply again" on a row whose apply failed, so
// applyDomain must accept that status as well as 'verified'.
describe('applyDomain status gate', () => {
	it('accepts a verified row and a failed apply, nothing else', () => {
		expect(canApplyDomain('verified')).toBe(true)
		expect(canApplyDomain('apply_failed')).toBe(true)
		for (const s of ['pending', 'verify_failed', 'live', 'failed', '']) expect(canApplyDomain(s)).toBe(false)
	})

	it('the page shows the apply button for exactly the statuses applyDomain accepts', () => {
		const page = readFileSync(join(__dirname, '../../app/(dashboard)/projects/[id]/domains/page.tsx'), 'utf8')
		expect(page).toContain("domain.status === 'verified' || domain.status === 'apply_failed'")
	})
})
