import { promises as dns, type LookupOptions, lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { isBlockedIp } from './server-host-guard'

// SSRF guard for notification webhook URLs stored in notification_targets.
// http(s) only, no credentials in the URL, and the host must not be (or
// resolve to) loopback, link-local (cloud metadata at 169.254.169.254) or
// 0.0.0.0/8, the same set server-host-guard.ts blocks, and the cloud metadata
// addresses 100.100.100.200 and fd00:ec2::254 (CLOUD_METADATA_ADDRESSES). Private ranges
// stay allowed on purpose:
// an operator may run a receiver on a private network, and private overlay networks
// such as Tailscale use 100.64/10.
// Checked on create AND before every send (DNS can change after create), and
// again on the address actually connected to (guardedPost below).

export type Resolver = (host: string) => Promise<string[]>

const resolveAll: Resolver = async (host) => {
	if (isIP(host)) return [host]
	const res = await dns.lookup(host, { all: true, verbatim: true })
	return res.map((r) => r.address)
}

/** WHATWG URL writes an IPv4-mapped literal in hex (`::ffff:7f00:1`), which
 *  isBlockedIp only understands in dotted form. Return the embedded v4. */
function mappedV4(ip: string): string | null {
	const m = ip.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
	if (!m?.[1] || !m[2]) return null
	const hi = Number.parseInt(m[1], 16)
	const lo = Number.parseInt(m[2], 16)
	return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

export type WebhookUrlCheck = { ok: true; url: URL } | { ok: false; error: string }

export async function checkWebhookUrl(
	raw: string,
	resolve: Resolver = resolveAll,
): Promise<WebhookUrlCheck> {
	let url: URL
	try {
		url = new URL(raw.trim())
	} catch {
		return { ok: false, error: 'not a valid URL' }
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		return { ok: false, error: 'webhook URL must be http or https' }
	}
	if (url.username || url.password)
		return { ok: false, error: 'webhook URL must not contain credentials' }
	if (raw.length > 2048) return { ok: false, error: 'webhook URL is too long' }
	// URL keeps IPv6 hosts bracketed.
	const host = url.hostname.replace(/^\[|\]$/g, '')
	if (!host || host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
		return { ok: false, error: 'webhook host is not allowed' }
	}
	let ips: string[]
	try {
		ips = await resolve(host)
	} catch {
		return { ok: false, error: 'webhook host does not resolve' }
	}
	if (ips.length === 0) return { ok: false, error: 'webhook host does not resolve' }
	if (ips.some((ip) => ipBlocked(ip))) {
		return { ok: false, error: 'webhook host resolves to a loopback or link-local address' }
	}
	return { ok: true, url }
}

// ── Connect-time guard (DNS rebinding) ───────────────────────────────────────
// checkWebhookUrl resolves the host once; a plain fetch would resolve it again
// and a TTL-0 record can answer public first, then 127.0.0.1 / 169.254.169.254.
// guardedPost sends through node:http(s) with a `lookup` that re-runs the same
// isBlockedIp check on the addresses the socket actually connects to, so the
// checked answer and the used answer are the same lookup. No redirects are
// followed (node:http never follows). IP-literal hosts skip lookup; those were
// already judged by checkWebhookUrl.

type LookupAddress = { address: string; family: number }
type LookupCb = (
	err: NodeJS.ErrnoException | null,
	address: string | LookupAddress[],
	family?: number,
) => void
export type LookupFn = (host: string, opts: LookupOptions, cb: LookupCb) => void

/** Cloud metadata addresses inside ranges this guard otherwise allows: some clouds
 *  answer instance metadata (credentials included) on 100.100.100.200, inside
 *  100.64/10, and on fd00:ec2::254 (the IPv6 instance metadata endpoint), inside the
 *  unique-local fc00::/7. 169.254.169.254 is link-local, which isBlockedIp already
 *  refuses. IPv6 entries are in canonical (compressed, lower-case) form. */
export const CLOUD_METADATA_ADDRESSES = ['100.100.100.200', 'fd00:ec2::254']

/** The compressed lower-case form of an IPv6 literal (any spelling), else the input. */
function canonicalV6(ip: string): string {
	if (isIP(ip) !== 6) return ip
	try {
		return new URL(`http://[${ip}]/`).hostname.replace(/^\[|\]$/g, '')
	} catch {
		return ip.toLowerCase()
	}
}

function ipBlocked(ip: string): boolean {
	const lower = ip.toLowerCase()
	const v4 = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? mappedV4(ip) ?? ip
	if (CLOUD_METADATA_ADDRESSES.includes(v4) || CLOUD_METADATA_ADDRESSES.includes(canonicalV6(ip))) return true
	return isBlockedIp(ip) || isBlockedIp(mappedV4(ip) ?? ip)
}

/** Wrap a dns.lookup-compatible function so every answer is checked. */
export function guardedLookup(
	base: LookupFn = dnsLookup as unknown as LookupFn,
	blocked = ipBlocked,
): LookupFn {
	return (host, opts, cb) => {
		base(host, opts, (err, address, family) => {
			if (err) return cb(err, address, family)
			const list = Array.isArray(address) ? address.map((a) => a.address) : [address]
			if (list.length === 0 || list.some((ip) => blocked(ip))) {
				const e: NodeJS.ErrnoException = new Error(
					'webhook host resolves to a blocked address at connect time',
				)
				e.code = 'EBLOCKED'
				return cb(e, address, family)
			}
			cb(null, address, family)
		})
	}
}

export interface GuardedPostOptions {
	headers: Record<string, string>
	body: string
	timeoutMs: number
	/** Tests only: replace the DNS lookup / blocked-address check. */
	lookup?: LookupFn
}

/** POST `target` with the connect-time guard. Resolves to the HTTP status;
 *  rejects on any network error, a blocked address or the timeout. */
export function guardedPost(target: string, o: GuardedPostOptions): Promise<number> {
	return new Promise((resolve, reject) => {
		let url: URL
		try {
			url = new URL(target)
		} catch (e) {
			return reject(e)
		}
		const mod = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null
		if (!mod) return reject(new Error('webhook URL must be http or https'))
		const req = mod.request(
			url,
			{
				method: 'POST',
				headers: { ...o.headers, 'content-length': String(Buffer.byteLength(o.body)) },
				lookup: (o.lookup ?? guardedLookup()) as unknown as http.RequestOptions['lookup'],
				agent: false,
			},
			(res) => {
				res.resume()
				res.on('end', () => resolve(res.statusCode ?? 0))
				res.on('error', reject)
			},
		)
		const timer = setTimeout(() => req.destroy(new Error('webhook timed out')), o.timeoutMs)
		req.on('close', () => clearTimeout(timer))
		req.on('error', (e) => {
			clearTimeout(timer)
			reject(e)
		})
		req.end(o.body)
	})
}

// ── App targets: HTTP crons and uptime probes ───────────────────────────
// A cron or uptime URL is built from an app's live domain, its default host or an
// operator-set health_url. powder fetches it from inside its own network namespace
// (on the `web` bridge next to Traefik, its database and other apps), so the address
// it connects to must also not be private: RFC 1918 (Docker bridges live in
// 172.16/12), IPv6 unique-local, on top of loopback, link-local and 0.0.0.0/8.
// CGNAT 100.64/10 and fd7a:115c:a1e0::/48 stay allowed (except the metadata
// address 100.100.100.200): private overlay networks such as Tailscale use them, and an
// app on a server reachable only over one may be probed there (a health_url may name
// such an address). An app's public domain resolves to a public address and passes.

const PRIVATE_V4: Array<[number, number]> = [
	[10 << 24, 8],
	[(172 << 24) | (16 << 16), 12],
	[(192 << 24) | (168 << 16), 16],
]

function v4Int(ip: string): number {
	return ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0)
}

/** Loopback, link-local, 0.0.0.0/8 (ipBlocked) or a private / unique-local address. */
export function appTargetBlocked(ip: string): boolean {
	if (ipBlocked(ip)) return true
	const lower = ip.toLowerCase()
	const v4 = isIP(ip) === 4 ? ip : (lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? mappedV4(ip))
	if (v4 && isIP(v4) === 4) {
		const n = v4Int(v4) >>> 0
		return PRIVATE_V4.some(([base, bits]) => n >>> (32 - bits) === (base >>> 0) >>> (32 - bits))
	}
	if (isIP(ip) !== 6) return false
	// The overlay IPv6 range fd7a:115c:a1e0::/48 (Tailscale) is allowed like
	// 100.64/10: a name on such a network may resolve to both.
	if (isTailscaleV6(lower)) return false
	return /^f[cd]/.test(lower)
}

/** http crons only: appTargetBlocked plus CGNAT 100.64/10 and fd7a:115c:a1e0::/48,
 *  the ranges private overlay networks such as Tailscale use. A cron sends the app's
 *  bearer to its URL, and other machines of the operator may answer on such a network;
 *  an app's public domain never resolves there. Uptime probes keep appTargetBlocked
 *  (a health_url may name an overlay address). */
export function cronTargetBlocked(ip: string): boolean {
	if (appTargetBlocked(ip)) return true
	const lower = ip.toLowerCase()
	const v4 = isIP(ip) === 4 ? ip : (lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? mappedV4(ip))
	if (v4 && isIP(v4) === 4) return v4Int(v4) >>> 22 === ((100 << 24) | (64 << 16)) >>> 22
	return isIP(ip) === 6 && isTailscaleV6(lower)
}

/** fd7a:115c:a1e0::/48, in any spelling of the first three groups. */
function isTailscaleV6(lower: string): boolean {
	const groups = lower.split(':').slice(0, 3).map((g) => g.replace(/^0+(?=.)/, ''))
	return groups.length === 3 && groups[0] === 'fd7a' && groups[1] === '115c' && groups[2] === 'a1e0'
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

export interface GuardedFetchOptions {
	method?: 'GET' | 'POST'
	headers?: Record<string, string>
	signal?: AbortSignal
	/** Always 'manual': node:http never follows a redirect. */
	redirect: 'manual'
	/** Tests only: replace the DNS lookup. `blocked`: the address check (default
	 *  appTargetBlocked; http crons pass cronTargetBlocked). */
	lookup?: LookupFn
	blocked?: (ip: string) => boolean
}

/** fetch() for app targets (crons, uptime) with the connect-time address check
 *  (appTargetBlocked) on the address the socket really connects to. Returns a WHATWG
 *  Response; rejects on a blocked address, a network error or an abort. */
export function guardedAppFetch(target: string, o: GuardedFetchOptions): Promise<Response> {
	return new Promise((resolve, reject) => {
		let url: URL
		try {
			url = new URL(target)
		} catch (e) {
			return reject(e)
		}
		const mod = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null
		if (!mod) return reject(new Error('URL must be http or https'))
		// An IP-literal host never goes through lookup: judge it here.
		const host = url.hostname.replace(/^\[|\]$/g, '')
		const blocked = o.blocked ?? appTargetBlocked
		if (isIP(host) && blocked(host)) {
			const e: NodeJS.ErrnoException = new Error(
				'target is a loopback, link-local or private address',
			)
			e.code = 'EBLOCKED'
			return reject(e)
		}
		const req = mod.request(
			url,
			{
				method: o.method ?? 'GET',
				headers: o.headers ?? {},
				lookup: guardedLookup(o.lookup, blocked) as unknown as http.RequestOptions['lookup'],
				agent: false,
				signal: o.signal,
			},
			(res) => {
				const status = res.statusCode ?? 0
				const headers = new Headers()
				for (const [k, v] of Object.entries(res.headers)) {
					if (v === undefined) continue
					for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x)
				}
				const nullBody = NULL_BODY_STATUS.has(status)
				if (nullBody) res.resume()
				try {
					resolve(
						new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
							status: status >= 200 && status <= 599 ? status : 502,
							statusText: res.statusMessage ?? '',
							headers,
						}),
					)
				} catch (e) {
					res.destroy()
					reject(e)
				}
			},
		)
		req.on('error', reject)
		req.end()
	})
}
