// otherAppsOnServer runs the registered-app and preview lookups on their own,
// so a failed preview query still returns the registered names the compose guard needs.
import { describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({ failPreviews: false, failApps: false }))

vi.mock('../db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const db = {
		select: () => {
			let joined = false
			const q = {
				from: () => q,
				innerJoin: () => {
					joined = true
					return q
				},
				where: async () => {
					if (joined) {
						if (H.failPreviews) throw new Error('relation "preview_deploys" does not exist')
						return [
							{ name: 'shopx.preview-feat', parent: 'shopx' },
							{ name: 'selfapp.preview-a', parent: 'selfapp' },
						]
					}
					if (H.failApps) throw new Error('connection reset')
					return [{ name: 'shopx' }, { name: 'selfapp' }, { name: 'blogx' }]
				},
			}
			return q
		},
	}
	return { ...real, db }
})

import { otherAppsOnServer } from '../deploy-runner'

describe('otherAppsOnServer', () => {
	it('returns registered names and other apps previews', async () => {
		H.failPreviews = false
		H.failApps = false
		expect((await otherAppsOnServer('server', 'selfapp')).sort()).toEqual(['blogx', 'shopx', 'shopx.preview-feat'])
	})
	it('a failed preview query keeps the registered names', async () => {
		H.failPreviews = true
		H.failApps = false
		const err = vi.spyOn(console, 'error').mockImplementation(() => {})
		expect((await otherAppsOnServer('server', 'selfapp')).sort()).toEqual(['blogx', 'shopx'])
		err.mockRestore()
	})
	it('a failed app query keeps the preview names', async () => {
		H.failPreviews = false
		H.failApps = true
		const err = vi.spyOn(console, 'error').mockImplementation(() => {})
		expect(await otherAppsOnServer('server', 'selfapp')).toEqual(['shopx.preview-feat'])
		err.mockRestore()
	})
})
