import { describe, expect, it } from 'vitest'
import { type ComposeGuardContext, composeViolations, isHighSeverity } from '../compose-safety'
import { deployGuardContext } from '../deploy/compose-check'

// a name a service BUILDS must not take another app's image. Real images often
// carry no app name at all, so no own prefix is required.
const ctx: ComposeGuardContext = {
	appName: 'myapp',
	projectDir: '/opt/apps/myapp',
	otherApps: ['victim', 'shop', 'shop-api'],
	foreignImagesAnyState: ['registry.example.com/team/stopped-thing:latest'],
	resolved: true,
}

const built = (image: string, extra: Record<string, unknown> = {}, c = ctx) =>
	composeViolations(
		{ name: 'myapp', services: { myapp: { image, build: { context: './src', ...extra } } } },
		c,
	).filter((v) => v.code === 'image')

describe('built image names', () => {
	it.each([
		'ghcr.io/acme/unrelated-name:latest',
		'acme-site-web:latest',
		'myapp:latest',
		'ghcr.io/acme/myapp-web:latest',
		'ghcr.io/acme/shop-api-web:latest',
	])('allows %s (no other app owns it)', (img) => {
		expect(
			built(img, {}, { ...ctx, appName: img.includes('shop-api') ? 'shop-api' : 'myapp' }),
		).toEqual([])
	})

	it.each([
		['ghcr.io/acme/victim:latest', 'victim'],
		['registry.example.com:5000/victim:1', 'victim'],
		['victim', 'victim'],
		['ghcr.io/acme/shop-api:latest', 'shop-api'],
	])('refuses %s (exactly the name of %s)', (img, owner) => {
		const v = built(img)
		expect(v).toHaveLength(1)
		expect(v[0]?.message).toContain(`app ${owner}`)
		expect(v[0] && isHighSeverity(v[0])).toBe(true)
	})

	// a shared prefix is not ownership (images often look like
	// `<other-app>-<thing>` without being that app's image).
	describe('prefix is not ownership', () => {
		const c = { ...ctx, appName: 'builder', otherApps: ['lizard', 'ab', 'tools', 'linkfarm'] }
		it.each([
			'lizard-goldlizardapp:latest',
			'ab-somebookapp:latest',
			'tools-feesapp:latest',
			'ghcr.io/acme/lizard-site:latest',
			'victim-web:latest',
			'victim_worker:1',
		])('allows %s built by another app', (img) => {
			expect(built(img, {}, c)).toEqual([])
		})
		it.each(['lizard', 'lizard:latest', 'ghcr.io/acme/lizard:latest'])('refuses %s', (img) => {
			expect(built(img, {}, c)[0]?.message).toContain('app lizard')
		})
	})

	it('applies to build.tags too', () => {
		const v = built('myapp:latest', { tags: ['ghcr.io/acme/victim:latest', 'myapp:v2'] })
		expect(v).toHaveLength(1)
		expect(v[0]?.message).toContain('build.tags')
	})

	it("refuses a ref another app's container uses, running or not", () => {
		expect(built('registry.example.com/team/stopped-thing:latest')[0]?.message).toContain(
			'another app',
		)
		expect(
			built('myapp:latest', { tags: ['registry.example.com/team/stopped-thing'] }),
		).toHaveLength(1)
	})

	it("refuses powder's :deploy-* rollback tags", () => {
		expect(built('myapp:deploy-1234')[0]?.message).toContain(':deploy-*')
		expect(built('myapp:latest', { tags: ['ghcr.io/acme/x:deploy-9'] })).toHaveLength(1)
		expect(built('myapp:deployed')).toEqual([])
		expect(built('myapp:predeploy-1')).toEqual([])
	})

	it('deployGuardContext collects other projects images in any state, not strays', () => {
		const c = deployGuardContext(
			{
				resolved: { name: 'myapp' },
				raw: null,
				hash: 'x',
				containers: [
					{ name: 'v', image: 'shared-img:1', project: 'victim', state: 'exited' },
					{ name: 'stray', image: 'stray-img:1', project: '', state: 'running' },
					{ name: 'myapp', image: 'myapp:latest', project: 'myapp', state: 'running' },
				],
			},
			{
				appName: 'myapp',
				workingDir: '/opt/apps/myapp',
				composeFiles: ['/opt/apps/myapp/docker-compose.yml'],
				serverId: 's1',
				routeHosts: null,
			},
		)
		expect(c.foreignImagesAnyState).toEqual(['shared-img:1'])
	})
})
