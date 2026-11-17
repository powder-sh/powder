// CSRF guard for cookie-authenticated API routes: a cross-site request (for
// example a text/plain POST that carries the session cookie) is refused. Checked
// in proxy.ts for every state-changing request under /api.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function hostOf(url: string | null | undefined): string | null {
	if (!url) return null
	try {
		return new URL(url).host.toLowerCase()
	} catch {
		return null
	}
}

export function isCrossSiteBlocked(input: {
	method: string
	pathname: string
	headers: Headers
	authUrl?: string | null
}): boolean {
	const { method, pathname, headers } = input
	if (SAFE_METHODS.has(method.toUpperCase())) return false
	if (!pathname.startsWith('/api/')) return false
	// Webhooks are signature-authenticated; better-auth guards its own routes.
	if (pathname.startsWith('/api/webhooks/') || pathname.startsWith('/api/auth/')) return false
	// No cookie = no ambient credential to ride on (the route will 401 on its own).
	if (!headers.get('cookie')) return false
	// Bearer tokens are not ambient credentials: a browser never attaches them cross-site.
	if ((headers.get('authorization') ?? '').startsWith('Bearer ')) return false

	const site = headers.get('sec-fetch-site')
	if (site === 'same-origin' || site === 'none') return false

	const origin = hostOf(headers.get('origin'))
	if (origin) {
		const reqHost = (headers.get('x-forwarded-host') ?? headers.get('host') ?? '')
			.split(',')[0]
			?.trim()
			.toLowerCase()
		if (reqHost && origin === reqHost) return false
		const authHost = hostOf(input.authUrl ?? null)
		if (authHost && origin === authHost) return false
	}
	return true
}
