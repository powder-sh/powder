// A container page on an unreachable server must get a clear 503 with a
// redacted reason, never a bare 500.
import { describe, expect, it, vi } from 'vitest'
import { DockerCommandError, containerReadError } from '../container-state'

const inspect = vi.fn()
vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => ({
		user: { id: 'a', isAdmin: true },
		server: { id: 's', kind: 'compose' },
	}),
}))
vi.mock('@/lib/ssh', () => ({
	inspectContainer: (...a: unknown[]) => inspect(...a),
	getGitStatus: vi.fn(),
}))

import { GET as inspectGET } from '../../app/api/servers/[id]/containers/[name]/inspect/route'
import { GET as gitGET } from '../../app/api/servers/[id]/containers/[name]/git-status/route'

const ctx = { params: Promise.resolve({ id: 's', name: 'app' }) }

describe('container reads on a server that does not answer', () => {
	it('inspect and git-status answer 503 with the reason, not 500', async () => {
		inspect.mockRejectedValue(
			Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' }),
		)
		for (const GET of [inspectGET, gitGET]) {
			const res = await GET(new Request('http://x/api'), ctx)
			expect(res.status).toBe(503)
			expect(await res.json()).toEqual({
				error: 'Timed out while waiting for handshake',
				code: 'server_unreachable',
			})
		}
	})
	it('docker failing is 502, a missing container 404', async () => {
		expect(containerReadError(new DockerCommandError('Cannot connect to the Docker daemon')).status).toBe(502)
		expect(containerReadError(new Error('Error: No such object: app')).status).toBe(404)
	})
	it('the reason is redacted', async () => {
		const res = containerReadError(new Error('connect ECONNREFUSED; DATABASE_URL=postgres://u:hunter2@db/x'))
		expect(res.status).toBe(503)
		expect(JSON.stringify(await res.json())).not.toContain('hunter2')
	})
})
