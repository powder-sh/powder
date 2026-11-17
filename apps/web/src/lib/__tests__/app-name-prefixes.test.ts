// pv- (previews) and dep- are powder namespaces, never a new app's name.
import { describe, expect, it } from 'vitest'
import { reservedAppNameError } from '../app-names'

describe('reserved app name prefixes', () => {
	it('refuses pv, dep and their dash forms', () => {
		for (const n of ['pv', 'dep', 'pv-shop-feat-1a2b3c', 'dep-x', 'pv-x'])
			expect(reservedAppNameError(n), n).not.toBeNull()
	})
	it('keeps names that only start with the letters', () => {
		for (const n of ['pvt', 'depot', 'deploy-bot', 'shop-pv', 'pvshop'])
			expect(reservedAppNameError(n), n).toBeNull()
	})
})
