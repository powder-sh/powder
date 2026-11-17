import { EventEmitter } from 'node:events'
import { Client } from 'ssh2'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	const fs = require('node:fs') as typeof import('node:fs')
	const os = require('node:os') as typeof import('node:os')
	const p = `${os.tmpdir()}/powder-test-key-${process.pid}`
	fs.writeFileSync(p, 'not a real key')
	process.env.SSH_KEY_PATH = p
})

import { runDeployScript } from '../ssh'
import { NOCREDS_PREFIX } from '../docker-env'

// Bug 1: an SSH drop DURING the run must not re-run the whole script inline.
// Only a failed SFTP upload may fall back to inline execution.

const server = { id: 'x', host: '127.0.0.1', user: 'root' } as never
let execCalls = 0
const execCmds: string[] = []
let sftpFails = false
let execBehaviour: 'reset' | 'ok' = 'ok'

beforeAll(() => {
	vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client) {
		setImmediate(() => this.emit('ready'))
		return this
	})
	vi.spyOn(Client.prototype, 'end').mockImplementation(function (this: Client) {
		return this
	})
	vi.spyOn(Client.prototype, 'sftp').mockImplementation(((cb: (e: Error | undefined, s?: unknown) => void) => {
		if (sftpFails) return cb(new Error('sftp subsystem unavailable'))
		const ws = Object.assign(new EventEmitter(), { end: () => setImmediate(() => ws.emit('close')) })
		cb(undefined, { createWriteStream: () => ws })
		return true
	}) as unknown as Client['sftp'])
	vi.spyOn(Client.prototype, 'exec').mockImplementation(function (this: Client, cmd: string, cb: (e: undefined, s: unknown) => void) {
		execCalls++
		// every exec carries the login-free docker prefix; the assertions read what follows it.
		expect(cmd.startsWith(NOCREDS_PREFIX)).toBe(true)
		execCmds.push(cmd.slice(NOCREDS_PREFIX.length))
		const s = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
		cb(undefined, s)
		setImmediate(() => {
			if (execBehaviour === 'reset') this.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
			else s.emit('close', 0)
		})
		return true
	} as unknown as Client['exec'])
})
afterEach(() => {
	execCalls = 0
	execCmds.length = 0
	sftpFails = false
	execBehaviour = 'ok'
})

describe('runDeployScript fallback', () => {
	it('a connection reset mid-run rejects and does NOT run the script a second time', async () => {
		execBehaviour = 'reset'
		await expect(runDeployScript(server, 'echo hi', 'dep_1')).rejects.toThrow()
		expect(execCalls).toBe(1)
	})

	it('a failed SFTP upload falls back to a chunked exec upload, then runs the uploaded file', async () => {
		sftpFails = true
		const r = await runDeployScript(server, 'echo hi', 'dep_2')
		expect(r.code).toBe(0)
		expect(execCalls).toBe(2) // one upload chunk + the run
		expect(execCmds[0]).toMatch(/^umask 077; printf %s '[A-Za-z0-9+/=]+' \| base64 -d > '\/tmp\/powder-deploy-dep_2\.tmp\./)
		expect(execCmds[1]).toMatch(/^timeout -k 30 \d+ bash '\/tmp\/powder-deploy-dep_2\.tmp\./)
	})

	it('a 40 KB script is uploaded in 16 KB base64 chunks that rebuild it byte for byte (no 32 KB exec payload)', async () => {
		sftpFails = true
		const script = `${'echo "ü ──";\n'.repeat(4000)}`
		expect(Buffer.byteLength(script)).toBeGreaterThan(40_000)
		await runDeployScript(server, script, 'dep_3')
		const uploads = execCmds.slice(0, -1)
		expect(uploads.length).toBeGreaterThanOrEqual(4)
		let rebuilt = Buffer.alloc(0)
		uploads.forEach((c, i) => {
			const m = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d (>>?) /.exec(c)
			if (!m) throw new Error(`no upload chunk in: ${c}`)
			expect(m[2]).toBe(i === 0 ? '>' : '>>')
			expect((m[1] ?? '').length).toBeLessThanOrEqual(16 * 1024)
			expect(NOCREDS_PREFIX.length + c.length).toBeLessThan(32 * 1024)
			rebuilt = Buffer.concat([rebuilt, Buffer.from(m[1] ?? '', 'base64')])
		})
		expect(rebuilt.toString('utf8')).toBe(script)
		expect(execCmds[execCmds.length - 1]).toMatch(/^timeout -k 30 \d+ bash /)
	})
})
