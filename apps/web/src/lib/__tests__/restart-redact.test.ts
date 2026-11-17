import { describe, expect, it, vi } from 'vitest'

// a failed restart's guard output reaches the API body and the deploys row
// only through redactSecrets.

// built at runtime so the source holds no token-shaped literal
const SECRET = ['ghp', `${'Example'.repeat(4)}0123`].join('_')

vi.mock('../ssh/connection', () => ({
	runCommand: vi.fn(async () => ({ code: 1, stdout: `env file guard: refusing, DEMO_TOKEN=${SECRET} in /opt/apps/demoapp.env\n`, stderr: '' })),
	withConnection: vi.fn(),
}))
vi.mock('../ssh/discovery', () => ({
	inspectContainer: vi.fn(async () => ({ compose: { project: '', workingDir: '', configFile: '', configFiles: [] } })),
}))

import { restartContainer } from '../ssh/logs'

describe('restart error output', () => {
	it('masks secret shapes in the thrown message', async () => {
		const server = { id: 's1', host: '127.0.0.1' } as never
		const err = await restartContainer(server, 'demoapp').catch((e: unknown) => e as Error)
		expect(err).toBeInstanceOf(Error)
		expect((err as Error).message).toContain('env file guard: refusing')
		expect((err as Error).message).not.toContain(SECRET)
	})
})
