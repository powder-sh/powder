// SSH host-key pinning, trust-on-first-use.
//
// powder connects to every server as root with the master key and ships env files
// and deploy keys over those sessions. ssh2 checks NO host key unless given a
// hostVerifier, so anyone able to intercept the route to a server (public-IP hops)
// could impersonate it and receive every secret we send. This pins the first
// key seen per host in `ssh_host_keys` and refuses any later mismatch.
//
// A legitimately rebuilt server (new host key) fails loudly until its row is
// deleted:  DELETE FROM ssh_host_keys WHERE host = '<ip>';  (non-22 ports are
// pinned as '<ip>:<port>'; port 22 keeps the bare '<ip>' row for compatibility).
// Explicit opt-out: POWDER_SSH_HOSTKEY_MODE=off disables the check entirely and
// logs a warning at startup (warnIfHostKeyChecksDisabled).
//
// Lookups are cached per process (host keys don't change). A DB error FAILS
// CLOSED: the connection is refused with a clear error, because
// accepting an unverified key is exactly what an interceptor who can also
// degrade the DB would want. Cached hosts keep working through a DB blip.

import { createHash } from 'node:crypto'
import { db, eq, servers, sshHostKeys } from '@powder/db'

/** Pin key for a host + ssh port. Port 22 (or unknown) maps to the bare host so
 *  rows written before per-port pinning stay valid. */
export function pinKey(host: string, port?: number): string {
	// DNS names are case-insensitive; `Server.example.com` and `server.example.com`
	// must be ONE pin, not two.
	const h = host.trim().toLowerCase()
	return port && port !== 22 ? `${h}:${port}` : h
}

/** the fingerprint (SHA256:<base64>) pinned for a server, or null when the
 *  server has not been connected to yet. Shown to the operator so the first-use pin
 *  can be checked against the server (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). */
export async function getPinnedFingerprint(host: string, port?: number): Promise<string | null> {
	const key = pinKey(host, port)
	const cached = cache.get(key)
	if (cached) return cached.sha256
	try {
		const [row] = await db.select().from(sshHostKeys).where(eq(sshHostKeys.host, key)).limit(1)
		return row?.sha256 ?? null
	} catch {
		return null
	}
}

/** True when the operator explicitly turned host-key checking off. */
export function hostKeyChecksOff(): boolean {
	return process.env.POWDER_SSH_HOSTKEY_MODE === 'off'
}

let warnedOff = false
/** Call once at process start (web instrumentation, worker). */
export function warnIfHostKeyChecksDisabled(): void {
	if (!hostKeyChecksOff() || warnedOff) return
	warnedOff = true
	console.warn(
		'[ssh-host-keys] WARNING: POWDER_SSH_HOSTKEY_MODE=off - SSH host keys are NOT verified. Every secret powder sends to a server (env files, deploy keys, backup passphrase) can be intercepted. Unset it to re-enable pinning.',
	)
}

const cache = new Map<string, { keyType: string; sha256: string }>()
const lastMismatch = new Map<string, string>()

/** Parse the key type out of an SSH wire-format public key blob
 *  (uint32 length + ascii type name + ...). */
export function hostKeyType(key: Buffer): string {
	if (key.length < 4) return 'unknown'
	const len = key.readUInt32BE(0)
	if (len <= 0 || len > 64 || key.length < 4 + len) return 'unknown'
	return key.subarray(4, 4 + len).toString('ascii')
}

/** OpenSSH-style fingerprint: SHA256:<base64 without padding>. */
export function hostKeyFingerprint(key: Buffer): string {
	return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export type HostKeyDecision =
	| { ok: true; firstUse: boolean }
	| { ok: false; reason: string }

/** Pure comparison against a pinned row (exported for tests). */
export function decideHostKey(
	host: string,
	pinned: { keyType: string; sha256: string } | null,
	seen: { keyType: string; sha256: string },
): HostKeyDecision {
	if (!pinned) return { ok: true, firstUse: true }
	if (pinned.sha256 === seen.sha256) return { ok: true, firstUse: false }
	return {
		ok: false,
		reason:
			`SSH HOST KEY MISMATCH for ${host}: pinned ${pinned.keyType} ${pinned.sha256}, ` +
			`server presented ${seen.keyType} ${seen.sha256}. Refusing to connect (possible interception). ` +
			`If the server was rebuilt: DELETE FROM ssh_host_keys WHERE host = '${host}';`,
	}
}

/** The un-normalised row key for a host + port (the host as typed). Only used as
 *  a read fallback, so a pin stored under that key still matches. */
function rawPinKey(host: string, port?: number): string {
	const h = host.trim()
	return port && port !== 22 ? `${h}:${port}` : h
}

async function lookupOrPin(
	host: string,
	seen: { keyType: string; sha256: string },
	rawHost?: string,
): Promise<HostKeyDecision> {
	const cached = cache.get(host)
	if (cached) return decideHostKey(host, cached, seen)
	const [row] = await db.select().from(sshHostKeys).where(eq(sshHostKeys.host, host)).limit(1)
	if (row) {
		cache.set(host, { keyType: row.keyType, sha256: row.sha256 })
		return decideHostKey(host, row, seen)
	}
	// a pin written before normalisation (mixed-case host) is still THE pin.
	// Migration 0049 lowercases those rows; until it has run, honour the raw row instead
	// of pinning whatever key is presented as a second, trust-on-first-use pin.
	if (rawHost && rawHost !== host) {
		const [rawRow] = await db.select().from(sshHostKeys).where(eq(sshHostKeys.host, rawHost)).limit(1)
		if (rawRow) {
			cache.set(host, { keyType: rawRow.keyType, sha256: rawRow.sha256 })
			return decideHostKey(host, rawRow, seen)
		}
	}
	// the server behind a NEW host must not be one powder already pinned under
	// another host. A name that passed the new-server check (checkNewServerHost
	// compares resolved IPs once) can be re-pointed at an existing server before the
	// first connection; that server's host key is then already pinned elsewhere.
	const same = await db
		.select({ host: sshHostKeys.host })
		.from(sshHostKeys)
		.where(eq(sshHostKeys.sha256, seen.sha256))
		.limit(5)
	const others = same.filter((r) => r.host !== host && r.host !== rawHost)
	// Only pins of hosts that are registered now (a server, or a server's builder):
	// a server whose server row moved to another address keeps its old, unused pin.
	let other: { host: string } | undefined
	if (others.length > 0) {
		const rows = await db
			.select({ host: servers.host, sshPort: servers.sshPort, buildHost: servers.buildHost })
			.from(servers)
			.limit(10_000)
		const live = new Set<string>()
		for (const r of rows) {
			live.add(pinKey(r.host, Number(r.sshPort) || 22))
			if (r.buildHost) live.add(pinKey(r.buildHost, 22))
		}
		other = others.find((r) => live.has(r.host.trim().toLowerCase()))
	}
	if (other)
		return {
			ok: false,
			reason: `SSH host key of ${host} (${seen.keyType} ${seen.sha256}) is already pinned for ${other.host}: this host reaches a server powder already manages under another name, so it is not pinned a second time. Register that server once (check where the name resolves).`,
		}
	// First use: pin it. ON CONFLICT DO NOTHING + re-read, so two concurrent
	// first connections can't pin two different keys.
	await db
		.insert(sshHostKeys)
		.values({ host, keyType: seen.keyType, sha256: seen.sha256 })
		.onConflictDoNothing()
	const [pinned] = await db.select().from(sshHostKeys).where(eq(sshHostKeys.host, host)).limit(1)
	if (!pinned) throw new Error('pin was not stored')
	cache.set(host, { keyType: pinned.keyType, sha256: pinned.sha256 })
	const d = decideHostKey(host, pinned, seen)
	if (d.ok) console.warn(`[ssh-host-keys] pinned ${host} → ${seen.keyType} ${seen.sha256} (first use)`)
	return d
}

/** ssh2 `hostVerifier` (async-callback form) for connections to `host`:`port`. */
export function hostVerifierFor(host: string, port?: number): (key: Buffer, verify: (valid: boolean) => void) => void {
	const pin = pinKey(host, port)
	return (key, verify) => {
		if (hostKeyChecksOff()) return verify(true)
		const seen = { keyType: hostKeyType(key), sha256: hostKeyFingerprint(key) }
		lookupOrPin(pin, seen, rawPinKey(host, port))
			.then((d) => {
				if (d.ok) {
					lastMismatch.delete(pin)
					return verify(true)
				}
				lastMismatch.set(pin, d.reason)
				console.error(`[ssh-host-keys] ${d.reason}`)
				verify(false)
			})
			.catch((err) => {
				// FAIL CLOSED: no pinned key could be read or written, so this
				// connection cannot be verified and must not proceed.
				const reason = `SSH host key for ${pin} could not be verified because the control-plane database errored (${err instanceof Error ? err.message : err}). Refusing the connection. Retry once the database is back; POWDER_SSH_HOSTKEY_MODE=off is the explicit opt-out.`
				lastMismatch.set(pin, reason)
				console.error(`[ssh-host-keys] ${reason}`)
				verify(false)
			})
	}
}

/** Turn ssh2's generic "host denied" error into the pinned-key explanation. */
export function explainSshError(host: string, err: Error, port?: number): Error {
	const reason = lastMismatch.get(pinKey(host, port))
	if (reason && /verif|denied/i.test(err.message)) return new Error(reason)
	return err
}
