import { afterEach, describe, expect, it, vi } from 'vitest'

// A synchronous connect failure (unreadable SSH key) must reject cleanly. A
// timeout timer armed before the connection exists would call .end() on an unset
// const: an uncaught ReferenceError that kills the worker.
describe('sync connect failure', () => {
	const prev = process.env.SSH_KEY_PATH
	afterEach(() => {
		if (prev === undefined) delete process.env.SSH_KEY_PATH
		else process.env.SSH_KEY_PATH = prev
		vi.resetModules()
	})

	async function load() {
		process.env.SSH_KEY_PATH = '/nonexistent/key'
		vi.resetModules()
		return import('../ssh/connection')
	}
	const server = { id: 's', name: 's', host: '127.0.0.1', port: 22, user: 'root' } as never

	it('runCommand rejects and no uncaught exception follows the short timeout', async () => {
		const { runCommand } = await load()
		const uncaught: unknown[] = []
		const onUncaught = (e: unknown) => uncaught.push(e)
		process.on('uncaughtException', onUncaught)
		try {
			await expect(runCommand(server, 'true', 30)).rejects.toThrow(/ENOENT|no such file/i)
			await new Promise((r) => setTimeout(r, 150))
		} finally {
			process.off('uncaughtException', onUncaught)
		}
		expect(uncaught).toEqual([])
	})

	it('writeFileViaSftp rejects cleanly too', async () => {
		await load()
		const { writeFileViaSftp } = await import('../ssh/files')
		const uncaught: unknown[] = []
		const onUncaught = (e: unknown) => uncaught.push(e)
		process.on('uncaughtException', onUncaught)
		try {
			await expect(writeFileViaSftp(server, '/tmp/x', 'a', 0o600, 30, true)).rejects.toThrow(/ENOENT|no such file/i)
			await new Promise((r) => setTimeout(r, 150))
		} finally {
			process.off('uncaughtException', onUncaught)
		}
		expect(uncaught).toEqual([])
	})
})
