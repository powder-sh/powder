// Secret egress:
// - the container page loads env masked and reveals one key per click;
// - inspect / env-file reveal one key with `&key=`, and never serve powder itself;
// - stored env previews older than the length-only shape never leave powder.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LENGTH_ONLY_PREVIEW_RE, safeStoredPreview } from '../secret-text'

// the powder-self refusal lives in requireContainerAccess (the one authority);
// the mock keeps that part of it.
vi.mock('@/lib/access', async () => {
	const { powderSelfDenied } = await vi.importActual<typeof import('../secret-mask')>('../secret-mask')
	return {
		requireContainerAccess: async (_id: string, name: string) =>
			powderSelfDenied(name) ?? {
				user: { id: 'a', isAdmin: true },
				server: { id: 's', kind: 'compose' },
			},
	}
})
vi.mock('@/lib/ssh', () => ({
	inspectContainer: async () => ({
		name: 'app',
		env: [
			{ key: 'DB_PASSWORD', value: 'supersecret42' },
			{ key: 'API_KEY', value: 'otherapikey77' },
		],
	}),
	findEnvFile: async () => ({
		path: '/p',
		exists: true,
		contents: 'A=aaaaaaaa11\nB=bbbbbbbb22\n',
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

import {
	GET as envGet,
	PUT as envPut,
} from '../../app/api/servers/[id]/containers/[name]/env-file/route'
import { GET as inspectGet } from '../../app/api/servers/[id]/containers/[name]/inspect/route'

const ctx = (name = 'app') => ({ params: Promise.resolve({ id: 's', name }) })
const req = (q = '') => new Request(`http://x/api?${q}`)

describe('per-key reveal', () => {
	it('inspect: reveal=1&key= reveals that key only', async () => {
		const body = await (await inspectGet(req('reveal=1&key=DB_PASSWORD'), ctx())).json()
		expect(body.env.find((e: { key: string }) => e.key === 'DB_PASSWORD').value).toBe(
			'supersecret42',
		)
		expect(JSON.stringify(body)).not.toContain('otherapikey77')
	})
	it('env-file: reveal=1&key= reveals that key only, raw stays masked', async () => {
		const body = await (await envGet(req('reveal=1&key=B'), ctx())).json()
		expect(body.entries.find((e: { key: string }) => e.key === 'B').value).toBe('bbbbbbbb22')
		expect(JSON.stringify(body)).not.toContain('aaaaaaaa11')
		expect(body.raw).not.toContain('bbbbbbbb22')
	})
})

describe('powder never serves its own container env', () => {
	for (const name of ['powder', 'powder-worker']) {
		it(`${name}: inspect, env-file GET and PUT are 404`, async () => {
			expect((await inspectGet(req('reveal=1'), ctx(name))).status).toBe(404)
			expect((await envGet(req('reveal=1'), ctx(name))).status).toBe(404)
			const put = new Request('http://x/api', {
				method: 'PUT',
				body: JSON.stringify({ entries: [] }),
			})
			expect((await envPut(put, ctx(name))).status).toBe(404)
		})
	}
})

describe('container page loads env masked', () => {
	const page = readFileSync(
		join(__dirname, '../../app/(dashboard)/servers/[id]/[name]/page.tsx'),
		'utf8',
	)
	it('no reveal=1 in the on-load inspect / env-file fetches', () => {
		const load = page.slice(
			page.indexOf('async function loadDetail'),
			page.indexOf('async function loadDeploys'),
		)
		expect(load).toContain('/inspect`')
		expect(load).not.toMatch(/inspect\?reveal=1/)
		expect(load).not.toMatch(/env-file\?scope=\$\{scope\}&reveal=1/)
	})
	it('a reveal is per key (revealEnvValue sends key=)', () => {
		expect(page).toMatch(/new URLSearchParams\(\{ reveal: '1', key \}\)/)
	})
})

describe('safeStoredPreview: only the length-only shape leaves powder', () => {
	it('keeps the length-only shape and empty / null', () => {
		expect(safeStoredPreview('•••• (40 chars)')).toBe('•••• (40 chars)')
		expect(safeStoredPreview('')).toBe('')
		expect(safeStoredPreview(null)).toBeNull()
		expect(LENGTH_ONLY_PREVIEW_RE.test('•••• (3 chars)')).toBe(true)
	})
	it('prefix-format previews and whole short values become a bare mask, no length', () => {
		for (const old of ['sk_l…', 'abcd…', 'hunter2', '(short)', '•••• (40 chars) x']) {
			expect(safeStoredPreview(old)).toBe('••••')
		}
	})
	it('every preview reader goes through it', () => {
		const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')
		const db = src('lib/env-vars-db.ts')
		expect(
			db.match(/safeStoredPreview\(row\.(?:valuePreview|oldValuePreview|newValuePreview)\)/g)
				?.length,
		).toBe(4)
		expect(db).not.toContain('disk_preview')
		expect(src('app/api/internal/apps/route.ts')).toContain('preview: safeStoredPreview(e.preview)')
	})
})
