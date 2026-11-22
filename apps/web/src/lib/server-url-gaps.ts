// "Found nothing" must not look like "has nothing" on the servers list.
// The list shows the URLs discovery finds in the live proxy config (nginx vhosts,
// Traefik labels). A powder app whose own record (app_domains, routed rows: live and
// not a preview) holds a domain while discovery finds no URL for its container is a
// contradiction: either the proxy config is not in a shape discovery reads, or the
// domain is not really routed. The row then shows the recorded domains, marked, and the
// list counts such apps so a later check can watch the number.
// Pure module (no db imports).
import { isRoutedDomain } from './app-hosts'

export type UrlSource = 'proxy' | 'app-domains' | 'none'

/** The URLs a container row shows, and where they come from:
 *  - `proxy`: discovery found at least one URL; those are shown as found.
 *  - `app-domains`: discovery found none, the container is a powder app and powder's
 *    own record has routed domains for it; those are shown (as https, the scheme
 *    powder serves an applied domain on), marked as not found in the proxy config.
 *  - `none`: nothing found and nothing recorded (or not a powder app): a dash. */
export function rowUrls(input: { discovered: string[]; isApp: boolean; liveHosts: string[] }): {
	urls: string[]
	urlSource: UrlSource
} {
	if (input.discovered.length > 0) return { urls: input.discovered, urlSource: 'proxy' }
	if (input.isApp && input.liveHosts.length > 0) {
		const hosts = [...new Set(input.liveHosts.map((h) => h.toLowerCase()))].sort()
		return { urls: hosts.map((h) => `https://${h}`), urlSource: 'app-domains' }
	}
	return { urls: [], urlSource: 'none' }
}

/** The invariant as a count: powder apps with at least one routed domain for which
 *  discovery found no URL. Near zero on a healthy install. */
export function countLiveAppsWithoutUrl(rows: Array<{ urlSource: UrlSource }>): number {
	return rows.filter((r) => r.urlSource === 'app-domains').length
}

/** Routed hostnames per app id, from app_domains rows (isRoutedDomain: live, not a preview). */
export function liveHostsByApp(
	rows: Array<{ appRepoId: string; hostname: string; status: string; previewDeployId: string | null }>,
): Map<string, string[]> {
	const out = new Map<string, string[]>()
	for (const r of rows) {
		if (!isRoutedDomain(r)) continue
		const list = out.get(r.appRepoId) ?? []
		list.push(r.hostname)
		out.set(r.appRepoId, list)
	}
	return out
}
