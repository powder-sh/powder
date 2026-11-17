// host-cron import runs server-side on the RAW crontab line (the
// list only carries masked text), a masked http path is refused, and a $VAR
// bearer header is not masked (it is a reference, not a secret).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const inserted: Record<string, unknown>[] = []
let crontab = ''
let importViaToken = false
vi.mock('@/lib/access', () => ({
	// an admin browser session (a token may not import a cron with a bearer var)
	requireContainerAccess: async () => ({ user: { id: 'u1', isAdmin: true, viaToken: importViaToken }, server: { id: 's' } }),
}))
vi.mock('@/lib/ssh', () => ({
	getRootCrontab: async () => crontab,
	inspectContainer: async () => ({ ports: [] }),
	extractHostPorts: () => [],
}))
vi.mock('@/lib/app-hosts', () => ({ defaultHostFor: () => 'myapp.apps.example.com' }))
vi.mock('@/lib/cron-scheduler', () => ({ ensureAppCronToken: async () => ({ token: 'tok', minted: true }) }))
vi.mock('@/lib/db', () => ({
	createId: () => 'cron_1',
	prefixes: { cronJob: 'cron' },
	cronJobs: {},
	db: {
		insert: () => ({
			values: async (v: Record<string, unknown>) => {
				inserted.push(v)
			},
		}),
	},
}))
import { POST } from '../../app/api/servers/[id]/containers/[name]/crons/import/route'
import { parseJobInput } from '../managed-crons'
import { redactSecrets } from '../secret-text'

const ctx = { params: Promise.resolve({ id: 's', name: 'myapp' }) }
const post = (b: unknown) =>
	POST(new Request('http://x', { method: 'POST', body: JSON.stringify(b) }), ctx)

describe('secret-text keeps $VAR bearer references readable', () => {
	it('masks literal tokens, not $VAR / ${VAR}', () => {
		expect(redactSecrets('curl -H "Authorization: Bearer $CRON_SECRET" https://x')).toContain(
			'Bearer $CRON_SECRET',
		)
		expect(redactSecrets("curl -H 'Authorization: Bearer ${CRON_SECRET}' https://x")).toContain(
			'Bearer ${CRON_SECRET}',
		)
		expect(redactSecrets('Authorization: token $GH_TOKEN')).toContain('token $GH_TOKEN')
		expect(redactSecrets('curl -H "Authorization: Bearer abcd1234efgh" x')).not.toContain(
			'abcd1234efgh',
		)
		expect(redactSecrets('curl -H "Authorization: Bearer $(cat /run/s)" x')).not.toContain('$(cat')
		expect(redactSecrets('Authorization: Bearer $Xsecretpart-tail')).not.toContain('tail')
	})
})

describe('parseJobInput refuses a masked http path', () => {
	it('urlPath with [redacted]', () => {
		const r = parseJobInput({
			schedule: '0 6 * * *',
			kind: 'http',
			urlPath: '/api/cron?token=[redacted]',
		})
		expect(r.ok).toBe(false)
		expect(r.ok === false && r.error).toContain('[redacted]')
	})
})

describe('import route uses the raw crontab line', () => {
	beforeEach(() => {
		inserted.length = 0
	})
	it('stores the raw path + bearer var, paused, with a masked audit copy', async () => {
		const line =
			'curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" "https://myapp.apps.example.com/api/cron/digest?key=rawsecretvalue123456"'
		crontab = `0 6 * * * ${line}\n`
		const masked = redactSecrets(line)
		expect(masked).not.toContain('rawsecretvalue123456')
		const res = await post({ index: 0, command: masked })
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.id).toBe('cron_1')
		expect(JSON.stringify(body)).not.toContain('rawsecretvalue123456')
		const row = inserted[0] ?? {}
		// a secret-named query parameter is dropped at import (stored and shown as is)
		expect(row.urlPath).toBe('/api/cron/digest')
		expect(String(body.warnings)).toContain('key dropped')
		expect(row.bearerEnvVar).toBe('CRON_SECRET')
		expect(row.enabled).toBe(false)
		expect(String(row.importedFrom)).not.toContain('rawsecretvalue123456')
	})
	it('a token importing a line with a bearer var is refused (session-only action)', async () => {
		crontab = '0 6 * * * curl -s -H "Authorization: Bearer $CRON_SECRET" "https://myapp.apps.example.com/api/cron/x"\n'
		importViaToken = true
		try {
			const res = await post({ index: 0, command: redactSecrets(crontab.slice(10).trim()) })
			expect(res.status).toBe(403)
			expect(inserted).toHaveLength(0)
		} finally {
			importViaToken = false
		}
	})
	it('refuses when the crontab changed since the list (409)', async () => {
		crontab = '0 6 * * * docker exec myapp node a.js\n'
		const res = await post({ index: 0, command: 'docker exec myapp node b.js' })
		expect(res.status).toBe(409)
		expect(inserted).toEqual([])
		expect((await post({ index: 3, command: 'docker exec myapp node a.js' })).status).toBe(409)
	})
	it('bad body is 400', async () => {
		expect((await post({ index: -1, command: 'x' })).status).toBe(400)
		expect((await post({ command: 'x' })).status).toBe(400)
	})
})
