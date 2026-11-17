/** The PostHog key the browser initialises with, or null (analytics off). Events go to
 *  `/ingest`, which next.config.ts rewrites to NEXT_PUBLIC_POSTHOG_HOST only when that is
 *  set at build time: a key without a host would post to a path nothing serves. */
export function posthogKey(key: string | undefined, host: string | undefined): string | null {
	const k = key?.trim()
	const h = host?.trim().replace(/\/+$/, '')
	return k && h ? k : null
}
