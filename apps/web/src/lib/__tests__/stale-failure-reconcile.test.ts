// A servers sync may record a synthetic "reconcile" success after a failed deploy only
// for a registry-mode app whose running image id provably differs from the image the
// failed deploy targeted. The image name (a locally built image tagged like a registry
// image) never decides it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseImageIds, reconcileTarget, shouldReconcile } from '../stale-failure-reconcile'

const st = vi.hoisted(() => ({ inserts: [] as unknown[], cmds: [] as string[], stdout: '' }))
vi.mock('@/lib/db', () => ({
	and: () => 0,
	appDomains: {},
	appRepos: {},
	createId: () => 'dep_x',
	db: {
		select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
		insert: () => ({ values: async (v: unknown) => st.inserts.push(v) }),
	},
	deploys: {},
	desc: () => 0,
	eq: () => 0,
	prefixes: { deploy: 'dep' },
	sql: () => 0,
}))
vi.mock('@/lib/ssh', () => ({
	extractHostPorts: () => [],
	getContainerHostNetInfo: vi.fn(),
	getNginxRoutes: vi.fn(),
	listContainers: vi.fn(),
	runCommand: async (_s: unknown, cmd: string) => {
		st.cmds.push(cmd)
		return { stdout: st.stdout, stderr: '', code: 0 }
	},
}))
vi.mock('@/lib/app-domains', () => ({ isValidHostname: () => true, newChallenge: () => 'c' }))
vi.mock('@/lib/servers', () => ({ listAllServers: async () => [], updateServerStatus: vi.fn() }))

const A = `sha256:${'a'.repeat(64)}`
const B = `sha256:${'b'.repeat(64)}`
const SERVER = { id: 'srv-1', host: 'h' } as never
const failed = (imageTag: string | null) => ({ status: 'failed', imageTag })

describe('reconcileTarget / shouldReconcile', () => {
	it('only registry mode, only a failed last deploy that recorded an image reference', () => {
		expect(reconcileTarget({ buildMode: 'build', lastDeploy: failed('ghcr.io/demo/shop:deploy-1') })).toBeNull()
		expect(reconcileTarget({ buildMode: 'auto', lastDeploy: failed('ghcr.io/demo/shop:deploy-1') })).toBeNull()
		expect(reconcileTarget({ buildMode: 'registry', lastDeploy: failed(null) })).toBeNull()
		expect(reconcileTarget({ buildMode: 'registry', lastDeploy: { status: 'success', imageTag: 'x:1' } })).toBeNull()
		expect(reconcileTarget({ buildMode: 'registry', lastDeploy: failed('x:1; rm -rf /') })).toBeNull()
		expect(reconcileTarget({ buildMode: 'registry', lastDeploy: failed('ghcr.io/demo/shop:deploy-1') })).toBe(
			'ghcr.io/demo/shop:deploy-1',
		)
	})
	it('needs two resolved image ids that differ', () => {
		const base = { buildMode: 'registry', lastDeploy: failed('ghcr.io/demo/shop:deploy-1') }
		expect(shouldReconcile({ ...base, runningImageId: B, targetImageId: A })).toBe(true)
		expect(shouldReconcile({ ...base, runningImageId: A, targetImageId: A })).toBe(false)
		expect(shouldReconcile({ ...base, runningImageId: B, targetImageId: null })).toBe(false)
		expect(shouldReconcile({ ...base, runningImageId: null, targetImageId: A })).toBe(false)
		expect(shouldReconcile({ ...base, runningImageId: 'ghcr.io/demo/shop', targetImageId: A })).toBe(false)
	})
	it('parses one line per candidate', () => {
		expect(Object.fromEntries(parseImageIds(`shop\t${B}\t${A}\nblog\t${A}\t\nbad line\n`))).toEqual({
			shop: { running: B, target: A },
			blog: { running: A, target: null },
		})
	})
})

describe('reconcileStaleFailures writes only on evidence', () => {
	beforeEach(() => {
		st.inserts.length = 0
		st.cmds.length = 0
		st.stdout = ''
	})
	it('a build-mode app with a ghcr-named image and a failed last deploy gets no row and no SSH call', async () => {
		const { reconcileStaleFailures } = await import('../server-list')
		await reconcileStaleFailures(SERVER, [
			{ name: 'shop', image: 'ghcr.io/demo/shop:latest', buildMode: 'build', lastDeploy: failed(null) },
			{ name: 'blog', image: 'ghcr.io/demo/blog:latest', buildMode: 'build', lastDeploy: failed('ghcr.io/demo/blog:deploy-9') },
		])
		expect(st.inserts).toEqual([])
		expect(st.cmds).toEqual([])
	})
	it('a registry-mode app whose image changed gets one row', async () => {
		const { reconcileStaleFailures } = await import('../server-list')
		st.stdout = `shop\t${B}\t${A}\n`
		await reconcileStaleFailures(SERVER, [
			{ name: 'shop', image: 'registry.example.com/shop:latest', buildMode: 'registry', lastDeploy: failed('registry.example.com/shop:deploy-7') },
		])
		expect(st.inserts).toHaveLength(1)
		expect(st.inserts[0]).toMatchObject({ containerName: 'shop', status: 'success', triggeredBy: 'reconcile' })
		expect(st.cmds[0]).toContain("docker image inspect -f '{{.Id}}' -- 'registry.example.com/shop:deploy-7'")
	})
	it('a registry-mode app whose image did not change, or whose failed deploy recorded nothing, gets none', async () => {
		const { reconcileStaleFailures } = await import('../server-list')
		st.stdout = `shop\t${A}\t${A}\n`
		await reconcileStaleFailures(SERVER, [
			{ name: 'shop', image: 'registry.example.com/shop:latest', buildMode: 'registry', lastDeploy: failed('registry.example.com/shop:deploy-7') },
			{ name: 'blog', image: 'registry.example.com/blog:latest', buildMode: 'registry', lastDeploy: failed(null) },
		])
		expect(st.inserts).toEqual([])
	})
	it('server-list never keys the reconcile on the image name', async () => {
		const { readFileSync } = await import('node:fs')
		const { join } = await import('node:path')
		const src = readFileSync(join(__dirname, '../server-list.ts'), 'utf8')
		expect(src).not.toContain("startsWith('ghcr.io/')")
		expect(src).toMatch(/if \(sync\)\s+void reconcileStaleFailures\(/)
	})
})
