// `--pull` on builds: FROM / COPY --from resolve from the registry, never
// another app's local-only image. Default on; POWDER_BUILD_PULL=0
// opts out (Docker Hub anonymous limits can block a burst of builds).
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({}))
import { buildBuilderScript } from '../builder'
import { buildPullEnabled } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'

const deploy = (buildPull?: boolean) =>
	buildDeployScript({
		workingDir: '/opt/apps/x',
		configFile: '/opt/apps/x/docker-compose.yml',
		service: 'x',
		cf: "-f '/opt/apps/x/docker-compose.yml'",
		declaredMode: 'build',
		prebuilt: false,
		infra: [],
		wantBranch: null,
		wantSha: null,
		shaIsStrict: false,
		buildPull,
	})
const builder = (pull?: boolean) =>
	buildBuilderScript({
		dir: '/tmp/b',
		keyPath: '/tmp/k',
		repoUrl: 'git@github.com:o/r.git',
		branch: 'main',
		sha: null,
		image: 'o/r',
		uniq: 'o-r:1',
		ctx: '/tmp/b/src',
		df: '/tmp/b/src/Dockerfile',
		buildArgs: '',
		pull,
	})

describe('build --pull', () => {
	it('is on by default; POWDER_BUILD_PULL=0 opts out', () => {
		expect(buildPullEnabled({})).toBe(true)
		expect(buildPullEnabled({ POWDER_BUILD_PULL: '' })).toBe(true)
		for (const v of ['0', 'false', 'off', 'no', ' OFF '])
			expect(buildPullEnabled({ POWDER_BUILD_PULL: v }), v).toBe(false)
		expect(deploy(false)).toMatch(/\$STAGE_F build 'x'/)
		// the dedicated builder always pulls (its image check uses the target's lists)
		expect(builder(false)).toContain("docker build --pull -t 'o-r:1'")
	})
	it('on: --pull for both build paths', () => {
		expect(buildPullEnabled({ POWDER_BUILD_PULL: '1' })).toBe(true)
		expect(deploy(true)).toMatch(/\$STAGE_F build --pull 'x'/)
		expect(builder(true)).toContain("docker build --pull -t 'o-r:1'")
	})
})
