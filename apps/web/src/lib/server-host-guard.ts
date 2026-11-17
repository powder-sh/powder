import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

// Registering a server makes powder SSH into it as root with the master
// key. So a
// new server's host must never be (or resolve to) a server powder already manages,
// nor a loopback / link-local address.

function ipv4ToInt(ip: string): number {
	return ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0)
}

// Private/tailnet ranges (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) are
// deliberately NOT blocked: managed servers are often reached over a private network
// or a tailnet. Duplicates of
// existing servers are caught by the host/IP match instead.
const V4_BLOCKED: Array<[string, number]> = [
	['0.0.0.0', 8],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
]

export function isBlockedIp(ip: string): boolean {
	const fam = isIP(ip)
	if (fam === 4) {
		const n = ipv4ToInt(ip)
		return V4_BLOCKED.some(([base, bits]) => {
			const size = 2 ** (32 - bits)
			const start = ipv4ToInt(base)
			return n >= start && n < start + size
		})
	}
	if (fam === 6) {
		const lower = ip.toLowerCase()
		if (lower === '::1' || lower === '::') return true
		// IPv4-mapped (::ffff:a.b.c.d) -> judge the embedded v4.
		const m = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
		if (m?.[1]) return isBlockedIp(m[1])
		// fe80::/10 link-local
		return /^fe[89ab]/.test(lower)
	}
	return false
}

export type HostResolver = (host: string) => Promise<string[]>

export type AddressLookup = (host: string) => Promise<Array<{ address: string }>>

const systemLookup: AddressLookup = (host) => dns.lookup(host, { all: true })

/** Resolves through getaddrinfo (dns.lookup), so /etc/hosts, search domains and
 *  tailnet short names work the same way ssh resolves them. Every returned
 *  address (v4 and v6) is handed to the caller, which refuses the host if any of
 *  them is loopback or link-local. */
export async function resolveHostIps(host: string, lookup: AddressLookup = systemLookup): Promise<string[]> {
	if (isIP(host)) return [host]
	try {
		return [...new Set((await lookup(host)).map((a) => a.address))]
	} catch {
		return []
	}
}

export type HostCheck =
	| { ok: true }
	| { ok: false; status: 400 | 409; error: string }

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.:-]*[A-Za-z0-9])?$/

export async function checkNewServerHost(
	host: string,
	existingHosts: string[],
	resolve: HostResolver = (h) => resolveHostIps(h),
): Promise<HostCheck> {
	const h = host.trim().toLowerCase()
	if (!HOST_RE.test(h) || h.length > 253) {
		return { ok: false, status: 400, error: 'invalid host' }
	}
	if (existingHosts.some((e) => e.trim().toLowerCase() === h)) {
		return { ok: false, status: 409, error: 'host is already registered' }
	}
	const ips = await resolve(h)
	if (ips.length === 0) {
		return { ok: false, status: 400, error: 'host does not resolve' }
	}
	if (ips.some(isBlockedIp)) {
		return { ok: false, status: 400, error: 'host resolves to a loopback or link-local address' }
	}
	const existingIps = new Set<string>()
	for (const e of existingHosts) {
		for (const ip of await resolve(e.trim()).catch(() => [])) existingIps.add(ip)
	}
	if (ips.some((ip) => existingIps.has(ip))) {
		return { ok: false, status: 409, error: 'host resolves to an already registered server' }
	}
	return { ok: true }
}

/** A dedicated builder (servers.build_host) gets the same SSH-as-root reach, so
 *  its name must resolve and must not resolve to a loopback or link-local address. */
export async function checkBuildHost(
	host: string,
	resolve: HostResolver = (h) => resolveHostIps(h),
): Promise<{ ok: true } | { ok: false; error: string }> {
	const ips = await resolve(host)
	if (ips.length === 0) return { ok: false, error: 'build_host does not resolve' }
	if (ips.some(isBlockedIp)) {
		return { ok: false, error: 'build_host resolves to a loopback or link-local address' }
	}
	return { ok: true }
}
