import { describe, expect, it } from 'vitest'

// The per-app deploy list reads log windows only for the newest rows: the ids are picked
// by a subquery with the order and the LIMIT, and left()/right() run in the outer query
// over that id set. Before, they ran on every row of the app ahead of the LIMIT.
const url = process.env.POWDER_TEST_DATABASE_URL
if (url) process.env.DATABASE_URL = url

describe('recentDeploysQuery', () => {
	it('computes the windows only over the limited id set', async () => {
		const { recentDeploysQuery, RECENT_DEPLOYS } = await import('../project-deploys-db')
		const { sql, params } = recentDeploysQuery('srv-1', 'shop').toSQL()
		const sub = sql.match(/"deploys"\."id" in \((select .*? limit \$\d+)\)/i)
		expect(sub, sql).not.toBeNull()
		const inner = sub?.[1] ?? ''
		// the subquery: plain columns, newest push first, limited
		expect(inner).toMatch(/^select "id" from "deploys" where/i)
		expect(inner).toMatch(/order by "deploys"\."queued_at" desc, "deploys"\."id" desc limit \$\d+$/i)
		expect(inner).not.toMatch(/left\(|right\(/i)
		expect(params).toContain(RECENT_DEPLOYS)
		// the windows are in the outer select list, and the outer query has no LIMIT of its own
		const outer = sql.replace(sub?.[0] ?? '', '')
		expect(outer).toMatch(/left\("output"/i)
		expect(outer).toMatch(/right\("output"/i)
		expect(outer).toMatch(/right\("error"/i)
		expect(outer).not.toMatch(/\blimit\b/i)
	})
})
