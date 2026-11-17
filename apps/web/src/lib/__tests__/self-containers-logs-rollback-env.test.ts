import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// web lows: the logs route masks app logs and ssh errors; a token cannot pin a
// rollback's restored env (or disk-only keys) with an env-file save, and a token rollback
// restores the image only; the container routes refuse powder's own containers, keyed on
// POWDER_SELF_CONTAINER. Invented names.

let user: Record<string, unknown> = {}
let accessCalls = 0
let diskFile = ''
let marker: string | null = null
let logsOut = ''
let logsErr: Error | null = null
let repoRow: Record<string, unknown> = { id: 'repo_1', serverId: 's', containerName: 'quillbox' }
const writeEnvFile = vi.fn()

vi.mock('@/lib/access', () => ({
	// the one project access check, run on the mocked db and the real powderSelfDenied
	requireProjectAccess: async (id: string) => {
		accessCalls++
		const { db, appRepos, eq } = (await import('@/lib/db')) as unknown as { db: { select: () => { from: (t: unknown) => { where: (w: unknown) => { limit: (n: number) => Promise<Array<{ containerName?: string }>> } } } }; appRepos: { id: unknown }; eq: (a: unknown, b: unknown) => unknown }
		const [repo] = await db.select().from(appRepos).where(eq(appRepos.id, id)).limit(1)
		if (!repo) return Response.json({ error: 'not found' }, { status: 404 })
		const { powderSelfDenied } = await vi.importActual<typeof import('../secret-mask')>('../secret-mask')
		return powderSelfDenied(repo.containerName ?? '') ?? { user: user, repo }
	},
	requireUser: async () => {
		accessCalls++
		return user
	},
	// the powder-self refusal lives in requireContainerAccess (the one authority);
	// the mock keeps that part of it.
	requireContainerAccess: async (_id: string, name: string) => {
		accessCalls++
		const { powderSelfDenied } = await vi.importActual<typeof import('../secret-mask')>('../secret-mask')
		return powderSelfDenied(name) ?? { user, server: { id: 's', kind: 'compose' } }
	},
}))
vi.mock('@/lib/ssh', () => ({
	getContainerLogs: async () => {
		if (logsErr) throw logsErr
		return logsOut
	},
	streamContainerLogs: async () => ({ cancel: () => {} }),
	restartContainer: async () => {},
	findEnvFile: async () => ({ path: '/opt/apps/quillbox.env', exists: true, contents: diskFile }),
	readEnvFile: async () => ({ exists: true, contents: diskFile }),
	envFileCandidatesFor: async () => ['/opt/apps/quillbox.env'],
	inspectContainer: async () => ({ env: [] }),
	readEnvRestoreMarker: async () => marker,
	writeEnvFile: (...a: unknown[]) => writeEnvFile(...a),
}))
vi.mock('@/lib/env-vars-db', () => ({
	isEnvDbModeEnabled: () => true,
	listForProject: async () => [
		{ key: 'MAIL_API_KEY', scope: 'production' },
		{ key: 'APP_SECRET', scope: 'production' },
	],
	renderEnvFile: async () => 'MAIL_API_KEY=k1\nAPP_SECRET=s1\n',
	setForProject: async () => {},
	deleteForProject: async () => {},
	envWriteCtx: () => ({}),
	checkEnvRenderTarget: async () => null,
}))
vi.mock('@/lib/db', () => {
	const chain = () => {
		const c: Record<string, unknown> = {}
		for (const m of ['select', 'from', 'where']) c[m] = () => c
		c.limit = async () => [repoRow]
		c.then = (r: (v: unknown) => unknown) => r([repoRow])
		return c
	}
	return { and: () => 0, eq: () => 0, appRepos: {}, deploys: {}, db: { select: () => chain() } }
})

import { GET as logsGET } from '../../app/api/servers/[id]/containers/[name]/logs/route'
import { GET as streamGET } from '../../app/api/servers/[id]/containers/[name]/logs/stream/route'
import { POST as restartPOST } from '../../app/api/servers/[id]/containers/[name]/restart/route'
import { POST as rollbackPOST } from '../../app/api/servers/[id]/containers/[name]/rollback/route'
import { PUT as envFilePUT } from '../../app/api/servers/[id]/containers/[name]/env-file/route'
import { POST as redeployPOST } from '../../app/api/projects/[id]/redeploy/route'
import { isPowderSelfContainer } from '../secret-mask'

const token = { id: 'u', isAdmin: true, viaToken: true, tokenScopes: null }
const admin = { id: 'u', isAdmin: true }
const p = (name: string) => ({ params: Promise.resolve({ id: 's', name }) })

beforeEach(() => {
	accessCalls = 0
	writeEnvFile.mockReset()
	marker = null
	logsErr = null
	repoRow = { id: 'repo_1', serverId: 's', containerName: 'quillbox' }
})
afterEach(() => vi.unstubAllEnvs())

describe('powder self containers', () => {
	it('isPowderSelfContainer honours POWDER_SELF_CONTAINER and keeps the stock names', () => {
		const env = { POWDER_SELF_CONTAINER: 'hqdeploy' }
		for (const n of ['hqdeploy', 'hqdeploy-worker', 'powder', 'powder-worker']) expect(isPowderSelfContainer(n, env), n).toBe(true)
		for (const n of ['quillbox', 'hqdeploy-web', 'powder-postgres']) expect(isPowderSelfContainer(n, env), n).toBe(false)
		expect(isPowderSelfContainer('powder', {})).toBe(true)
		expect(isPowderSelfContainer('powder-worker', {})).toBe(true)
	})
	it('rollback, restart, logs, the log stream (through requireContainerAccess) and redeploy answer 404', async () => {
		vi.stubEnv('POWDER_SELF_CONTAINER', 'hqdeploy')
		user = admin
		const req = (u: string, init?: RequestInit) => new Request(`http://x${u}`, init)
		const nreq = (u: string) => Object.assign(req(u), { nextUrl: new URL(`http://x${u}`) }) as never
		for (const name of ['hqdeploy', 'hqdeploy-worker', 'powder']) {
			accessCalls = 0
			const rs = [
				await rollbackPOST(req('/r', { method: 'POST', body: '{"targetDeployId":"dep_1"}' }), p(name)),
				await restartPOST(req('/r', { method: 'POST' }), p(name)),
				await logsGET(nreq('/l'), p(name)),
				await streamGET(nreq('/s'), p(name)),
			]
			for (const r of rs) expect(r.status, name).toBe(404)
			// each route asks requireContainerAccess, which refuses
			expect(accessCalls, name).toBe(4)
		}
		repoRow = { id: 'repo_9', serverId: 's', containerName: 'hqdeploy' }
		accessCalls = 0
		const rd = await redeployPOST(req('/d', { method: 'POST' }), { params: Promise.resolve({ id: 'repo_9' }) })
		expect(rd.status).toBe(404)
		expect(accessCalls).toBe(1) // requireUser only; no deploy started
	})
})

describe('logs route masks', () => {
	it('app logs and ssh errors go through redactSecrets', async () => {
		user = admin
		const nreq = Object.assign(new Request('http://x/l'), { nextUrl: new URL('http://x/l?tail=10') }) as never
		logsOut = 'boot DATABASE_URL=postgres://app:Hunter2Hunter2pw@db:5432/app ok\n'
		const ok = (await (await logsGET(nreq, p('quillbox'))).json()) as { logs: string }
		expect(ok.logs).toContain('boot')
		expect(ok.logs).not.toContain('Hunter2Hunter2pw')
		logsErr = new Error('ssh: could not reach redis://default:Zq8sXv3Lm9Pq@cache:6379')
		const bad = await logsGET(nreq, p('quillbox'))
		expect(bad.status).toBe(500)
		expect(JSON.stringify(await bad.json())).not.toContain('Zq8sXv3Lm9Pq')
	})
})

describe('rollback env restore is admin-only; a token cannot pin it', () => {
	const put = (entries: { key: string; value: string }[]) =>
		envFilePUT(new Request('http://x/e', { method: 'PUT', body: JSON.stringify({ entries }) }), p('quillbox'))
	it('a token save is refused while the file is what a rollback restore wrote', async () => {
		user = token
		diskFile = 'MAIL_API_KEY=k0\nAPP_SECRET=s1\n'
		marker = createHash('sha256').update(diskFile, 'utf8').digest('hex')
		const r = await put([
			{ key: 'MAIL_API_KEY', value: 'k0' },
			{ key: 'APP_SECRET', value: 's2' },
		])
		expect(r.status).toBe(403)
		// one generic answer for every token refusal of an env file save
		expect(((await r.json()) as { code: string }).code).toBe('token_env_file')
		expect(writeEnvFile).not.toHaveBeenCalled()
		// After an admin save (the file changed) the marker no longer matches.
		marker = 'f'.repeat(64)
		const ok = await put([
			{ key: 'MAIL_API_KEY', value: 'k0' },
			{ key: 'APP_SECRET', value: 's2' },
		])
		expect(ok.status).toBe(200)
	})
	it('a token save is refused while the disk holds a key the DB does not; an admin may save', async () => {
		user = token
		diskFile = 'MAIL_API_KEY=k1\nAPP_SECRET=s1\nOLD_PAYMENT_SECRET=gone\n'
		const entries = [
			{ key: 'MAIL_API_KEY', value: 'k1' },
			{ key: 'APP_SECRET', value: 's2' },
			{ key: 'OLD_PAYMENT_SECRET', value: 'gone' },
		]
		const r = await put(entries)
		expect(r.status).toBe(403)
		expect(((await r.json()) as { code: string }).code).toBe('token_env_file')
		expect(writeEnvFile).not.toHaveBeenCalled()
		user = admin
		marker = createHash('sha256').update(diskFile, 'utf8').digest('hex')
		expect((await put(entries)).status).toBe(200)
	})
	it('the rollback route restores the env snapshot only for an admin session and says so otherwise', () => {
		const src = readFileSync(join(__dirname, '../../app/api/servers/[id]/containers/[name]/rollback/route.ts'), 'utf8')
		expect(src).toContain('const restoreEnv = isAdminSession(access.user)')
		const gate = src.indexOf('if (!restoreEnv)')
		const call = src.indexOf('restoreEnvSnapshot(server, envPath, target.id)')
		expect(gate).toBeGreaterThan(0)
		expect(call).toBeGreaterThan(gate)
		expect(src.slice(gate, call)).toContain('a token rollback restores the image only')
		expect(src.split('restoreEnvSnapshot(').length - 1).toBe(1)
	})
})
