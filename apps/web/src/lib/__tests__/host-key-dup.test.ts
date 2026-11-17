import { describe, expect, it, vi } from 'vitest'

// checkNewServerHost compares the new host's resolved IPs with the known
// servers once; DNS can be re-pointed at an existing server before powder's first
// connection, which would then pin that server's key a second time under the new name.
// The first pin is refused when the presented key is already pinned elsewhere.

const h = vi.hoisted(() => ({
	rows: [] as Array<{ host: string; keyType: string; sha256: string }>,
	inserted: [] as string[],
	servers: [{ host: '10.0.0.5', sshPort: '22', buildHost: null as string | null }],
}))
vi.mock('@powder/db', () => ({
	db: {
		select: () => {
			let pred: { col: string; v: string } = { col: '', v: '' }
			let table = ''
			const q: Record<string, unknown> = {}
			q.from = (t: { name: string }) => {
				table = t.name
				return q
			}
			q.where = (p: { col: string; v: string }) => {
				pred = p
				return q
			}
			q.limit = () =>
				Promise.resolve(
					table === 'servers'
						? h.servers
						: h.rows.filter((r) => r[pred.col as 'host' | 'sha256'] === pred.v),
				)
			return q
		},
		insert: () => ({
			values: (v: { host: string; keyType: string; sha256: string }) => ({
				onConflictDoNothing: () => {
					h.inserted.push(v.host)
					if (!h.rows.some((r) => r.host === v.host)) h.rows.push(v)
					return Promise.resolve()
				},
			}),
		}),
	},
	eq: (c: string, v: string) => ({ col: c, v }),
	sshHostKeys: { name: 'ssh_host_keys', host: 'host', sha256: 'sha256' },
	servers: { name: 'servers', host: 'host', sshPort: 'ssh_port', buildHost: 'build_host' },
}))

import { hostKeyFingerprint, hostVerifierFor } from '../ssh-host-keys'

const blob = (n: number) => {
	const t = Buffer.from('ssh-ed25519')
	const b = Buffer.alloc(4)
	b.writeUInt32BE(t.length)
	return Buffer.concat([b, t, Buffer.from([n])])
}
const verify = (host: string, key: Buffer, port?: number) =>
	new Promise<boolean>((r) => hostVerifierFor(host, port)(key, r))

describe('first pin of a key already pinned under another host', () => {
	it('is refused and not stored', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		h.rows.push({ host: '10.0.0.5', keyType: 'ssh-ed25519', sha256: hostKeyFingerprint(blob(1)) })
		expect(await verify('new.example.com', blob(1))).toBe(false)
		expect(h.inserted).toEqual([])
		expect(h.rows.map((r) => r.host)).toEqual(['10.0.0.5'])
	})
	it('an old pin of an address no server uses does not block the move', async () => {
		h.rows.push({
			host: '203.0.113.7',
			keyType: 'ssh-ed25519',
			sha256: hostKeyFingerprint(blob(7)),
		})
		expect(await verify('10.9.9.9', blob(7))).toBe(true)
		expect(h.inserted).toEqual(['10.9.9.9'])
		h.inserted.length = 0
	})
	it('the existing host keeps connecting; a new server with its own key is pinned', async () => {
		expect(await verify('10.0.0.5', blob(1))).toBe(true)
		expect(await verify('other.example.com', blob(2))).toBe(true)
		expect(h.inserted).toEqual(['other.example.com'])
	})
})
