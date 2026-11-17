import { describe, expect, it } from 'vitest'
import { onlyDeploymentMdChanged } from '../deployment-md-push'

const sync = { added: [], modified: ['DEPLOYMENT.md'], removed: [] }

describe('a push that only touches DEPLOYMENT.md does not deploy', () => {
	it('skips powder\'s own sync commit', () => {
		expect(onlyDeploymentMdChanged({ commits: [sync], head_commit: sync })).toBe(true)
		expect(onlyDeploymentMdChanged({ commits: [{ added: ['DEPLOYMENT.md'] }] })).toBe(true)
	})

	it('deploys when any commit touches another file, a nested DEPLOYMENT.md included', () => {
		expect(onlyDeploymentMdChanged({ commits: [sync, { modified: ['src/app/page.tsx'] }], head_commit: sync })).toBe(false)
		expect(onlyDeploymentMdChanged({ commits: [sync], head_commit: { modified: ['DEPLOYMENT.md', 'package.json'] } })).toBe(false)
		expect(onlyDeploymentMdChanged({ commits: [{ modified: ['docs/DEPLOYMENT.md'] }] })).toBe(false)
	})

	it('deploys when the file list is unknown: no commits, a capped list, odd shapes, no files', () => {
		expect(onlyDeploymentMdChanged({})).toBe(false)
		expect(onlyDeploymentMdChanged({ commits: [] })).toBe(false)
		expect(onlyDeploymentMdChanged({ commits: Array.from({ length: 20 }, () => sync) })).toBe(false)
		expect(onlyDeploymentMdChanged({ commits: [{ modified: 'DEPLOYMENT.md' }] })).toBe(false)
		expect(onlyDeploymentMdChanged({ commits: [null] })).toBe(false)
		expect(onlyDeploymentMdChanged({ commits: [{ added: [], modified: [], removed: [] }] })).toBe(false)
		// an empty "redeploy" commit next to a sync commit still deploys
		expect(onlyDeploymentMdChanged({ commits: [sync, { added: [], modified: [], removed: [] }], head_commit: sync })).toBe(false)
	})

	it('deploys forced, created and deleted pushes (a force push lists only commits past the merge base)', () => {
		for (const flag of ['forced', 'created', 'deleted'] as const) {
			expect(onlyDeploymentMdChanged({ commits: [sync], head_commit: sync, [flag]: true })).toBe(false)
		}
		expect(onlyDeploymentMdChanged({ commits: [sync], head_commit: sync, forced: false, created: false, deleted: false })).toBe(true)
	})
})
