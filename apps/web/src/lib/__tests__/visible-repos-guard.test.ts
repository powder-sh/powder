// Powder's own app row (isPowderSelfContainer) in lists has ONE authority:
// lib/access.ts visibleRepos / excludeSelf / hiddenSelfNames. This guard walks every
// API route file (and the MCP tools, which call routes in-process) and fails when one
// lists app rows or deploys (a query not pinned to one app) without that helper.
// The behaviour of the helper itself is tested at the bottom.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const SRC = join(__dirname, '../..')

// Listings that keep powder's own row on purpose, each with the reason.
const ALLOW: Record<string, string> = {
	// counts apps and domains for the first-run checklist; no names, logs or env.
	'app/api/setup/checklist/route.ts': 'counts only',
	// backup age/size per app for the ops hub: powder's own backup must stay
	// watched (a stale self backup is exactly what it alarms on). No env, no logs.
	'app/api/internal/backups/route.ts': 'backup health includes powder itself',
	// session-only admin action over every postgres app, powder included.
	'app/api/internal/backups/prune/route.ts': 'session-only admin prune',
}

const HELPER = /\b(visibleRepos|excludeSelf|hiddenSelfNames)\(/
const HELPER_IMPORT = /import\s*\{[^}]*\b(visibleRepos|excludeSelf|hiddenSelfNames)\b[^}]*\}\s*from\s*'(@\/lib\/access|\.\.?\/access)'/

function walk(dir: string, out: string[]) {
	for (const name of readdirSync(dir)) {
		if (name === '__tests__' || name === 'node_modules') continue
		const p = join(dir, name)
		if (statSync(p).isDirectory()) walk(p, out)
		else if (name === 'route.ts') out.push(p)
	}
}

/** The chained query after `.from(x)`: up to the first line, at paren depth 0,
 *  that does not continue the chain with `.`. */
function chainAfter(src: string, at: number): string {
	let depth = 0
	let i = at
	for (; i < src.length; i++) {
		const c = src[i]
		if (c === '(') depth++
		else if (c === ')') {
			depth--
			if (depth < 0) break
		} else if (c === '\n' && depth === 0) {
			// comment lines inside the chain do not end it
			const rest = src.slice(i + 1).replace(/^(\s*\/\/[^\n]*\n)+/, '').trimStart()
			if (!rest.startsWith('.')) break
		}
	}
	return src.slice(at, i)
}

const PIN: Record<string, RegExp> = {
	appRepos: /eq\(\s*appRepos\.(id|containerName|webhookToken)\b/,
	deploys: /eq\(\s*deploys\.(id|containerName)\b/,
}

/** "<file>: <why>" for each listing of app rows or deploys the file makes. */
function listings(rel: string, src: string): string[] {
	const out: string[] = []
	for (const table of Object.keys(PIN)) {
		const re = new RegExp(`\\.from\\(${table}\\)`, 'g')
		for (let m = re.exec(src); m; m = re.exec(src)) {
			const chain = chainAfter(src, m.index + m[0].length)
			if (!PIN[table]?.test(chain)) out.push(`${rel}: .from(${table}) not pinned to one app`)
		}
	}
	if (/\b(FROM|JOIN)\s+app_repos\b/i.test(src)) out.push(`${rel}: raw SQL over app_repos`)
	if (/\bFROM\s+deploys\b/i.test(src) && !/WHERE[\s\S]{0,80}\bid\s*=/.test(src))
		out.push(`${rel}: raw SQL over deploys`)
	return out
}

const files: string[] = []
walk(join(SRC, 'app'), files)
for (const f of readdirSync(join(SRC, 'lib/mcp'))) if (f.endsWith('.ts')) files.push(join(SRC, 'lib/mcp', f))

describe('list routes take their app set from the visibility helper', () => {
	it('finds the route files', () => {
		expect(files.length).toBeGreaterThan(50)
	})

	it('no file imports a raw listRepos from lib/access', () => {
		const bad = files
			.map((f) => [relative(SRC, f), readFileSync(f, 'utf8')] as const)
			.filter(([, s]) => /import\s*\{[^}]*\blistRepos\b[^}]*\}\s*from\s*'(@\/lib\/access|\.\.?\/access)'/.test(s))
			.map(([r]) => r)
		expect(bad).toEqual([])
	})

	it('every route that lists apps or deploys uses visibleRepos / excludeSelf / hiddenSelfNames', () => {
		const bad: string[] = []
		for (const f of files) {
			const rel = relative(SRC, f)
			if (ALLOW[rel]) continue
			const src = readFileSync(f, 'utf8')
			const found = listings(rel, src)
			const usesHelper = HELPER.test(src) && (HELPER_IMPORT.test(src) || rel.startsWith('lib/'))
			if (found.length > 0 && !usesHelper) bad.push(...found)
		}
		expect(bad, `take the app set from lib/access.ts visibleRepos (or excludeSelf), or add the route to ALLOW with a reason:\n${bad.join('\n')}`).toEqual([])
	})

	it('the routes that leaked powder itself use the helper', () => {
		for (const rel of [
			'app/api/databases/route.ts',
			'app/api/logs/search/route.ts',
			'app/api/internal/deploys/route.ts',
			'app/api/deploys-list/route.ts',
			'app/api/projects/route.ts',
			'app/api/env-vars/route.ts',
			'lib/mcp/tools.ts',
		]) {
			expect(HELPER.test(readFileSync(join(SRC, rel), 'utf8')), rel).toBe(true)
		}
	})

	it('env values and connection strings never include powder itself, even for an admin session', () => {
		for (const rel of ['app/api/databases/route.ts', 'app/api/env-vars/route.ts']) {
			const src = readFileSync(join(SRC, rel), 'utf8')
			expect(src, rel).toMatch(/visibleRepos\(user, 'never'\)/)
			expect(src, rel).not.toMatch(/'admin-session'/)
		}
	})
})

vi.mock('../db', () => ({
	and: () => 0,
	eq: () => 0,
	isNull: () => 0,
	appRepos: {},
	previewDeploys: {},
	user: {},
	userApiTokens: {},
	db: {
		select: () => ({
			from: async () => [
				{ id: 'r1', containerName: 'shop' },
				{ id: 'r2', containerName: 'powder' },
				{ id: 'r3', containerName: 'powder-worker' },
			],
		}),
	},
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('../auth', () => ({ auth: { api: { getSession: async () => null } } }))

describe('visibleRepos / excludeSelf / hiddenSelfNames', () => {
	const session = { isAdmin: true, viaToken: false }
	const token = { isAdmin: true, viaToken: true }

	it('a token never sees powder itself', async () => {
		const a = await import('../access')
		expect((await a.visibleRepos(token, 'admin-session')).map((r) => r.containerName)).toEqual(['shop'])
		expect((await a.visibleRepos(token, 'never')).map((r) => r.containerName)).toEqual(['shop'])
		expect(a.hiddenSelfNames(token, 'admin-session')).toEqual(expect.arrayContaining(['powder', 'powder-worker']))
	})

	it("an admin session sees it only with 'admin-session'", async () => {
		const a = await import('../access')
		expect(await a.visibleRepos(session, 'admin-session')).toHaveLength(3)
		expect((await a.visibleRepos(session, 'never')).map((r) => r.containerName)).toEqual(['shop'])
		expect(a.hiddenSelfNames(session, 'admin-session')).toEqual([])
		expect(a.excludeSelf([{ app: 'powder' }, { app: 'x' }], token, 'admin-session', (r) => r.app)).toEqual([{ app: 'x' }])
	})
})
