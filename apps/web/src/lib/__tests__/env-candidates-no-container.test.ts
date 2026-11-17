import { beforeEach, describe, expect, it, vi } from 'vitest'

const inspectContainer = vi.fn()
const runCommand = vi.fn()
vi.mock('../ssh/discovery', () => ({ inspectContainer: (...a: unknown[]) => inspectContainer(...a) }))
vi.mock('../ssh/connection', () => ({
	runCommand: (...a: unknown[]) => runCommand(...a),
	withConnection: vi.fn(),
}))

import { envFileCandidatesFor } from '../ssh/files'

const server = {} as never

describe('envFileCandidatesFor when the container never existed', () => {
	beforeEach(() => {
		inspectContainer.mockReset()
		runCommand.mockReset()
	})
	it('falls back to the compose env_file, then /opt/apps/<name>.env', async () => {
		inspectContainer.mockRejectedValue(new Error('Error: No such object: demo'))
		runCommand.mockResolvedValue({ stdout: 'services:\n  app:\n    env_file:\n      - /opt/apps/demo.env\n      - ./extra.env\n', code: 0 })
		const c = await envFileCandidatesFor(server, 'demo')
		expect(c[0]).toBe('/opt/apps/demo.env')
		expect(c).toContain('/opt/apps/demo/extra.env')
		expect(c.filter((p) => p === '/opt/apps/demo.env')).toHaveLength(1)
	})
	it('still returns /opt/apps/<name>.env when there is no compose file', async () => {
		inspectContainer.mockRejectedValue(new Error('no such container: demo'))
		runCommand.mockResolvedValue({ stdout: '', code: 1 })
		expect(await envFileCandidatesFor(server, 'demo')).toEqual(['/opt/apps/demo.env'])
	})
	it('rethrows any other inspect error', async () => {
		inspectContainer.mockRejectedValue(new Error('ssh timeout'))
		await expect(envFileCandidatesFor(server, 'demo')).rejects.toThrow('ssh timeout')
	})
})
