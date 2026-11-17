import { describe, expect, it } from 'vitest'
import { serviceImageLabelGuardShell } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'

// POWDER_BUILD_PULL applied to the deployed service only; a sibling service
// the deploy builds (to check its image labels) built without --pull and could read
// another app's local image.

const base = {
	workingDir: '/opt/apps/shop',
	configFile: '/opt/apps/shop/docker-compose.yml',
	service: 'app',
	cf: "-f '/opt/apps/shop/docker-compose.yml'",
	declaredMode: 'auto' as const,
	prebuilt: false,
	infra: null,
	wantBranch: null,
	wantSha: null,
	shaIsStrict: false,
	cacheNamespace: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
}

describe('sibling service builds follow the pull setting', () => {
	it('builds siblings with --pull when the deploy pulls', () => {
		const s = buildDeployScript({ ...base, buildPull: true })
		expect(s).toContain(`build --pull "$LB_S"`)
		expect(s).toContain(`build --pull 'app'`)
	})
	it('without pull neither build gets --pull', () => {
		const s = buildDeployScript({ ...base, buildPull: false })
		expect(s).not.toContain('build --pull')
		expect(serviceImageLabelGuardShell("-f 'x.yml'", "-f 'x.yml'", 'app', '')).toContain(
			`build "$LB_S"`,
		)
	})
})
