import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const rows = new Map<string, { keyType: string; sha256: string }>()
const inserted: string[] = []
vi.mock('@powder/db', () => ({
	db: {
		select: () => {
			let k = ''
			const q: Record<string, unknown> = {}
			q.from = () => q
			q.where = (v: string) => {
				k = v
				return q
			}
			q.limit = () => Promise.resolve(rows.has(k) ? [rows.get(k)] : [])
			return q
		},
		insert: () => ({
			values: (v: { host: string; keyType: string; sha256: string }) => ({
				onConflictDoNothing: () => {
					inserted.push(v.host)
					rows.set(v.host, v)
					return Promise.resolve()
				},
			}),
		}),
	},
	eq: (_c: unknown, v: string) => v,
	sshHostKeys: { host: 'host' },
}))

import { hostKeyFingerprint, hostVerifierFor } from '../ssh-host-keys'

const blob = (n: number) => {
	const t = Buffer.from('ssh-ed25519')
	const b = Buffer.alloc(4)
	b.writeUInt32BE(t.length)
	return Buffer.concat([b, t, Buffer.from([n])])
}
const verify = (host: string, port: number | undefined, key: Buffer) =>
	new Promise<boolean>((r) => hostVerifierFor(host, port)(key, r))

describe('pre-normalisation pins', () => {
	it('a mixed-case un-normalised row is honoured: match accepted, other key refused, nothing re-pinned', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		rows.set('Server.Example.com', { keyType: 'ssh-ed25519', sha256: hostKeyFingerprint(blob(1)) })
		expect(await verify('Server.Example.com', 22, blob(1))).toBe(true)
		rows.set('Other.example.com:2222', { keyType: 'ssh-ed25519', sha256: hostKeyFingerprint(blob(1)) })
		expect(await verify('Other.example.com', 2222, blob(2))).toBe(false)
		expect(inserted).toEqual([])
	})
	it('a host with no row at all is still pinned on first use (normalised)', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		expect(await verify('Fresh.Example.com', 22, blob(3))).toBe(true)
		expect(inserted).toEqual(['fresh.example.com'])
	})
	it('migration 0049 normalises, keeps the existing row on conflict, is idempotent text', () => {
		const sql = readFileSync(join(__dirname, '../../../../../packages/db/drizzle/0049_ssh_host_keys_normalise.sql'), 'utf8')
		expect(sql).toMatch(/lower\(btrim/)
		expect(sql).toMatch(/NOT EXISTS/)
		expect(sql.startsWith('-- idempotent')).toBe(true)
	})
})
