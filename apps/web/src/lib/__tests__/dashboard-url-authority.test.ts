// Webhook URLs (with their token), notification links, GitHub deployment log links,
// generated AGENTS.md / DEPLOYMENT.md, the env-file header and the MCP origin are
// built from the install's own dashboard origin (BETTER_AUTH_URL). Without it they
// must fail closed, never fall back to the project's site (SITE_URL), which would
// send tokens and push payloads to a host the install does not own.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	DashboardUrlMissingError,
	DEV_DASHBOARD_URL,
	dashboardTrustedOrigins,
	dashboardUrl,
	dashboardUrlOrNull,
	webhookBaseUrl,
	webhookBaseUrlOrNull,
	webhookConfigError,
	webhookUrl,
} from '../hosts'
import { SITE_URL } from '../site'

const prod = (over: Record<string, string> = {}) => ({ NODE_ENV: 'production', ...over })

describe('dashboard origin: one authority, fails closed', () => {
	it('uses the BETTER_AUTH_URL origin', () => {
		expect(dashboardUrl(prod({ BETTER_AUTH_URL: 'https://deploy.example.com/x/' }))).toBe('https://deploy.example.com')
		expect(webhookUrl('tok', null, prod({ BETTER_AUTH_URL: 'https://deploy.example.com' }))).toBe(
			'https://deploy.example.com/api/webhooks/deploy/tok',
		)
	})
	for (const [label, env] of [
		['unset', prod()],
		['blank', prod({ BETTER_AUTH_URL: '  ' })],
		['unparseable', prod({ BETTER_AUTH_URL: 'not a url' })],
		['not http(s)', prod({ BETTER_AUTH_URL: 'ftp://deploy.example.com' })],
	] as const) {
		it(`production, BETTER_AUTH_URL ${label}: throws, never the project site`, () => {
			expect(() => dashboardUrl(env)).toThrow(DashboardUrlMissingError)
			expect(() => webhookBaseUrl(null, env)).toThrow(/BETTER_AUTH_URL/)
			expect(() => webhookUrl('tok', null, env)).toThrow(/BETTER_AUTH_URL/)
			expect(dashboardUrlOrNull(env)).toBeNull()
			expect(webhookBaseUrlOrNull(env)).toBeNull()
			expect(webhookConfigError(env)).toMatch(/BETTER_AUTH_URL/)
			expect(dashboardTrustedOrigins(env)).not.toContain(SITE_URL)
		})
	}
	it('development without BETTER_AUTH_URL uses the local dev server', () => {
		expect(dashboardUrl({ NODE_ENV: 'development' })).toBe(DEV_DASHBOARD_URL)
		expect(dashboardUrl({})).toBe(DEV_DASHBOARD_URL)
		// a set but broken value is not silently replaced, even in dev
		expect(dashboardUrlOrNull({ NODE_ENV: 'development', BETTER_AUTH_URL: 'nope' })).toBeNull()
	})
	it('a split install hands out webhooks on its first site host', () => {
		expect(webhookBaseUrl(null, prod({ POWDER_SITE_HOST: 'site.example.com' }))).toBe('https://site.example.com')
		expect(webhookConfigError(prod({ POWDER_SITE_HOST: 'site.example.com' }))).toBeNull()
	})
})

// Source guard: SITE_URL only feeds links that intentionally point at the project
// (its docs and site) and siteUrl()'s static-docs canonical base.
const SRC = join(__dirname, '../..')
function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) {
			if (name !== '__tests__' && name !== 'node_modules') walk(p, out)
		} else if (/\.(ts|tsx)$/.test(name)) out.push(p)
	}
	return out
}
const files = walk(SRC).map((p) => ({ rel: relative(SRC, p), src: readFileSync(p, 'utf8') }))

describe('no webhook, notification or log URL is built from SITE_URL', () => {
	it('only project-link files import SITE_URL', () => {
		const importers = files
			.filter((f) => /\bSITE_URL\b/.test(f.src.replace(/\/\/.*$/gm, '')))
			.map((f) => f.rel)
			.sort()
		expect(importers).toEqual([
			'components/agent-prompts.tsx', // docs links in copyable agent prompts
			'lib/agent-help-prompts.ts', // docs links in agent help prompts
			'lib/agents-md.ts', // "deployed by powder" and docs links in AGENTS.md
			'lib/hosts.ts', // siteUrl() only (asserted below)
			'lib/site.ts', // the definition
			'lib/sync-deployment-md.ts', // the docs link in DEPLOYMENT.md
		])
	})
	it('hosts.ts reads SITE_URL only inside siteUrl()', () => {
		const src = files.find((f) => f.rel === 'lib/hosts.ts')?.src ?? ''
		const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
		const uses = [...code.matchAll(/\bSITE_URL\b/g)].map((m) => m.index ?? -1)
		const body = code.indexOf('export function siteUrl(')
		const end = code.indexOf('\n}\n', body)
		const inSiteUrl = (i: number) => i > body && i < end
		const isImport = (i: number) => code.lastIndexOf('import', i) > code.lastIndexOf('\n', i)
		expect(uses.filter((i) => !inSiteUrl(i) && !isImport(i))).toEqual([])
	})
	it('the URL builders use dashboardUrl(), never the project domain', () => {
		for (const rel of [
			'lib/notifications.ts',
			'lib/github-deployments.ts',
			'lib/env-vars-db.ts',
			'lib/deploy-runner.ts',
			'app/api/mcp/route.ts',
			'app/api/apps/route.ts',
			'app/api/projects/[id]/context/route.ts',
		]) {
			const src = files.find((f) => f.rel === rel)?.src
			expect(src, rel).toBeDefined()
			expect(src, rel).not.toMatch(/\bSITE_URL\b|powder\.sh/)
		}
	})
	it('every route that installs a webhook refuses first without a base URL', () => {
		for (const f of files.filter((x) => /\bcreateWebhook\(/.test(x.src) && x.rel.startsWith('app/'))) {
			const refuse = f.src.indexOf('webhookConfigError()')
			expect(refuse, f.rel).toBeGreaterThan(-1)
			expect(refuse, f.rel).toBeLessThan(f.src.indexOf('createWebhook('))
		}
	})
})
