// a compose may not take another registered app's container name (or its
// -db) even while that container does not exist, but keeps its own name and -db and
// the containers already in its own compose project.
import { describe, expect, it } from 'vitest'
import { composeViolations, isHighSeverity } from '../compose-safety'
import { deployGuardContext } from '../deploy/compose-check'

const cfg = (names: string[]) => ({
	name: 'shop',
	services: Object.fromEntries(names.map((n, i) => [`s${i}`, { image: 'x', container_name: n }])),
})
const ctx = (extra: Record<string, unknown> = {}) => ({
	appName: 'shop',
	projectDir: '/opt/apps/shop',
	otherApps: ['blog', 'api-worker'],
	resolved: true,
	...extra,
})
const cn = (v: ReturnType<typeof composeViolations>) => v.filter((x) => x.code === 'container_name').map((x) => x.message)

describe('container_name', () => {
	it("denies another app's name and its -db, as a high-severity code", () => {
		const v = composeViolations(cfg(['blog', 'blog-db']), ctx())
		expect(cn(v)).toHaveLength(2)
		expect(v.filter((x) => x.code === 'container_name').every(isHighSeverity)).toBe(true)
	})
	it('allows the own name and own -db', () => {
		expect(cn(composeViolations(cfg(['shop', 'shop-db']), ctx()))).toEqual([])
	})
	it('allows a registered app whose container already runs in this compose project', () => {
		const input = {
			resolved: cfg(['shop', 'api-worker']),
			raw: null,
			hash: 'h',
			containers: [
				{ name: 'shop', image: 'x', project: 'shop', state: 'running' },
				{ name: 'api-worker', image: 'x', project: 'shop', state: 'running' },
			],
		}
		const c = deployGuardContext(input, {
			appName: 'shop',
			workingDir: '/opt/apps/shop',
			composeFiles: ['/opt/apps/shop/docker-compose.yml'],
			serverId: null,
			routeHosts: null,
			otherApps: ['blog', 'api-worker'],
		})
		expect(cn(composeViolations(input.resolved, c))).toEqual([])
	})
})
