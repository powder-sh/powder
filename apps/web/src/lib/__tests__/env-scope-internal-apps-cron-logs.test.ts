// Env scope (unknown -> 400, absent -> production), /api/internal/apps
// hides powder's own row from tokens, crons systemd logs only for a listed timer,
// input checks (logs tail, rollback body, env null body, env key param). Invented names.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const h = vi.hoisted(() => ({
	user: null as unknown,
	set: [] as Array<{ key: string; scope: string }>,
	bulk: [] as Array<{ scope: string }>,
	del: [] as Array<{ key: string; scope: string }>,
	repos: [] as Array<Record<string, unknown>>,
	run: [] as string[],
	timers: { code: 0, stdout: '' } as { code: number; stdout: string } | null,
	tails: [] as number[],
}))
const tokenAdmin = {
	id: 'u1',
	email: 'a@zorb.example',
	name: 'a',
	isAdmin: true,
	viaToken: true,
	tokenScopes: null,
}
const sessionAdmin = { id: 'u1', email: 'a@zorb.example', name: 'a', isAdmin: true }

vi.mock('@/lib/access', () => ({
	requireUser: async () => h.user,
	requireProjectAccess: async () => ({
		user: h.user,
		repo: { id: 'p1', containerName: 'zorbweb' },
	}),
	requireContainerAccess: async () => ({
		user: h.user,
		server: { id: 'boxa', host: 'h', kind: 'compose' },
	}),
	requireServerForUser: async () => ({ ok: true }),
	isManagedContainer: async () => true,
}))
vi.mock('@/lib/env-vars-db', () => ({
	envWriteCtx: () => ({}),
	listForProject: async () => [],
	setForProject: async (_id: string, key: string, _v: string, scope: string) => {
		h.set.push({ key, scope })
		return { key, scope }
	},
	bulkImportFromText: async (_id: string, _t: string, scope: string) => {
		h.bulk.push({ scope })
		return { imported: 0, skipped: 0, existing: 0, deniedKeys: [] }
	},
	deleteForProject: async (_id: string, key: string, scope: string) => {
		h.del.push({ key, scope })
		return { deleted: true }
	},
}))
// A chainable stand-in for the drizzle query builder: every await yields h.repos for the
// app lookup and [] for the deploys / env lookups that follow it.
vi.mock('@/lib/db', () => {
	const q = (rows: () => unknown[]) => {
		const c = Object.assign(Promise.resolve().then(rows), {}) as Promise<unknown> &
			Record<string, unknown>
		for (const k of ['from', 'where', 'orderBy', 'limit']) c[k] = () => c
		return c
	}
	let n = 0
	return {
		and: () => 0,
		eq: () => 0,
		desc: () => 0,
		appRepos: {},
		appEnvVars: {},
		deploys: {},
		db: { select: () => q(() => (n++ % 3 === 0 ? h.repos : [])) },
		__reset: () => {
			n = 0
		},
	}
})
vi.mock('@/lib/servers', () => ({
	getServer: async () => ({ id: 'boxa', name: 'boxa', host: 'h', kind: 'compose' }),
}))
vi.mock('@/lib/ssh', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		h.run.push(cmd)
		if (cmd.startsWith('systemctl list-timers')) {
			if (!h.timers) throw new Error('ssh down')
			return { ...h.timers, stderr: '' }
		}
		return { code: 0, stdout: 'journal lines', stderr: '' }
	},
	getContainerLogs: async (_s: unknown, _n: string, tail: number) => {
		h.tails.push(tail)
		return 'log'
	},
}))

import * as dbm from '@/lib/db'
import { NextRequest } from 'next/server'
import { POST as cronLogsPOST } from '../../app/api/crons/logs/route'
import { GET as appsGET } from '../../app/api/internal/apps/route'
import { DELETE as envKeyDELETE } from '../../app/api/projects/[id]/env/[key]/route'
import { POST as envPOST, PUT as envPUT } from '../../app/api/projects/[id]/env/route'
import { GET as logsGET } from '../../app/api/servers/[id]/containers/[name]/logs/route'
import { POST as rollbackPOST } from '../../app/api/servers/[id]/containers/[name]/rollback/route'
import { timerListed } from '../cron-timers'
import { parseEnvScope } from '../env-scope'

const pid = { params: Promise.resolve({ id: 'p1' }) }
const keyCtx = (key: string) => ({ params: Promise.resolve({ id: 'p1', key }) })
const cctx = { params: Promise.resolve({ id: 'boxa', name: 'zorbweb' }) }
const must = async (p: Promise<Response | undefined>): Promise<Response> => {
	const r = await p
	if (!r) throw new Error('no response')
	return r
}
const jsonReq = (method: string, body: string) =>
	new Request('https://dash.example/x', { method, body })

beforeEach(() => {
	h.user = tokenAdmin
	h.set = []
	h.bulk = []
	h.del = []
	h.run = []
	h.tails = []
	h.repos = []
	h.timers = { code: 0, stdout: '' }
	;(dbm as unknown as { __reset: () => void }).__reset()
})

describe('env scope', () => {
	it('parseEnvScope: absent is production, unknown is null', () => {
		expect(parseEnvScope(undefined)).toBe('production')
		expect(parseEnvScope(null)).toBe('production')
		expect(parseEnvScope('preview')).toBe('preview')
		for (const bad of ['', 'Preview', 'preveiw', 'prod', 1, {}, []])
			expect(parseEnvScope(bad), JSON.stringify(bad)).toBeNull()
	})
	it('PUT: an unknown scope is a 400 and writes nothing; absent writes production', async () => {
		expect(
			(
				await must(
					envPUT(
						jsonReq('PUT', JSON.stringify({ key: 'ZORB_KEY', value: 'v', scope: 'preveiw' })),
						pid,
					),
				)
			).status,
		).toBe(400)
		expect(
			(
				await must(
					envPUT(jsonReq('PUT', JSON.stringify({ key: 'ZORB_KEY', value: 'v', scope: '' })), pid),
				)
			).status,
		).toBe(400)
		expect(h.set).toEqual([])
		expect(
			(await must(envPUT(jsonReq('PUT', JSON.stringify({ key: 'ZORB_KEY', value: 'v' })), pid)))
				.status,
		).toBe(200)
		expect(
			(
				await must(
					envPUT(
						jsonReq('PUT', JSON.stringify({ key: 'ZORB_KEY', value: 'v', scope: 'development' })),
						pid,
					),
				)
			).status,
		).toBe(200)
		expect(h.set).toEqual([
			{ key: 'ZORB_KEY', scope: 'production' },
			{ key: 'ZORB_KEY', scope: 'development' },
		])
	})
	it('POST (bulk): an unknown scope is a 400; absent imports into production', async () => {
		expect(
			(await must(envPOST(jsonReq('POST', JSON.stringify({ text: 'A=1', scope: 'staging' })), pid)))
				.status,
		).toBe(400)
		expect(h.bulk).toEqual([])
		expect(
			(await must(envPOST(jsonReq('POST', JSON.stringify({ text: 'A=1' })), pid))).status,
		).toBe(200)
		expect(h.bulk).toEqual([{ scope: 'production' }])
	})
	it('DELETE: an unknown scope is a 400; absent deletes production', async () => {
		const del = (q: string) =>
			envKeyDELETE(
				new Request(`https://dash.example/x${q}`, { method: 'DELETE' }),
				keyCtx('ZORB_KEY'),
			)
		expect((await del('?scope=preveiw')).status).toBe(400)
		expect((await del('?scope=')).status).toBe(400)
		expect(h.del).toEqual([])
		expect((await del('')).status).toBe(200)
		expect((await del('?scope=preview')).status).toBe(200)
		expect(h.del).toEqual([
			{ key: 'ZORB_KEY', scope: 'production' },
			{ key: 'ZORB_KEY', scope: 'preview' },
		])
	})
})

describe('/api/internal/apps and powder itself', () => {
	const get = (project: string) =>
		appsGET(new Request(`https://dash.example/api/internal/apps?project=${project}`))
	it("a token gets the plain 404 for powder's own rows, before any lookup", async () => {
		h.repos = [
			{
				id: 'r1',
				containerName: 'powder',
				serverId: 'boxa',
				repoUrl: 'u',
				branch: 'main',
				hasPostgres: true,
			},
		]
		for (const name of ['powder', 'powder-worker']) {
			const r = await get(name)
			expect(r.status).toBe(404)
			expect(await r.json()).toEqual({ error: 'not found' })
		}
	})
	it('an admin browser session still sees the powder row; a token sees other apps', async () => {
		h.user = sessionAdmin
		h.repos = [
			{
				id: 'r1',
				containerName: 'powder',
				serverId: 'boxa',
				repoUrl: 'u',
				branch: 'main',
				hasPostgres: true,
			},
		]
		expect((await get('powder')).status).toBe(200)
		h.user = tokenAdmin
		h.repos = [
			{
				id: 'r2',
				containerName: 'zorbweb',
				serverId: 'boxa',
				repoUrl: 'u',
				branch: 'main',
				hasPostgres: false,
			},
		]
		expect((await get('zorbweb')).status).toBe(200)
	})
})

describe('systemd cron logs only for a timer on the server', () => {
	const post = (origin: string) =>
		cronLogsPOST(
			new Request('https://dash.example/api/crons/logs', {
				method: 'POST',
				body: JSON.stringify({ serverId: 'boxa', origin, command: null }),
			}),
		)
	const listing =
		'Mon 2026-11-09 03:00:00 UTC 7h left Sun 2026-11-08 03:00:00 UTC 16h ago zorb-backup.timer zorb-backup.service\nn/a n/a n/a n/a logrotate.timer logrotate.service\n'
	it('timerListed matches whole fields only', () => {
		expect(timerListed(listing, 'zorb-backup.timer')).toBe(true)
		expect(timerListed(listing, 'backup.timer')).toBe(false)
		expect(timerListed('', 'zorb-backup.timer')).toBe(false)
	})
	it('a listed timer reads its journal', async () => {
		h.timers = { code: 0, stdout: listing }
		expect((await post('systemd:zorb-backup.timer')).status).toBe(200)
		expect(h.run.some((c) => c.includes("journalctl -u 'zorb-backup.service'"))).toBe(true)
	})
	it('an unlisted timer, a failed listing and an unreachable server are 404 with no journal read', async () => {
		h.timers = { code: 0, stdout: listing }
		expect((await post('systemd:ssh.timer')).status).toBe(404)
		h.timers = { code: 1, stdout: listing }
		expect((await post('systemd:zorb-backup.timer')).status).toBe(404)
		h.timers = null
		expect((await post('systemd:zorb-backup.timer')).status).toBe(404)
		expect(h.run.some((c) => c.includes('journalctl'))).toBe(false)
	})
})

describe('input checks', () => {
	it('logs: a non-numeric tail is the default 200, never NaN', async () => {
		for (const t of ['abc', '-5', '1e3', '99999', ''])
			expect(
				(await logsGET(new NextRequest(`https://dash.example/x?tail=${t}`), cctx)).status,
			).toBe(200)
		await logsGET(new NextRequest('https://dash.example/x?tail=50'), cctx)
		expect(h.tails).toEqual([200, 200, 200, 200, 200, 50])
	})
	it('rollback: a body that is not JSON, or a targetDeployId that is not a string, is a 400', async () => {
		for (const body of [
			'not json',
			'null',
			'[]',
			'{}',
			'{"targetDeployId":5}',
			'{"targetDeployId":{"a":1}}',
			'{"targetDeployId":""}',
		])
			expect((await rollbackPOST(jsonReq('POST', body), cctx)).status, body).toBe(400)
	})
	it('env: a null / array / scalar body is a 400, not a 500', async () => {
		for (const body of ['null', '[]', '7', '"x"']) {
			expect((await must(envPUT(jsonReq('PUT', body), pid))).status, body).toBe(400)
			expect((await must(envPOST(jsonReq('POST', body), pid))).status, body).toBe(400)
		}
	})
	it('env/[key]: the (already decoded) key is used as is and must be an env key', async () => {
		const del = (key: string) =>
			envKeyDELETE(new Request('https://dash.example/x', { method: 'DELETE' }), keyCtx(key))
		for (const bad of ['ZORB%5FKEY', '%', 'A B', '1ZORB', 'a'.repeat(201), ''])
			expect((await del(bad)).status, bad).toBe(400)
		expect(h.del).toEqual([])
		expect((await del('ZORB_KEY')).status).toBe(200)
		expect(h.del).toEqual([{ key: 'ZORB_KEY', scope: 'production' }])
	})
})
