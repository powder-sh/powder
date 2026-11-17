import { PassThrough } from 'node:stream'
import { Client } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCommand } from '../ssh/connection'

// A multibyte char split across two chunks must decode intact: the deploy
// banner regexes ("── git rev-parse ──") missed intermittently otherwise.
afterEach(() => vi.restoreAllMocks())

function fakeExec(chunks: Buffer[], errChunks: Buffer[] = []) {
	vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client) {
		setImmediate(() => this.emit('ready'))
		return this
	})
	vi.spyOn(Client.prototype, 'end').mockImplementation(function (this: Client) {
		return this
	})
	vi.spyOn(Client.prototype, 'exec').mockImplementation(((_cmd: string, cb: (e: undefined, s: unknown) => void) => {
		const s = Object.assign(new PassThrough(), { stderr: new PassThrough() })
		cb(undefined, s)
		setImmediate(() => {
			for (const c of chunks) s.write(c)
			for (const c of errChunks) s.stderr.write(c)
			setTimeout(() => s.emit('close', 0), 20)
		})
		return true
	}) as unknown as Client['exec'])
}

describe('runCommand utf8 decoding', () => {
	it('keeps the banner intact when the multibyte dash is split at byte 1', async () => {
		const banner = Buffer.from('── git rev-parse ──\nabc1234\nmain\n', 'utf8')
		fakeExec([banner.subarray(0, 1), banner.subarray(1)])
		const seen: string[] = []
		const r = await runCommand({ host: 'h', user: 'root' } as never, 'x', 5_000, (c) => seen.push(c))
		expect(r.stdout).toBe('── git rev-parse ──\nabc1234\nmain\n')
		expect(seen.join('')).toBe(r.stdout)
		expect(r.stdout).not.toContain('�')
		expect(r.stdout).toMatch(/── git rev-parse ──\s*\n([0-9a-f]{7,40})\s*\n(\S+)\s*\n/)
	})
	it('does the same for stderr', async () => {
		const e = Buffer.from('fehler: ä ö ✗\n', 'utf8')
		fakeExec([], [e.subarray(0, 9), e.subarray(9)])
		const r = await runCommand({ host: 'h', user: 'root' } as never, 'x', 5_000)
		expect(r.stderr).toBe('fehler: ä ö ✗\n')
	})
})
