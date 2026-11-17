// Shared networks beyond web/internal/infra come from the operator
// (POWDER_SHARED_NETWORKS), not a hardcoded install-specific name.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SHARED_NETWORKS, composeViolations, sharedNetworks } from '../compose-safety'

const doc = {
	name: 'myapp',
	services: { myapp: { image: 'myapp:latest', container_name: 'myapp', networks: { stack: null } } },
	networks: { stack: { name: 'stack_default', external: true } },
}
const ctx = { appName: 'myapp', projectDir: '/opt/apps/myapp', resolved: true } as never

describe('shared networks', () => {
	afterEach(() => vi.unstubAllEnvs())
	it('defaults to web, internal and infra only', () => {
		expect(SHARED_NETWORKS).toEqual(['web', 'internal', 'infra'])
		expect(sharedNetworks({})).toEqual(['web', 'internal', 'infra'])
	})
	it('POWDER_SHARED_NETWORKS adds valid names, drops invalid ones', () => {
		expect(sharedNetworks({ POWDER_SHARED_NETWORKS: ' stack_default, bad name ,-x,' })).toEqual([
			'web',
			'internal',
			'infra',
			'stack_default',
		])
	})
	it('a stack network is refused unless the operator names it', () => {
		vi.stubEnv('POWDER_SHARED_NETWORKS', '')
		expect(composeViolations(doc, ctx).map((v) => v.code)).toContain('network')
		vi.stubEnv('POWDER_SHARED_NETWORKS', 'stack_default')
		expect(composeViolations(doc, ctx).map((v) => v.code)).not.toContain('network')
	})
})
