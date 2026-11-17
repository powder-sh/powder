import { createRequire } from 'node:module'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const req = createRequire(join(__dirname, '../../../../../packages/db/package.json'))
const { DrizzleQueryError } = req('drizzle-orm') as {
	DrizzleQueryError: new (q: string, p: unknown[], cause?: Error) => Error
}

const h = vi.hoisted(() => ({
	insertError: null as unknown,
	// what INSERT ... ON CONFLICT DO NOTHING RETURNING gives back ([] = lock conflict)
	insertRows: [] as unknown[],
	onConflict: 0,
	updated: [] as { id: string }[],
	// per-call UPDATE results, consumed in order; falls back to `updated`
	updateQueue: [] as unknown[],
	setArg: undefined as unknown,
	setArgs: [] as unknown[],
	updateCalls: 0,
	deleting: false,
	// per-call SELECT results, consumed in order; falls back to the delete check
	selectQueue: [] as unknown[][],
	inserts: 0,
}))

vi.mock('../db', () => {
	const chain = (result: () => unknown) => {
		const c: Record<string, unknown> = {}
		for (const m of ['from', 'where', 'limit', 'values', 'returning', 'set', 'orderBy', 'for']) c[m] = () => c
		c.set = (v: unknown) => {
			h.setArg = v
			h.setArgs.push(v)
			return c
		}
		c.onConflictDoNothing = () => {
			h.onConflict++
			return c
		}
		c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
			try {
				return Promise.resolve(result()).then(res, rej)
			} catch (e) {
				return Promise.reject(e).then(res, rej)
			}
		}
		c.catch = (f: (e: unknown) => unknown) => (c.then as (a: unknown, b: unknown) => Promise<unknown>)(undefined, f)
		return c
	}
	const id = (x: unknown) => x
	const db: Record<string, unknown> = {
			insert: () =>
				chain(() => {
					h.inserts++
					if (h.insertError) throw h.insertError
					return h.insertRows
				}),
			update: () => {
				h.updateCalls++
				return chain(() => {
					const r = h.updateQueue.length ? h.updateQueue.shift() : h.updated
					if (r instanceof Error) throw r
					return r
				})
			},
			// startDeploy's only select in worker mode is the running-'delete' check
			select: () =>
				chain(() => (h.selectQueue.length ? h.selectQueue.shift() : h.deleting ? [{ id: 'dep_del' }] : [])),
	}
	db.transaction = (fn: (tx: unknown) => unknown) => fn(db)
	return {
		db,
		deploys: {},
		and: id, appDomains: {}, appRepos: {}, asc: id, createId: () => 'dep_x', desc: id, eq: id,
		isNull: id, notInArray: id, prefixes: { deploy: 'dep' }, sql: Object.assign((x: unknown) => x, { raw: id }),
	}
})
vi.mock('../ssh', () => ({}))
vi.mock('../deploy-queue', () => ({}))

import {
	AppBeingDeletedError,
	claimNextQueuedDeploy,
	DeployInFlightError,
	requeueClaimedDeploy,
	startDeploy,
	tryStartDeploy,
} from '../deploys'

const pgErr = (code: string) => Object.assign(new Error('duplicate key'), { code })
const opts = { serverId: 'server-2', containerName: 'blog', kind: 'git_deploy' as const, requestedSha: 'a'.repeat(40) }

beforeEach(() => {
	process.env.POWDER_DEPLOY_WORKER = 'true'
	h.insertError = null
	h.insertRows = []
	h.onConflict = 0
	h.updated = [{ id: 'dep_queued' }]
	h.updateQueue = []
	h.updateCalls = 0
	h.setArg = undefined
	h.setArgs = []
	h.deleting = false
	h.selectQueue = []
	h.inserts = 0
})

// The lock conflict must not raise (postgres logs every 23505 as an ERROR line,
// which a log scraper files as a DB error). ON CONFLICT DO NOTHING turns
// it into an empty RETURNING; the fold / in-flight answers stay the same.
describe('startDeploy lock conflict via ON CONFLICT DO NOTHING', () => {
	it('returns the inserted row when there is no conflict', async () => {
		h.insertRows = [{ id: 'dep_x', status: 'queued' }]
		const row = await startDeploy(opts)
		expect(row).toEqual({ id: 'dep_x', status: 'queued' })
		expect(h.onConflict).toBe(1)
		expect(h.updateCalls).toBe(0)
	})
	it('no row back + a queued row exists: folds into it and unpins requestedSha', async () => {
		const err = await startDeploy(opts).catch((e) => e)
		expect(h.onConflict).toBe(1)
		expect(err).toBeInstanceOf(DeployInFlightError)
		expect(err.coalesced).toBe(true)
		expect(h.updateCalls).toBe(1)
		expect(h.setArg).toEqual({ requestedSha: null })
	})
	it('no row back + no queued row (a running row holds the lock): plain in-flight', async () => {
		h.updated = []
		const err = await startDeploy(opts).catch((e) => e)
		expect(err).toBeInstanceOf(DeployInFlightError)
		expect(err.coalesced).toBeFalsy()
	})
	it('an inline (running) conflict never folds and never touches the queued row', async () => {
		const err = await startDeploy({ ...opts, inline: true }).catch((e) => e)
		expect(err).toBeInstanceOf(DeployInFlightError)
		expect(err.coalesced).toBeFalsy()
		expect(h.updateCalls).toBe(0)
	})
})

describe('requeueClaimedDeploy', () => {
	it('requeues when the guarded update flips the row', async () => {
		h.updateQueue = [[{ id: 'dep_1' }]]
		expect(await requeueClaimedDeploy('dep_1')).toBe('requeued')
		expect(h.setArgs[0]).toEqual({ status: 'queued', heartbeatAt: null })
	})
	it('gone when the row is no longer running', async () => {
		h.updateQueue = [[]]
		h.selectQueue = [[]]
		expect(await requeueClaimedDeploy('dep_1')).toBe('gone')
		expect(h.updateCalls).toBe(1)
	})
	it('a queued sibling covers it: folds without a unique violation', async () => {
		h.updateQueue = [[], [{ id: 'dep_1' }]]
		h.selectQueue = [[{ id: 'dep_1', covered: true }]]
		expect(await requeueClaimedDeploy('dep_1')).toBe('folded')
		expect(h.setArgs[1]).toMatchObject({ status: 'failed', failedStep: 'superseded' })
	})
	it('the sibling vanished before the re-read: tries the flip again', async () => {
		h.updateQueue = [[], [{ id: 'dep_1' }]]
		h.selectQueue = [[{ id: 'dep_1', covered: false }]]
		expect(await requeueClaimedDeploy('dep_1')).toBe('requeued')
		expect(h.updateCalls).toBe(2)
	})
	it('no cover after three tries: a plain flip requeues, never fails the row', async () => {
		h.updateQueue = [[], [], [], [{ id: 'dep_1' }]]
		h.selectQueue = [[{ id: 'dep_1', covered: false }], [{ id: 'dep_1', covered: false }], [{ id: 'dep_1', covered: false }]]
		expect(await requeueClaimedDeploy('dep_1')).toBe('requeued')
		expect(h.updateCalls).toBe(4)
		expect(h.setArgs.every((a) => (a as { status: string }).status === 'queued')).toBe(true)
	})
	it('no cover after three tries and the plain flip hits a new sibling: folds', async () => {
		h.updateQueue = [[], [], [], new DrizzleQueryError('update deploys', [], pgErr('23505')), [{ id: 'dep_1' }]]
		h.selectQueue = [[{ id: 'dep_1', covered: false }], [{ id: 'dep_1', covered: false }], [{ id: 'dep_1', covered: false }]]
		expect(await requeueClaimedDeploy('dep_1')).toBe('folded')
	})
	it('fallback: a 23505 from the flip still folds', async () => {
		h.updateQueue = [new DrizzleQueryError('update deploys', [], pgErr('23505')), [{ id: 'dep_1' }]]
		expect(await requeueClaimedDeploy('dep_1')).toBe('folded')
	})
})

describe('startDeploy fold on 23505 (fallback)', () => {
	it('folds into the queued row when the pg error is wrapped by drizzle', async () => {
		h.insertError = new DrizzleQueryError('insert into deploys', [], pgErr('23505'))
		const err = await startDeploy(opts).catch((e) => e)
		expect(err).toBeInstanceOf(DeployInFlightError)
		expect(err.coalesced).toBe(true)
		expect(h.updateCalls).toBe(1)
		expect(h.setArg).toEqual({ requestedSha: null })
	})
	it('plain in-flight (not coalesced) when no queued row was updated', async () => {
		h.insertError = new DrizzleQueryError('insert into deploys', [], pgErr('23505'))
		h.updated = []
		const err = await startDeploy(opts).catch((e) => e)
		expect(err).toBeInstanceOf(DeployInFlightError)
		expect(err.coalesced).toBeFalsy()
	})
	it('rethrows other errors without updating', async () => {
		h.insertError = new DrizzleQueryError('insert into deploys', [], pgErr('23503'))
		const err = await startDeploy(opts).catch((e) => e)
		expect(err).not.toBeInstanceOf(DeployInFlightError)
		expect(h.updateCalls).toBe(0)
	})
})

describe('startDeploy while the app is being deleted', () => {
	it('refuses a push instead of queueing it behind the delete', async () => {
		h.deleting = true
		const err = await startDeploy(opts).catch((e) => e)
		expect(err).toBeInstanceOf(AppBeingDeletedError)
		expect(h.inserts).toBe(0)
		const res = (await tryStartDeploy({ serverId: 'server-2', containerName: 'blog', kind: 'git_deploy' })) as Response
		expect(res.status).toBe(409)
		expect(await res.json()).toEqual({ error: 'app is being deleted' })
	})
	it('a delete row does not block the delete itself', async () => {
		h.deleting = true
		h.insertError = new Error('x')
		const err = await startDeploy({ serverId: 'server-2', containerName: 'blog', kind: 'delete' }).catch((e) => e)
		expect(err).not.toBeInstanceOf(AppBeingDeletedError)
		expect(h.inserts).toBe(1)
	})
})

describe('claimNextQueuedDeploy', () => {
	it('claims the candidate when the guarded flip updates it', async () => {
		h.selectQueue = [[{ id: 'dep_q' }]]
		h.updateQueue = [[{ id: 'dep_q', status: 'running' }]]
		expect(await claimNextQueuedDeploy()).toEqual({ id: 'dep_q', status: 'running' })
	})
	it('a running row appeared since the SELECT: guarded flip updates nothing, row stays queued', async () => {
		h.selectQueue = [[{ id: 'dep_q' }]]
		h.updateQueue = [[]]
		expect(await claimNextQueuedDeploy()).toBeNull()
	})
	it('fallback: a 23505 from the flip is "nothing claimable"', async () => {
		h.selectQueue = [[{ id: 'dep_q' }]]
		h.updateQueue = [new DrizzleQueryError('update deploys', [], pgErr('23505'))]
		expect(await claimNextQueuedDeploy()).toBeNull()
	})
	it('other errors still throw', async () => {
		h.selectQueue = [[{ id: 'dep_q' }]]
		h.updateQueue = [new DrizzleQueryError('update deploys', [], pgErr('40001'))]
		await expect(claimNextQueuedDeploy()).rejects.toBeInstanceOf(Error)
	})
})
