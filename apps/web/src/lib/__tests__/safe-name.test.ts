import { describe, expect, it, vi } from 'vitest'

// SAFE_NAME allowed a leading dash, so a "container name" like `--help` or
// `-f` reached `docker logs/restart/inspect` as an option. Names now start with a
// letter or digit (Docker's own rule) and the commands end options with `--`.

const h = vi.hoisted(() => ({ cmds: [] as string[] }))
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		h.cmds.push(cmd)
		return {
			code: 0,
			stdout: cmd.startsWith('docker inspect')
				? JSON.stringify([
						{
							Name: '/shop',
							Config: { Image: 'x', Env: [], Labels: {} },
							State: { Status: 'running', StartedAt: '', Restarting: false },
							Created: '',
							HostConfig: { RestartPolicy: { Name: 'no' } },
							RestartCount: 0,
							NetworkSettings: { Ports: {} },
							Mounts: [],
						},
					])
				: '',
			stderr: '',
		}
	},
	withConnection: async () => {},
}))

import { SAFE_NAME, assertSafeName } from '../shell'
import { inspectContainer } from '../ssh/discovery'
import { getContainerLogs, restartContainer } from '../ssh/logs'

const server = {
	id: 's',
	name: 's',
	host: '10.0.0.1',
	user: 'root',
	port: 22,
	kind: 'compose' as const,
}

describe('SAFE_NAME', () => {
	it('refuses a leading dash, dot or underscore', () => {
		for (const n of ['-f', '--help', '--since=1h', '.hidden', '_x', '-'])
			expect(SAFE_NAME.test(n), n).toBe(false)
		expect(() => assertSafeName('--help')).toThrow(/unsafe container name/)
	})
	it('accepts the names Docker accepts', () => {
		for (const n of ['shop', 'shop-db', 'shop_worker.1', '0app', 'A', 'my-app-pr-12'])
			expect(SAFE_NAME.test(n), n).toBe(true)
	})
})

describe('docker commands end options before the name', () => {
	it('logs, restart and inspect pass `-- <name>`', async () => {
		await getContainerLogs(server, 'shop', 10)
		await restartContainer(server, 'shop')
		await inspectContainer(server, 'shop')
		// the restart inspects first, then runs a guarded `docker restart` in bash
		expect(h.cmds).toHaveLength(4)
		expect(h.cmds[0]).toBe('docker logs --tail=10 --timestamps -- shop 2>&1')
		expect(h.cmds[1]).toBe('docker inspect -- shop')
		expect(h.cmds[2]).toContain("--format '\\''{{.State.Running}}'\\'' -- shop")
		expect(h.cmds[2]).toMatch(/docker restart -- shop'$/)
		expect(h.cmds[3]).toBe('docker inspect -- shop')
	})
	it('a dash name never reaches a command', async () => {
		h.cmds.length = 0
		await expect(getContainerLogs(server, '--help')).rejects.toThrow()
		await expect(restartContainer(server, '-t')).rejects.toThrow()
		expect(h.cmds).toEqual([])
	})
})
