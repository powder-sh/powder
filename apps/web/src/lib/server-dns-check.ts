// "Check DNS" for a server's base domain: resolves a random label under it
// (only a wildcard record answers) and compares with the ingress target
// (servers.ingress_ip, else the host). Last result cached for the checklist.
import { resolve4 } from 'node:dns/promises'
import { ingressTargetFor } from './app-domains'
import { type DnsCheckResult, dnsProbeName, dnsVerdict } from './server-settings'
import type { ServerConfig } from './servers'

export type CachedDnsCheck = DnsCheckResult & { at: string; baseDomain: string | null }

const g = globalThis as { __powderDnsCheckCache?: Map<string, CachedDnsCheck> }
function cache(): Map<string, CachedDnsCheck> {
	if (!g.__powderDnsCheckCache) g.__powderDnsCheckCache = new Map()
	return g.__powderDnsCheckCache
}

/** Cached result, dropped when the base domain changed since. */
export function cachedDnsCheck(serverId: string, baseDomain: string | null): CachedDnsCheck | null {
	const hit = cache().get(serverId)
	return hit && hit.baseDomain === baseDomain ? hit : null
}

export async function runDnsCheck(server: ServerConfig): Promise<CachedDnsCheck> {
	const base = server.baseDomain ?? null
	let result: DnsCheckResult
	if (!base) {
		result = { state: 'no-base-domain' }
	} else {
		const probe = dnsProbeName(base)
		const target = await ingressTargetFor(server)
		let lookup: { ips: string[] } | { error: string }
		try {
			lookup = { ips: await resolve4(probe) }
		} catch (err) {
			lookup = { error: (err as { code?: string }).code ?? 'lookup failed' }
		}
		result = dnsVerdict(probe, target?.ip ?? null, lookup)
	}
	const out: CachedDnsCheck = { ...result, at: new Date().toISOString(), baseDomain: base }
	cache().set(server.id, out)
	return out
}
