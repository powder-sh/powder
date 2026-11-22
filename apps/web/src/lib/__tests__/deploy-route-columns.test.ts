// The deploy route and api/internal/apps return explicit picks of deploy columns (never a
// spread of the row, so no raw text rides along). A column added later must not be left out
// silently: every schema column is returned, or named on an exclusion list with a reason.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableColumns } from '@powder/db'
import { deploys as deploysTable } from '@powder/db/schema'
import { describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({ row: {} as Record<string, unknown>, calls: 0 }))

vi.mock('@/lib/access', () => ({
	requireUser: async () => ({ id: 'u1', isAdmin: true }),
	requireContainerAccess: async () => ({ server: { kind: 'compose' } }),
}))
vi.mock('@/lib/db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const select = () => {
		const first = H.calls++ === 0
		const c: Record<string, unknown> = {}
		for (const k of ['from', 'where', 'orderBy', 'limit']) c[k] = () => c
		c.then = (ok: (v: unknown) => unknown) => ok(first ? [H.row] : [])
		return c
	}
	return { ...real, db: { select } }
})

import { GET } from '@/app/api/deploys/[deployId]/route'

/** Schema columns the deploy route leaves out on purpose, with the reason. */
const DEPLOY_ROUTE_EXCLUDED: Record<string, string> = {}

/** Columns api/internal/apps selects but does not return, with the reason. */
const INTERNAL_APPS_EXCLUDED: Record<string, string> = {}

describe('deploy columns returned by the explicit picks', () => {
	it('the deploy route returns every schema column or names why not', async () => {
		const cols = Object.keys(getTableColumns(deploysTable))
		expect(cols.length).toBeGreaterThan(20)
		H.row = Object.fromEntries(cols.map((c) => [c, c === 'status' ? 'success' : null]))
		H.row.id = 'dep_1'
		H.calls = 0
		const res = await GET(new Request('http://x/api/deploys/dep_1'), { params: Promise.resolve({ deployId: 'dep_1' }) })
		const body = (await res.json()) as { deploy: Record<string, unknown> }
		const returned = Object.keys(body.deploy)
		const missing = cols.filter((c) => !returned.includes(c) && !(c in DEPLOY_ROUTE_EXCLUDED))
		expect(missing).toEqual([])
		// nothing returned that is not a column
		expect(returned.filter((k) => !cols.includes(k))).toEqual([])
	})
	it('api/internal/apps returns every column it selects', () => {
		const src = readFileSync(join(__dirname, '..', '..', 'app', 'api', 'internal', 'apps', 'route.ts'), 'utf8')
		const block = (from: string, to: string) => {
			const a = src.indexOf(from)
			expect(a, from).toBeGreaterThan(-1)
			return src.slice(a, src.indexOf(to, a))
		}
		const keys = (s: string) => [...s.matchAll(/^\t+(\w+):/gm)].map((m) => m[1] as string)
		const selected = keys(block('const recent = await db', '.from(deploys)'))
		const returned = keys(block('deploys: recent.map(', '})),'))
		expect(selected.length).toBeGreaterThan(5)
		expect(selected.filter((c) => !returned.includes(c) && !(c in INTERNAL_APPS_EXCLUDED))).toEqual([])
	})
})
