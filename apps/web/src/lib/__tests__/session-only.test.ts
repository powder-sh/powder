import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { proxy } from '../../proxy'
import { bearerSessionOnly } from '../access'
import { appTargetBlocked, cronTargetBlocked } from '../notify-url-guard'
import {
	cronBearerIsDefault,
	cronSessionOnlyDenied,
	SESSION_ONLY,
	sessionOnlyActionDenied,
	sessionOnlyRule,
	TOKEN_ROUTES,
} from '../session-only'
import { MCP_WRITE_SCOPES, mcpWriteScopesForApps } from '../token-scopes'

// ONE registry (lib/session-only.ts) of the admin actions no bearer token reaches.
// This guard enumerates every route file under app/api: each route + method must be
// classified (SESSION_ONLY or TOKEN_ROUTES), so a new route cannot ship token-open by
// accident. Invented names only.

const API = join(__dirname, '..', '..', 'app', 'api')

function routeFiles(dir: string): string[] {
	const out: string[] = []
	for (const e of readdirSync(dir)) {
		const p = join(dir, e)
		if (statSync(p).isDirectory()) out.push(...routeFiles(p))
		else if (e === 'route.ts') out.push(p)
	}
	return out
}

/** `app/api/servers/[id]/containers/[name]/repo/route.ts` -> `/api/servers/*\/containers/*\/repo` */
function routePattern(file: string): string {
	const segs = relative(join(API, '..'), file).split(sep).slice(0, -1)
	return `/${segs.map((s) => (/^\[\.\.\..+\]$/.test(s) ? '**' : /^\[.+\]$/.test(s) ? '*' : s)).join('/')}`
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
function methodsOf(file: string): string[] {
	const src = readFileSync(file, 'utf8')
	return METHODS.filter((m) =>
		new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${m}\\b`).test(src),
	)
}

const routes = routeFiles(API).flatMap((f) =>
	methodsOf(f).map((m) => ({ file: f, route: `${m} ${routePattern(f)}` })),
)
const pathRules = new Set(SESSION_ONLY.filter((r) => !r.query).map((r) => r.route))
const queryRules = new Set(SESSION_ONLY.filter((r) => r.query).map((r) => r.route))
const tokenRoutes = new Set(TOKEN_ROUTES)

describe('every API route is classified (session-only or token-allowed)', () => {
	it('found the route files', () => {
		expect(routes.length).toBeGreaterThan(100)
	})
	it('each route + method is in exactly one list; a query rule also needs its token entry', () => {
		const bad: string[] = []
		for (const { route } of routes) {
			const s = pathRules.has(route)
			const t = tokenRoutes.has(route)
			if (s === t)
				bad.push(`${route}: ${s ? 'in both lists' : 'in neither SESSION_ONLY nor TOKEN_ROUTES'}`)
			if (queryRules.has(route) && !t)
				bad.push(`${route}: a query rule without a TOKEN_ROUTES entry`)
		}
		expect(bad).toEqual([])
	})
	it('no stale entries (each names a real route + method)', () => {
		const real = new Set(routes.map((r) => r.route))
		expect([...pathRules, ...queryRules, ...tokenRoutes].filter((r) => !real.has(r))).toEqual([])
	})
	it('each session-only route authenticates through access.ts (where the token is refused again)', () => {
		const bad = routes
			.filter((r) => pathRules.has(r.route))
			// session cookie only (auth.api.getSession: a bearer never authenticates there), or
			// the first-run setup flow (no user exists yet)
			.filter(
				(r) =>
					!/require(User|ContainerAccess|ProjectAccess|Admin)\(|getCurrentUser\(|auth\.api\.getSession\(/.test(
						readFileSync(r.file, 'utf8'),
					),
			)
			.filter((r) => r.route !== 'POST /api/setup/token')
			.map((r) => r.route)
		expect(bad).toEqual([])
	})
})

describe('the admin-action family is session-only', () => {
	const must = [
		'GET /api/servers/s1/containers/zorbweb/repo',
		'POST /api/servers/s1/containers/zorbweb/repo',
		'DELETE /api/servers/s1/containers/zorbweb/repo',
		'POST /api/servers/s1/containers/zorbweb/repo/import',
		'POST /api/servers/s1/containers/zorbweb/repo/clone',
		'POST /api/projects/p1/domains',
		'DELETE /api/projects/p1/domains',
		'POST /api/projects/p1/domains/zorb.example/apply',
		'POST /api/projects/p1/domains/zorb.example/verify',
		'POST /api/servers/s1/containers/zorbweb/domains',
		'POST /api/servers/s1/containers/zorbweb/domains/d1',
		'DELETE /api/servers/s1/containers/zorbweb/domains/d1',
		'PATCH /api/domains/s1/zorbweb/zorb.example',
		'POST /api/projects/p1/backups/b1',
		'POST /api/projects/p1/backups/restores/r1',
		'GET /api/tokens',
		'POST /api/tokens',
		'DELETE /api/tokens',
		'POST /api/setup/token',
		'GET /api/admin/users',
		'POST /api/admin/users',
		'DELETE /api/admin/users/u1',
		'PATCH /api/projects/p1',
		'POST /api/servers',
		'PATCH /api/servers/s1',
		'DELETE /api/servers/s1',
		'POST /api/servers/s1/bootstrap',
		'DELETE /api/servers/s1/containers/zorbweb/previews/v1',
		'POST /api/apps',
	]
	for (const r of must) {
		it(r, () => {
			const [m = '', p = ''] = r.split(' ')
			expect(sessionOnlyRule(m, p)).not.toBeNull()
		})
	}
	it('env / secret reveal only with ?reveal=1', () => {
		for (const p of [
			'/api/env-vars',
			'/api/databases',
			'/api/servers/s1/containers/zorbweb/inspect',
			'/api/servers/s1/containers/zorbweb/env-file',
		]) {
			expect(sessionOnlyRule('GET', p, new URLSearchParams('reveal=1')), p).not.toBeNull()
			expect(sessionOnlyRule('GET', p, new URLSearchParams('')), p).toBeNull()
		}
	})
	it('a percent-encoded or doubled path is the same route', () => {
		expect(sessionOnlyRule('POST', '/api/%74okens')).not.toBeNull()
		expect(sessionOnlyRule('POST', '/api//tokens/')).not.toBeNull()
		expect(sessionOnlyRule('POST', '/api/servers/s1/containers/zorbweb/%72epo')).not.toBeNull()
	})
})

describe("the live token's routes stay token-allowed", () => {
	const live = [
		'GET /api/internal/apps',
		'GET /api/internal/auto-rollback',
		'GET /api/internal/deploys',
		'GET /api/internal/backups',
		'POST /api/projects/p1/redeploy',
		'PUT /api/projects/p1/env',
		'POST /api/servers/s1/containers/zorbweb/restart',
		'POST /api/servers/s1/containers/zorbweb/rollback',
		'GET /api/servers/s1/containers/zorbweb/logs',
	]
	for (const r of live) {
		it(r, () => {
			const [m = '', p = ''] = r.split(' ')
			expect(sessionOnlyRule(m, p)).toBeNull()
			expect(bearerSessionOnly(r)).toBe(false)
		})
	}
	it('no MCP preset scope is session-only', () => {
		for (const s of [...MCP_WRITE_SCOPES, ...mcpWriteScopesForApps(['p1'])]) {
			const [m = '', p = ''] = s.split(' ')
			expect(sessionOnlyRule(m, p.replace(/\*/g, 'x')), s).toBeNull()
		}
	})
})

describe('central checks', () => {
	const req = (method: string, path: string, headers: Record<string, string> = {}) =>
		proxy(
			new NextRequest(`http://localhost${path}`, {
				method,
				headers: { 'sec-fetch-site': 'same-origin', ...headers },
			}),
		)
	it('the proxy answers 403 to a bearer on a session-only route, any scheme case', () => {
		for (const auth of ['Bearer pwd_abc', 'bearer pwd_abc', 'BEARER  pwd_abc']) {
			const res = req('POST', '/api/servers/s1/containers/zorbweb/repo/clone', {
				authorization: auth,
			})
			expect(res.status, auth).toBe(403)
		}
		expect(req('GET', '/api/env-vars?reveal=1', { authorization: 'Bearer x' }).status).toBe(403)
	})
	it('the proxy lets a session (no bearer) and token-allowed routes through', () => {
		expect(req('POST', '/api/servers/s1/containers/zorbweb/repo/clone').status).not.toBe(403)
		expect(req('GET', '/api/env-vars', { authorization: 'Bearer x' }).status).not.toBe(403)
		expect(req('POST', '/api/projects/p1/redeploy', { authorization: 'Bearer x' }).status).not.toBe(
			403,
		)
	})
	it('access.ts refuses a token on a path rule even without the proxy (and without a stamp)', () => {
		expect(bearerSessionOnly('POST /api/tokens')).toBe(true)
		expect(bearerSessionOnly('DELETE /api/servers/s1')).toBe(true)
		expect(bearerSessionOnly(null)).toBe(true)
		expect(bearerSessionOnly('GET /api/projects')).toBe(false)
	})
})

describe('cron actions (body / row dependent)', () => {
	const tok = { isAdmin: true, viaToken: true }
	const sess = { isAdmin: true }
	it('exec crons and a non-default bearer env var need an admin browser session', () => {
		expect(cronSessionOnlyDenied({ kind: 'exec' }, tok)?.status).toBe(403)
		expect(cronSessionOnlyDenied({ kind: 'http', bearerEnvVar: 'ZORB_SECRET' }, tok)?.status).toBe(
			403,
		)
		expect(cronSessionOnlyDenied({ kind: 'http', bearerEnvVar: 'ZORB_SECRET' }, sess)).toBeNull()
		expect(cronSessionOnlyDenied({ kind: 'exec' }, sess)).toBeNull()
		for (const b of [null, undefined, '', ' ']) {
			expect(cronBearerIsDefault(b)).toBe(true)
			expect(cronSessionOnlyDenied({ kind: 'http', bearerEnvVar: b }, tok)).toBeNull()
		}
		// naming POWDER_CRON_TOKEN reads that app env var (resolveBearer): not default
		expect(cronBearerIsDefault('POWDER_CRON_TOKEN')).toBe(false)
		expect(cronSessionOnlyDenied({ kind: 'http', bearerEnvVar: 'POWDER_CRON_TOKEN' }, tok)?.status).toBe(403)
		expect(sessionOnlyActionDenied('exec_cron', { isAdmin: false })?.status).toBe(403)
	})
	it('every cron route uses the registry check (create, edit, resume, run now, import)', () => {
		const dir = join(API, 'servers', '[id]', 'containers', '[name]', 'crons')
		for (const f of [
			'route.ts',
			join('[cronId]', 'route.ts'),
			join('[cronId]', 'run', 'route.ts'),
			join('import', 'route.ts'),
		]) {
			const src = readFileSync(join(dir, f), 'utf8')
			expect(src, f).toContain('cronSessionOnlyDenied(')
			expect(src, f).not.toContain('execCronDenied(')
		}
		const patch = readFileSync(join(dir, '[cronId]', 'route.ts'), 'utf8')
		expect(patch.match(/cronSessionOnlyDenied\(/g)?.length).toBe(2)
	})
})

// Tailscale CGNAT addresses, built so no literal IP is in source.
const cgnat = (b: number, c: number, d: number) => `100.${b}.${c}.${d}`

describe('http crons never reach the tailnet; uptime still may', () => {
	it.each([
		[cgnat(64, 0, 1), true],
		[cgnat(100, 100, 100), true],
		[cgnat(127, 255, 255), true],
		[`::ffff:${cgnat(99, 1, 2)}`, true],
		['fd7a:115c:a1e0::1', true],
		['FD7A:115C:A1E0:ab12::5', true],
		[cgnat(63, 255, 255), false],
		[cgnat(128, 0, 1), false],
		['8.8.8.8', false],
		['2a01:4f8::1', false],
	] as Array<[string, boolean]>)('%s blocked=%s', (ip, want) => {
		expect(cronTargetBlocked(ip)).toBe(want)
	})
	it('private ranges stay blocked; uptime (appTargetBlocked) keeps the tailnet open', () => {
		expect(cronTargetBlocked('10.0.0.1')).toBe(true)
		expect(cronTargetBlocked('127.0.0.1')).toBe(true)
		expect(appTargetBlocked(cgnat(64, 0, 1))).toBe(false)
		expect(appTargetBlocked('fd7a:115c:a1e0::1')).toBe(false)
	})
	it('the scheduler fires http crons with cronTargetBlocked', () => {
		const src = readFileSync(join(__dirname, '..', 'cron-scheduler.ts'), 'utf8')
		expect(src).toMatch(/guardedAppFetch\(url, \{[\s\S]*?blocked: cronTargetBlocked,[\s\S]*?\}\)/)
	})
})

describe('one project access check', () => {
	it('every /api/projects/[id] route uses requireProjectAccess, never requireUser + its own row load', () => {
		const files = routeFiles(join(API, 'projects', '[id]'))
		expect(files.length).toBeGreaterThan(10)
		for (const f of files) {
			const src = readFileSync(f, 'utf8')
			expect(src, f).toContain('requireProjectAccess(')
			expect(src, f).not.toMatch(/requireUser\(/)
			expect(src, f).not.toMatch(/\.from\(appRepos\)\.where\(eq\(appRepos\.id, id\)\)/)
		}
	})
	it('the clone route redacts git output and errors', () => {
		const src = readFileSync(
			join(API, 'servers', '[id]', 'containers', '[name]', 'repo', 'clone', 'route.ts'),
			'utf8',
		)
		expect(src).toContain('output: redactSecrets(output)')
		expect(src).toMatch(/error: redactSecrets\(/)
	})
})
