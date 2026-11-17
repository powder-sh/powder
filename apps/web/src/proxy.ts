import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { isCrossSiteBlocked } from './lib/csrf'
import { isSiteAllowedPath, isSiteHostRequest } from './lib/hosts'
import { bodyTooLargeResponse, declaredBodyTooLarge } from './lib/http-limits'
import { hasBearer, sessionOnlyResponse, sessionOnlyRule } from './lib/session-only'
import { POWDER_REQUEST_HEADER } from './lib/token-scopes'

export const INGEST_STRIPPED_HEADERS = ['cookie', 'authorization', 'x-forwarded-for', 'x-real-ip'] as const
export const isIngestPath = (p: string) => p === '/ingest' || p.startsWith('/ingest/')

// Stamps the request's method + path into a header the API routes can read via
// headers() (they don't otherwise see their own URL). Always overwritten, so a
// client can't forge it. Used by scoped API tokens (lib/token-scopes.ts).
export function proxy(req: NextRequest) {
	// Host split (lib/hosts.ts): the public-site host serves only the site,
	// docs, assets, webhooks, health and /ingest. Anything else is a plain 404
	// (no redirect, so the dashboard host is never revealed). No-op when
	// POWDER_SITE_HOST is unset.
	if (isSiteHostRequest(req.headers) && !isSiteAllowedPath(req.nextUrl.pathname)) {
		return new NextResponse('Not Found', {
			status: 404,
			headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
		})
	}
	if (req.nextUrl.pathname.startsWith('/api/') && declaredBodyTooLarge(req.nextUrl.pathname, req.headers.get('content-length'))) {
		return bodyTooLargeResponse()
	}
	if (
		isCrossSiteBlocked({
			method: req.method,
			pathname: req.nextUrl.pathname,
			headers: req.headers,
			authUrl: process.env.BETTER_AUTH_URL,
		})
	) {
		return NextResponse.json({ error: 'cross-site request blocked' }, { status: 403 })
	}
	// admin actions no bearer token reaches, whatever its scopes (lib/session-only.ts,
	// the one registry; access.ts refuses the token again for the path rules).
	if (req.nextUrl.pathname.startsWith('/api/') && hasBearer(req.headers.get('authorization'))) {
		const rule = sessionOnlyRule(req.method, req.nextUrl.pathname, req.nextUrl.searchParams)
		if (rule) return sessionOnlyResponse(rule)
	}
	const h = new Headers(req.headers)
	h.set(POWDER_REQUEST_HEADER, `${req.method} ${req.nextUrl.pathname}`)
	// /ingest is rewritten to PostHog. The admin session cookie (path=/), any
	// authorization header and the client chain must never ride along to a third party.
	if (isIngestPath(req.nextUrl.pathname)) {
		for (const name of INGEST_STRIPPED_HEADERS) h.delete(name)
	}
	return NextResponse.next({ request: { headers: h } })
}

export const config = {
	// Every path, so a client-supplied x-powder-request is always overwritten.
	matcher: ['/:path*'],
}
