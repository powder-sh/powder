// a service WITHOUT a build section must not run another app's locally built
// image (`victim:latest`, `victim-web:deploy-12`): that hands it the other app's code
// and build-time secrets. The server's app names come from powder (otherApps).
import { describe, expect, it } from 'vitest'
import { type ComposeGuardContext, composeViolations, isHighSeverity } from '../compose-safety'
import { deployGuardContext } from '../deploy/compose-check'

const ctx: ComposeGuardContext = {
	appName: 'myapp',
	projectDir: '/opt/apps/myapp',
	otherApps: ['victim', 'api'],
	resolved: true,
}

function found(services: Record<string, unknown>, c: ComposeGuardContext = ctx) {
	return composeViolations({ name: 'myapp', services }, c).filter((v) => v.code === 'image_foreign')
}

describe('image_foreign', () => {
	it('refuses a sibling service running another app image by name', () => {
		const svc = (image: string) => ({
			myapp: { image: 'myapp:latest', build: { context: './src' } },
			worker: { image },
		})
		expect(found(svc('victim:latest'))).toHaveLength(1)
		expect(found(svc('victim'))).toHaveLength(1)
		expect(found(svc('docker.io/library/victim:deploy-12'))).toHaveLength(1)
		expect(found(svc('victim-web:latest'))).toHaveLength(1)
		expect(found(svc('api_worker:1'))).toHaveLength(1)
		const v = found(svc('victim:latest'))[0]
		expect(v && isHighSeverity(v)).toBe(true)
	})

	it('allows own images, digest pins, registry and unrelated images', () => {
		const svc = (image: string) => ({ worker: { image } })
		expect(found(svc('myapp:latest'))).toEqual([])
		expect(found(svc('myapp-worker:2'))).toEqual([])
		expect(found(svc('postgres:16'))).toEqual([])
		expect(found(svc('ghcr.io/acme/victim:latest'))).toEqual([])
		expect(found(svc(`victim@sha256:${'a'.repeat(64)}`))).toEqual([])
		// a built service is checked by the image/image_name rules instead
		expect(found({ worker: { image: 'victim:latest', build: { context: './src' } } })).toEqual([])
		// no app list (the /new render check): no finding
		expect(found(svc('victim:latest'), { ...ctx, otherApps: undefined })).toEqual([])
	})

	it('an app whose name prefixes another app keeps its own image', () => {
		const c = { ...ctx, appName: 'api-worker', projectDir: '/opt/apps/api-worker' }
		const doc = (image: string) => ({ name: 'api-worker', services: { 'api-worker': { image } } })
		expect(
			composeViolations(doc('api-worker:latest'), c).filter((v) => v.code === 'image_foreign'),
		).toEqual([])
		// but running api's image is the other app's
		expect(composeViolations(doc('api-prod:latest'), c).map((v) => v.code)).toContain(
			'image_foreign',
		)
	})

	it('refuses local image IDs and other projects compose-default image names', () => {
		const svc = (image: string, c: ComposeGuardContext = ctx) =>
			composeViolations({ name: 'myapp', services: { worker: { image } } }, c).filter(
				(v) => v.code === 'image_foreign',
			)
		expect(svc(`sha256:${'b'.repeat(64)}`)).toHaveLength(1)
		expect(svc('0123456789ab')).toHaveLength(1)
		expect(svc(`sha256:${'b'.repeat(64)}`, { ...ctx, otherApps: undefined })).toHaveLength(1)
		const c = { ...ctx, foreignProjectImages: ['legacystack-web'] }
		expect(svc('legacystack-web', c)).toHaveLength(1)
		expect(svc('legacystack-web:latest', c)).toHaveLength(1)
		expect(svc('myapp-web', c)).toEqual([])
	})

	it('the longest app name wins: app api cannot run app api-v2 images', () => {
		const c = { ...ctx, appName: 'api', projectDir: '/opt/apps/api', otherApps: ['api-v2'] }
		const doc = (image: string) => ({ name: 'api', services: { api: { image } } })
		const codes = (image: string) => composeViolations(doc(image), c).map((v) => v.code)
		expect(codes('api-v2-web:1')).toContain('image_foreign')
		expect(codes('api-v2:1')).toContain('image_foreign')
		expect(codes('api-web:1')).not.toContain('image_foreign')
		expect(codes('api:1')).not.toContain('image_foreign')
	})

	it('deployGuardContext derives other projects default image names', () => {
		const c = deployGuardContext(
			{
				resolved: { name: 'myapp' },
				raw: null,
				hash: 'x',
				containers: [
					{ name: 'v-web-1', image: 'v-web', project: 'v', state: 'exited', service: 'web' },
					{ name: 'myapp', image: 'myapp', project: 'myapp', state: 'running', service: 'myapp' },
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
		expect(c.foreignProjectImages).toEqual(['v-web'])
	})

	it('deployGuardContext carries the server app list to the authority', () => {
		const c = deployGuardContext(
			{ resolved: { name: 'myapp' }, raw: null, hash: 'x', containers: [] },
			{
				appName: 'myapp',
				workingDir: '/opt/apps/myapp',
				composeFiles: ['/opt/apps/myapp/docker-compose.yml'],
				serverId: 's1',
				routeHosts: null,
				otherApps: ['victim'],
			},
		)
		expect(c.otherApps).toEqual(['victim'])
	})
})
