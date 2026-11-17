import type { NextConfig } from 'next'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_BODY_BYTES } from './src/lib/http-limits'
import { CSP, PERMISSIONS_POLICY } from './src/lib/security-headers'

const monorepoRoot = join(__dirname, '..', '..')

// Single source of the version: `version` in the root package.json.
const powderVersion: string = JSON.parse(readFileSync(join(monorepoRoot, 'package.json'), 'utf8')).version

// PostHog reverse proxy: only wired when NEXT_PUBLIC_POSTHOG_HOST is set at build
// time (e.g. https://eu.i.posthog.com). The static-assets host is derived from it.
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST?.replace(/\/+$/, '')

const nextConfig: NextConfig = {
	output: 'standalone',
	env: { NEXT_PUBLIC_POWDER_VERSION: powderVersion },
	outputFileTracingRoot: monorepoRoot,
	outputFileTracingIncludes: { '/docs/**': ['./content/docs/**/*.md'] },
	turbopack: {
		root: monorepoRoot,
	},
	transpilePackages: ['@powder/db'],
	serverExternalPackages: ['ssh2', 'postgres'],
	skipTrailingSlashRedirect: true,
	poweredByHeader: false,
	// `next dev` otherwise writes a managed block into apps/web/AGENTS.md when it
	// detects a coding agent, leaving a dirty tree on a contributor's first run.
	agentRules: false,
	experimental: {
		// Bounds chunked request bodies (no Content-Length) too: Next buffers at
		// most this much per request for proxy + route. Same value as the
		// declared-length cap in proxy.ts; why 1 MB: lib/http-limits.ts.
		proxyClientMaxBodySize: MAX_BODY_BYTES,
	},
	// clickjacking / sniffing / referrer / HSTS / CSP-lite headers on every route. Deliberately
	// no full CSP (inline scripts from Next + PostHog would need a nonce pipeline).
	async headers() {
		return [
			{
				source: '/:path*',
				headers: [
					{ key: 'X-Frame-Options', value: 'DENY' },
					// no plugins, no <base> hijack, forms only post to this origin
					// (every form here posts same-origin or via fetch; GitHub sign-in is a
					// fetch + window.location redirect, not a form post).
					{ key: 'Content-Security-Policy', value: CSP },
					{ key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
					{ key: 'X-Content-Type-Options', value: 'nosniff' },
					{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
					{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
				],
			},
			// API answers (secrets, env values, tokens) are never stored by a browser
			// or a proxy cache. A next.config header wins over the same header a route sets
			// (send-response.js only appends a header that is not present yet), so the value
			// keeps the `no-transform` the SSE streams (deploy and log streams) need: no proxy
			// may buffer or recompress them. Downloads are unaffected by no-store.
			{
				source: '/api/:path*',
				headers: [{ key: 'Cache-Control', value: 'no-store, no-transform' }],
			},
		]
	},
	// The in-dashboard docs page was a second copy of /docs; old links land on the real one.
	async redirects() {
		return [{ source: '/dashboard/docs', destination: '/docs', permanent: true }]
	},
	async rewrites() {
		if (!posthogHost) return []
		const assetsHost = posthogHost.replace('.i.posthog.com', '-assets.i.posthog.com')
		return [
			{ source: '/ingest/static/:path*', destination: `${assetsHost}/static/:path*` },
			{ source: '/ingest/:path*', destination: `${posthogHost}/:path*` },
		]
	},
}

export default nextConfig
