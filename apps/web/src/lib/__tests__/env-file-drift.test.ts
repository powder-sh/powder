// Drift (env file vs running container) is computed server-side on raw values:
// the page only gets masked values, and comparing `****xy` tails missed drift
// for short values and values sharing the last two characters.
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => ({
		user: { id: 'a', isAdmin: true },
		server: { id: 's', kind: 'compose' },
	}),
}))
vi.mock('@/lib/ssh', () => ({
	inspectContainer: async () => ({
		env: [
			{ key: 'SAME', value: 'value-ab' },
			{ key: 'TAIL', value: 'zzzzzz-ab' },
			{ key: 'SHORT', value: 'b' },
		],
	}),
	findEnvFile: async () => ({
		path: '/p',
		exists: true,
		contents: 'SAME=value-ab\nTAIL=yyyyyy-ab\nSHORT=a\nNEW=x\n',
		candidates: ['/p'],
	}),
	readEnvFile: async () => ({ exists: true, contents: '' }),
	envFileCandidatesFor: () => [],
	writeEnvFile: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ and: () => 0, eq: () => 0, appRepos: {}, db: {} }))
vi.mock('@/lib/env-vars-db', () => ({
	auditCtxFromRequest: () => ({}),
	deleteForProject: vi.fn(),
	isEnvDbModeEnabled: () => false,
	listForProject: vi.fn(),
	renderEnvFile: vi.fn(),
	setForProject: vi.fn(),
}))

import { GET } from '../../app/api/servers/[id]/containers/[name]/env-file/route'

describe('env-file GET: per-key differs', () => {
	it('flags exactly the keys whose raw value differs from the container', async () => {
		const res = await GET(new Request('http://x/api'), {
			params: Promise.resolve({ id: 's', name: 'app' }),
		})
		const body = (await res.json()) as {
			entries: { key: string; value: string; differs: boolean }[]
		}
		const differs = Object.fromEntries(body.entries.map((e) => [e.key, e.differs]))
		expect(differs).toEqual({ SAME: false, TAIL: true, SHORT: true, NEW: true })
		expect(JSON.stringify(body)).not.toContain('yyyyyy')
	})
})
