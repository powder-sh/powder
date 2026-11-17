import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dbMode: 'reject' | 'empty' | 'row' = 'reject'
let pinned = { keyType: 'ssh-ed25519', sha256: '' }

vi.mock('@powder/db', () => {
	const chain = (): unknown => {
		const q: Record<string, unknown> = {}
		q.from = () => q
		q.where = () => q
		q.limit = () => (dbMode === 'reject' ? Promise.reject(new Error('db down')) : Promise.resolve(dbMode === 'row' ? [pinned] : []))
		return q
	}
	return {
		db: { select: chain, insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.reject(new Error('db down')) }) }) },
		eq: () => null,
		sshHostKeys: { host: 'host' },
	}
})

import { explainSshError, hostKeyChecksOff, hostKeyFingerprint, hostVerifierFor, pinKey, warnIfHostKeyChecksDisabled } from '../ssh-host-keys'

// ssh wire blob: uint32 len + "ssh-ed25519" + junk
const blob = (n: number) => {
	const t = Buffer.from('ssh-ed25519')
	const b = Buffer.alloc(4)
	b.writeUInt32BE(t.length)
	return Buffer.concat([b, t, Buffer.from([n])])
}
const verifyOf = (host: string, port: number | undefined, key: Buffer) =>
	new Promise<boolean>((resolve) => hostVerifierFor(host, port)(key, resolve))

const saved = process.env.POWDER_SSH_HOSTKEY_MODE
beforeEach(() => {
	delete process.env.POWDER_SSH_HOSTKEY_MODE
	vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
	if (saved === undefined) delete process.env.POWDER_SSH_HOSTKEY_MODE
	else process.env.POWDER_SSH_HOSTKEY_MODE = saved
	vi.restoreAllMocks()
})

describe('ssh host keys', () => {
	it('pins per host+port; port 22 keeps the bare-host row', () => {
		expect(pinKey('1.2.3.4')).toBe('1.2.3.4')
		expect(pinKey('1.2.3.4', 22)).toBe('1.2.3.4')
		expect(pinKey('1.2.3.4', 2222)).toBe('1.2.3.4:2222')
		// case and whitespace are normalised so one server is one pin
		expect(pinKey('  Server.Example.COM ')).toBe('server.example.com')
		expect(pinKey('Server.Example.com', 2222)).toBe('server.example.com:2222')
		expect(pinKey('SERVER.example.com')).toBe(pinKey('server.example.com'))
	})
	it('fails CLOSED on a DB error and explains why', async () => {
		dbMode = 'reject'
		expect(await verifyOf('9.9.9.1', 22, blob(1))).toBe(false)
		const e = explainSshError('9.9.9.1', new Error('Handshake failed: Host denied (verification failed)'), 22)
		expect(e.message).toMatch(/control-plane database errored/)
		expect(e.message).toMatch(/Refusing the connection/)
	})
	it('fails closed when the pin cannot be stored (empty read after insert)', async () => {
		dbMode = 'empty'
		expect(await verifyOf('9.9.9.2', 22, blob(1))).toBe(false)
	})
	it('accepts a matching pinned key and refuses a different one, per port', async () => {
		dbMode = 'row'
		pinned = { keyType: 'ssh-ed25519', sha256: hostKeyFingerprint(blob(1)) }
		expect(await verifyOf('9.9.9.3', 2222, blob(1))).toBe(true)
		expect(await verifyOf('9.9.9.4', 2222, blob(2))).toBe(false)
		expect(explainSshError('9.9.9.4', new Error('verification failed'), 2222).message).toMatch(/host = '9\.9\.9\.4:2222'/)
	})
	it('POWDER_SSH_HOSTKEY_MODE=off is an explicit opt-out that warns at startup', async () => {
		process.env.POWDER_SSH_HOSTKEY_MODE = 'off'
		dbMode = 'reject'
		expect(hostKeyChecksOff()).toBe(true)
		expect(await verifyOf('9.9.9.5', 22, blob(1))).toBe(true)
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		warnIfHostKeyChecksDisabled()
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('POWDER_SSH_HOSTKEY_MODE=off'))
	})
})
