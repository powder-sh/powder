// What www does for an app's apex domain (and the apex for a www domain).
// powder routes only the hostnames an app lists (Traefik labels); it configures
// nothing for the www / apex sibling, so the only truth is a live probe: one HTTPS
// GET to https://<sibling>/, no redirect followed (lib/www-probe.ts). This file is
// the pure half: which rows get a check, how a probe outcome is classified, and the
// one line the domains tab shows. No DB, no network, safe in the browser.

import { isApex } from './domain-records'
import type { StatusTone } from '@/components/ui/status'

/** What one probe saw: an HTTP answer, or the error code of a failed request. */
export type WwwProbeOutcome =
	| { status: number; location: string | null }
	| { error: string }

export type WwwStatus =
	| { kind: 'redirects_here' }
	| { kind: 'serves' }
	| { kind: 'redirects_elsewhere'; to: string }
	| { kind: 'no_dns' }
	| { kind: 'broken'; status: number }
	| { kind: 'unreachable'; reason: 'tls' | 'timeout' | 'connection' }
	| { kind: 'blocked' }
	| { kind: 'error' }

export interface WwwCheck {
	/** the app's domain row */
	hostname: string
	/** the host that was probed: www.<apex>, or the apex of a www row */
	sibling: string
	status: WwwStatus
}

/** The probe timeout, in ms; the copy names it in seconds. */
export const WWW_PROBE_TIMEOUT_MS = 5_000

function bare(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, '')
}

/** The sibling to probe for a domain row: www.<apex> for an apex, the apex for
 *  www.<apex>, null for any other subdomain (app.example.com has no www line). */
export function wwwSibling(hostname: string): string | null {
	const h = bare(hostname)
	if (!h || h.includes('/') || h.includes(':')) return null
	if (h.startsWith('www.')) {
		const apex = h.slice(4)
		return apex.includes('.') && isApex(apex) ? apex : null
	}
	return h.includes('.') && isApex(h) ? `www.${h}` : null
}

const NO_DNS = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA'])
const TIMEOUT = new Set(['ABORT_ERR', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT'])

function isTlsCode(code: string): boolean {
	return (
		code.startsWith('ERR_TLS') ||
		code.startsWith('ERR_SSL') ||
		code.startsWith('CERT_') ||
		code.startsWith('UNABLE_TO_') ||
		code.includes('SELF_SIGNED') ||
		code === 'EPROTO' ||
		code === 'HOSTNAME_MISMATCH'
	)
}

/** Classify one probe of `sibling` made for the domain row `hostname`. Pure. */
export function classifyWwwProbe(
	outcome: WwwProbeOutcome,
	hostname: string,
	sibling: string,
): WwwStatus {
	if ('error' in outcome) {
		const code = outcome.error.toUpperCase()
		if (NO_DNS.has(code)) return { kind: 'no_dns' }
		if (code === 'EBLOCKED') return { kind: 'blocked' }
		if (isTlsCode(code)) return { kind: 'unreachable', reason: 'tls' }
		if (TIMEOUT.has(code)) return { kind: 'unreachable', reason: 'timeout' }
		if (!code || code === 'UNKNOWN') return { kind: 'error' }
		return { kind: 'unreachable', reason: 'connection' }
	}
	const { status, location } = outcome
	if (status >= 200 && status < 300) return { kind: 'serves' }
	if (status >= 300 && status < 400 && location) {
		let to: string
		try {
			const u = new URL(location, `https://${sibling}/`)
			// javascript:, mailto:, data: and the like name no host: a redirect to nowhere
			if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'broken', status }
			to = bare(u.hostname)
		} catch {
			return { kind: 'broken', status }
		}
		if (!to) return { kind: 'broken', status }
		if (to === bare(hostname)) return { kind: 'redirects_here' }
		// www.x -> www.x/en: still answered on the sibling, never sent here.
		if (to === bare(sibling)) return { kind: 'serves' }
		return { kind: 'redirects_elsewhere', to }
	}
	return { kind: 'broken', status }
}

/** The one line the domains tab shows, and its tone. */
export function wwwStatusLine(check: Pick<WwwCheck, 'sibling' | 'status'>): {
	text: string
	tone: StatusTone
} {
	const s = check.sibling
	const st = check.status
	switch (st.kind) {
		case 'redirects_here':
			return { text: `${s} redirects here`, tone: 'success' }
		case 'serves':
			return { text: `${s} does not redirect here`, tone: 'warning' }
		case 'redirects_elsewhere':
			return { text: `${s} redirects to ${st.to}`, tone: 'warning' }
		case 'no_dns':
			return { text: `${s} has no DNS record`, tone: 'warning' }
		case 'broken':
			return { text: `${s} is broken: HTTP ${st.status}`, tone: 'destructive' }
		case 'unreachable':
			return {
				text: `${s} is broken: ${
					st.reason === 'tls'
						? 'TLS error'
						: st.reason === 'timeout'
							? `no answer within ${WWW_PROBE_TIMEOUT_MS / 1000} s`
							: 'connection error'
				}`,
				tone: 'destructive',
			}
		case 'blocked':
			return { text: `${s} points at a private address, powder does not check it`, tone: 'neutral' }
		default:
			return { text: `could not check ${s}`, tone: 'neutral' }
	}
}
