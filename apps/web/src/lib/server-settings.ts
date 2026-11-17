// Validation for the editable server settings (servers.proxy, tls_mode,
// base_domain, ingress_ip, build_host). Pure module (no db/ssh) so the API route and the
// tests share one authority. The DNS probe helpers live here too.
import { randomBytes } from 'node:crypto'
import { isIP, isIPv4 } from 'node:net'
import { HOST_RE } from './app-hosts'
import { isBlockedIp } from './server-host-guard'

// 'nginx' and 'nginx-container': servers routed by nginx (no custom domains, previews or snapshots).
const SERVER_PROXIES = ['traefik', 'nginx', 'nginx-container'] as const
const SERVER_TLS_MODES = ['acme', 'origin-cert'] as const
export type ServerProxyValue = (typeof SERVER_PROXIES)[number]
type ServerTlsModeValue = (typeof SERVER_TLS_MODES)[number]

// Default for a newly registered server. nginx stays supported.
export const DEFAULT_NEW_SERVER_PROXY: ServerProxyValue = 'traefik'

interface ServerSettingsPatch {
	proxy?: ServerProxyValue
	tlsMode?: ServerTlsModeValue
	baseDomain?: string | null
	ingressIp?: string | null
	buildHost?: string | null
}

export type SettingsResult = { ok: true; value: ServerSettingsPatch } | { ok: false; error: string }

export function isServerProxy(v: unknown): v is ServerProxyValue {
	return typeof v === 'string' && (SERVER_PROXIES as readonly string[]).includes(v)
}

function isServerTlsMode(v: unknown): v is ServerTlsModeValue {
	return typeof v === 'string' && (SERVER_TLS_MODES as readonly string[]).includes(v)
}

// Bare hostname: no scheme, no wildcard, no path or port, lowercase. Empty =
// unset (null). Returns the normalised value or an error message.
export function validateBaseDomain(
	raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
	if (raw === null || raw === undefined) return { ok: true, value: null }
	if (typeof raw !== 'string') return { ok: false, error: 'base_domain must be a string' }
	const v = raw.trim()
	if (!v) return { ok: true, value: null }
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.includes('://')) {
		return { ok: false, error: 'base_domain is a bare hostname: drop the scheme (https://)' }
	}
	if (v.includes('*')) {
		return {
			ok: false,
			error: 'base_domain is a bare hostname: no wildcard (powder uses *.<base_domain> itself)',
		}
	}
	if (/[/:?#@\s]/.test(v)) {
		return { ok: false, error: 'base_domain is a bare hostname: no path, port or spaces' }
	}
	if (v !== v.toLowerCase()) return { ok: false, error: 'base_domain must be lowercase' }
	const host = v.replace(/\.$/, '')
	if (host.length > 253 || !HOST_RE.test(host) || host.split('.').some((l) => l.length > 63)) {
		return { ok: false, error: 'base_domain is not a valid hostname (e.g. apps.example.com)' }
	}
	return { ok: true, value: host }
}

export function validateIngressIp(
	raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
	if (raw === null || raw === undefined) return { ok: true, value: null }
	if (typeof raw !== 'string') return { ok: false, error: 'ingress_ip must be a string' }
	const v = raw.trim()
	if (!v) return { ok: true, value: null }
	// ingressTargetFor (app-domains.ts) only reads an IPv4 literal.
	if (!isIPv4(v)) return { ok: false, error: 'ingress_ip must be an IPv4 address' }
	return { ok: true, value: v }
}

// Dedicated builder (lib/builder.ts): powder SSHes to it on port 22 as the
// server's ssh user with the master key, and pins its host key like a server's.
// A hostname or an IP literal, lowercase; empty = unset (builds run on the
// server itself). Loopback / link-local literals are refused (server-host-guard);
// the route also checks what a hostname resolves to (checkBuildHost).
// DNS labels; a single label (a tailnet short name) is allowed, as for a server's host.
const BUILD_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

export function validateBuildHost(
	raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
	if (raw === null || raw === undefined) return { ok: true, value: null }
	if (typeof raw !== 'string') return { ok: false, error: 'build_host must be a string' }
	const v = raw.trim().toLowerCase()
	if (!v) return { ok: true, value: null }
	if (v.includes('://') || /[/?#@\s]/.test(v)) {
		return { ok: false, error: 'build_host is a bare hostname or IP: no scheme, user, path or spaces' }
	}
	if (isIP(v)) {
		if (isBlockedIp(v)) return { ok: false, error: 'build_host must not be a loopback or link-local address' }
		return { ok: true, value: v }
	}
	const host = v.replace(/\.$/, '')
	if (host.length > 253 || !BUILD_HOST_RE.test(host) || host.split('.').some((l) => l.length > 63)) {
		return { ok: false, error: 'build_host is not a valid hostname or IP (e.g. builder.example.com)' }
	}
	return { ok: true, value: host }
}

// PATCH body -> patch of the provided fields only. Unknown keys are ignored.
export function validateServerSettings(body: unknown): SettingsResult {
	if (!body || typeof body !== 'object') return { ok: false, error: 'invalid body' }
	const b = body as Record<string, unknown>
	const out: ServerSettingsPatch = {}
	if ('proxy' in b) {
		if (!isServerProxy(b.proxy)) {
			return { ok: false, error: `proxy must be one of ${SERVER_PROXIES.join(', ')}` }
		}
		out.proxy = b.proxy
	}
	if ('tlsMode' in b) {
		if (!isServerTlsMode(b.tlsMode)) {
			return { ok: false, error: `tls_mode must be one of ${SERVER_TLS_MODES.join(', ')}` }
		}
		out.tlsMode = b.tlsMode
	}
	if ('baseDomain' in b) {
		const r = validateBaseDomain(b.baseDomain)
		if (!r.ok) return r
		out.baseDomain = r.value
	}
	if ('ingressIp' in b) {
		const r = validateIngressIp(b.ingressIp)
		if (!r.ok) return r
		out.ingressIp = r.value
	}
	if ('buildHost' in b) {
		const r = validateBuildHost(b.buildHost)
		if (!r.ok) return r
		out.buildHost = r.value
	}
	if (Object.keys(out).length === 0) return { ok: false, error: 'nothing to update' }
	return { ok: true, value: out }
}

// A random label under the base domain: only a wildcard record answers it.
export function dnsProbeName(baseDomain: string, rand: () => string = randomLabel): string {
	return `${rand()}.${baseDomain}`
}

function randomLabel(): string {
	return `powder-dns-check-${randomBytes(4).toString('hex')}`
}

export type DnsCheckResult =
	| { state: 'ok'; probe: string; resolved: string[]; expected: string }
	| { state: 'mismatch'; probe: string; resolved: string[]; expected: string }
	| { state: 'unresolved'; probe: string; expected: string | null; error: string }
	| { state: 'no-target'; probe: string }
	| { state: 'no-base-domain' }

// Pure verdict: does the wildcard probe resolve to the expected ingress IP?
export function dnsVerdict(
	probe: string,
	expected: string | null,
	lookup: { ips: string[] } | { error: string },
): DnsCheckResult {
	if ('error' in lookup) return { state: 'unresolved', probe, expected, error: lookup.error }
	if (!expected) return { state: 'no-target', probe }
	return lookup.ips.includes(expected)
		? { state: 'ok', probe, resolved: lookup.ips, expected }
		: { state: 'mismatch', probe, resolved: lookup.ips, expected }
}
