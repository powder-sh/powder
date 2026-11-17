// GET /api/deploys/<id> masks output, error and errorSummary at read.
import { describe, expect, it, vi } from 'vitest'

const SECRET = 'PGPASSWORD=pw123456'
vi.mock('@/lib/access', () => ({
	requireUser: async () => ({ id: 'u', isAdmin: true }),
	requireContainerAccess: async () => ({ user: { id: 'u' }, server: {} }),
}))
const ROW = {
	id: 'dep_1',
	serverId: 's',
	containerName: 'app',
	output: `ran ${SECRET} pg_dump`,
	error: `failed ${SECRET}`,
	errorSummary: SECRET,
	failedStep: `step ${SECRET}`,
}
// Every query answers with the one row; the next-step lookups chain orderBy/limit.
const rows = () => {
	const p = Promise.resolve([ROW]) as Promise<(typeof ROW)[]> & {
		orderBy: () => typeof p
		limit: () => typeof p
	}
	p.orderBy = () => p
	p.limit = () => p
	return p
}
vi.mock('@/lib/db', () => ({
	eq: () => null,
	and: () => null,
	desc: () => null,
	isNotNull: () => null,
	sql: Object.assign(() => null, { raw: () => null }),
	deploys: {},
	appRepos: {},
	db: { select: () => ({ from: () => ({ where: rows }) }) },
}))
import { GET } from '../../app/api/deploys/[deployId]/route'

describe('GET /api/deploys/<id>', () => {
	it('returns output, error and errorSummary masked', async () => {
		const r = await GET(new Request('http://x'), { params: Promise.resolve({ deployId: 'dep_1' }) })
		const { deploy } = await r.json()
		for (const k of ['output', 'error', 'errorSummary', 'failedStep']) {
			expect(deploy[k], k).not.toContain('pw123456')
		}
		expect(deploy.output).toContain('pg_dump')
	})
})
