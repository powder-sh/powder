// Guard: with POWDER_SITE_HOST set, the public-site host serves only the site,
// docs, assets, webhooks, health and /ingest. Routes are enumerated from the
// filesystem so a new dashboard page or API route is covered automatically:
// it must 404 on the site host unless it is added to PUBLIC_ROUTES below on
// purpose. With POWDER_SITE_HOST unset nothing is gated.
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { proxy } from '../../proxy'
import {
	dashboardTrustedOrigins,
	dashboardUrl,
	isSiteAllowedPath,
	isSiteHostRequest,
	publicSignInHref,
	webhookUrl,
} from '../hosts'

const APP = join(__dirname, '..', '..', 'app')
const PUBLIC = join(__dirname, '..', '..', '..', 'public')

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name)
		return statSync(p).isDirectory() ? walk(p) : [p]
	})
}

/** File path under src/app -> sample URL path (groups dropped, params filled). */
function urlFor(file: string): string {
	const segs = relative(APP, file).split(sep).slice(0, -1)
	const parts = segs
		.filter((s) => !(s.startsWith('(') && s.endsWith(')')))
		.map((s) => {
			if (s.startsWith('[...') || s.startsWith('[[...')) return 'a/b'
			if (s.startsWith('[')) return 'x1'
			return s
		})
	return `/${parts.join('/')}`
}

const files = walk(APP)
const pages = files.filter((f) => /\/page\.(tsx|ts|jsx|js)$/.test(f)).map(urlFor)
const apis = files.filter((f) => /\/route\.(tsx|ts|jsx|js)$/.test(f)).map(urlFor)

// The deliberate public surface of the site host. Adding a route here is a
// product decision, not a test fix.
const PUBLIC_ROUTES = new Set(['/', '/docs', '/docs/x1', '/api/health', '/api/webhooks/deploy/x1'])

const SITE = 'powder.sh'
const DASH = 'deploy.example.com'

function call(path: string, host: string, method = 'GET', extra: Record<string, string> = {}) {
	return proxy(new NextRequest(`https://${host}${path}`, { method, headers: { host, ...extra } }))
}

afterEach(() => vi.unstubAllEnvs())

describe('host split: route enumeration sanity', () => {
	it('finds the dashboard, login, docs and api routes', () => {
		expect(pages).toContain('/projects')
		expect(pages).toContain('/login')
		expect(pages).toContain('/docs/x1')
		expect(apis).toContain('/api/webhooks/deploy/x1')
		expect(apis).toContain('/api/auth/a/b')
		expect(apis.length).toBeGreaterThan(50)
	})
	it('no app route is a single dotted segment (that shape is reserved for public files)', () => {
		for (const p of [...pages, ...apis]) expect(p).not.toMatch(/^\/[^/]*\.[^/]*$/)
	})
	it('no root-level dynamic segment (it would catch /anything.txt on the site host)', () => {
		for (const p of [...pages, ...apis]) expect(p).not.toMatch(/^\/(x1|a\/b)(\/|$)/)
	})
})

describe('host split on (POWDER_SITE_HOST=powder.sh)', () => {
	const on = () => {
		vi.stubEnv('POWDER_SITE_HOST', `${SITE},www.${SITE}`)
		vi.stubEnv('BETTER_AUTH_URL', `https://${DASH}`)
	}

	it('every non-public page 404s on the site host and passes on the dashboard host', () => {
		on()
		for (const p of pages) {
			const site = call(p, SITE).status
			if (PUBLIC_ROUTES.has(p)) expect(site, p).toBe(200)
			else expect(site, p).toBe(404)
			expect(call(p, DASH).status, p).toBe(200)
		}
	})

	it('every non-allowlisted api route 404s on the site host (GET and POST) and passes on the dashboard host', () => {
		on()
		for (const p of apis) {
			for (const method of ['GET', 'POST']) {
				const site = call(p, SITE, method).status
				if (PUBLIC_ROUTES.has(p)) expect(site, `${method} ${p}`).toBe(200)
				else expect(site, `${method} ${p}`).toBe(404)
				expect(call(p, DASH, method).status, `${method} ${p}`).toBe(200)
			}
		}
	})

	it('/api/mcp is dashboard-only: 404 on the site host (also via X-Forwarded-Host), reachable on the dashboard', () => {
		on()
		expect(apis).toContain('/api/mcp')
		const auth = { authorization: 'Bearer pwd_x' }
		expect(call('/api/mcp', SITE, 'POST', auth).status).toBe(404)
		expect(call('/api/mcp', `www.${SITE}`, 'POST', auth).status).toBe(404)
		expect(call('/api/mcp', DASH, 'POST', { ...auth, 'x-forwarded-host': SITE }).status).toBe(404)
		expect(call('/api/mcp', DASH, 'POST', auth).status).toBe(200)
	})

	it('www alias is a site host too', () => {
		on()
		expect(call('/projects', `www.${SITE}`).status).toBe(404)
		expect(call('/docs', `www.${SITE}`).status).toBe(200)
	})

	it('the 404 is plain text with no redirect and no dashboard host in it', async () => {
		on()
		const r = call('/login', SITE)
		expect(r.status).toBe(404)
		expect(r.headers.get('location')).toBeNull()
		const body = await r.text()
		expect(body).toBe('Not Found')
		expect(body).not.toContain(DASH)
	})

	it('allows assets, metadata routes, public/ files, /llms.txt and /ingest on the site host', () => {
		on()
		const ok = [
			'/_next/static/chunks/app.js',
			'/_next/image',
			'/icon.svg',
			'/apple-icon.svg',
			'/robots.txt',
			'/sitemap.xml',
			'/llms.txt',
			'/favicon.ico',
			'/ingest',
			'/ingest/e/',
			'/ingest/static/array.js',
		]
		for (const p of ok) expect(call(p, SITE).status, p).toBe(200)
		// Metadata image routes (opengraph-image, twitter-image, icon, apple-icon)
		// anywhere on the public surface must be reachable on the site host, or
		// shared links lose their card.
		const meta = files
			.filter((f) =>
				/\/(opengraph-image|twitter-image|icon|apple-icon)\.(tsx|ts|png|jpg|svg)$/.test(f),
			)
			.map((f) => {
				const dir = urlFor(f).replace(/\/$/, '')
				const base = f.split(sep).pop() as string
				return `${dir}/${/\.tsx?$/.test(base) ? base.replace(/\.tsx?$/, '') : base}`
			})
		expect(meta).toContain('/opengraph-image')
		expect(meta).toContain('/docs/x1/opengraph-image')
		for (const p of meta) expect(call(p, SITE).status, p).toBe(200)
		const publicFiles = walk(PUBLIC).map((f) => `/${relative(PUBLIC, f).split(sep).join('/')}`)
		expect(publicFiles.length).toBeGreaterThan(0)
		for (const p of publicFiles.filter((p) => !p.endsWith('/.gitkeep'))) {
			expect(isSiteAllowedPath(p), p).toBe(true)
			expect(call(p, SITE).status, p).toBe(200)
		}
	})

	it('header tricks cannot unlock the dashboard on the site host', () => {
		on()
		// Forged X-Forwarded-Host naming the dashboard while Host is the site.
		expect(call('/projects', SITE, 'GET', { 'x-forwarded-host': DASH }).status).toBe(404)
		// Dashboard Host but the proxy chain says the site: fail-safe = site.
		expect(call('/projects', DASH, 'GET', { 'x-forwarded-host': SITE }).status).toBe(404)
		expect(call('/projects', DASH, 'GET', { 'x-forwarded-host': `${DASH}, ${SITE}` }).status).toBe(
			404,
		)
		// Case, port and trailing-dot variants of the site host.
		for (const h of ['POWDER.SH', 'powder.sh:443', 'powder.sh.', 'Www.Powder.Sh.:8443']) {
			expect(call('/projects', h).status, h).toBe(404)
		}
		// Path tricks normalise before the gate.
		expect(call('/docs/../projects', SITE).status).toBe(404)
		expect(call('/_next/../api/tokens', SITE).status).toBe(404)
		expect(call('/dashboard/docs', SITE).status).toBe(404)
	})

	it('webhook URLs for new repos stay on the site host; dashboard links use BETTER_AUTH_URL', () => {
		on()
		const h = new Headers({ host: DASH, 'x-forwarded-host': DASH, 'x-forwarded-proto': 'https' })
		expect(webhookUrl('tok', h)).toBe(`https://${SITE}/api/webhooks/deploy/tok`)
		expect(dashboardUrl()).toBe(`https://${DASH}`)
		expect(isSiteHostRequest(h)).toBe(false)
	})

	it('no public sign-in link; trusted origins exclude the site host', () => {
		on()
		vi.stubEnv('POWDER_DASHBOARD_HOST', DASH)
		vi.stubEnv('POWDER_DASHBOARD_HOST_ALIAS', SITE)
		vi.stubEnv('POWDER_DASHBOARD_HOST_ALIAS2', `www.${SITE}`)
		expect(publicSignInHref()).toBeNull()
		expect(dashboardTrustedOrigins()).toEqual([`https://${DASH}`])
	})

	it('CSRF accepts same-origin dashboard writes on the dashboard host', () => {
		on()
		const r = call('/api/tokens', DASH, 'POST', { cookie: 's=1', origin: `https://${DASH}` })
		expect(r.status).toBe(200)
		const x = call('/api/tokens', DASH, 'POST', { cookie: 's=1', origin: `https://${SITE}` })
		expect(x.status).toBe(403)
	})
})

describe('host split off (POWDER_SITE_HOST unset)', () => {
	it('gates nothing: every page and api route passes on any host', () => {
		vi.stubEnv('POWDER_SITE_HOST', '')
		for (const p of [...pages, ...apis]) {
			expect(call(p, SITE).status, p).toBe(200)
			expect(call(p, SITE, 'GET', { 'x-forwarded-host': SITE }).status, p).toBe(200)
		}
	})

	it('webhook URL from BETTER_AUTH_URL, the sign-in link and the BETTER_AUTH_URL origin', () => {
		vi.stubEnv('POWDER_SITE_HOST', '')
		vi.stubEnv('BETTER_AUTH_URL', 'https://powder.example.com')
		vi.stubEnv('POWDER_DASHBOARD_HOST', 'powder.example.com')
		vi.stubEnv('POWDER_DASHBOARD_HOST_ALIAS', 'www.powder.example.com')
		const h = new Headers({ host: 'powder.example.com', 'x-forwarded-proto': 'https' })
		expect(webhookUrl('tok', h)).toBe('https://powder.example.com/api/webhooks/deploy/tok')
		// a forged Host / X-Forwarded-Host never moves the webhook URL.
		const forged = new Headers({
			host: 'evil.example',
			'x-forwarded-host': 'evil.example',
			'x-forwarded-proto': 'http',
		})
		expect(webhookUrl('tok', forged)).toBe('https://powder.example.com/api/webhooks/deploy/tok')
		expect(publicSignInHref()).toBe('/login')
		expect(dashboardTrustedOrigins()).toEqual([
			'https://powder.example.com',
			'https://www.powder.example.com',
		])
	})
})
