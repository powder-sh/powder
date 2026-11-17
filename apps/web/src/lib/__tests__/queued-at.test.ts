import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
	inserted: undefined as Record<string, unknown> | undefined,
	orderBy: undefined as unknown,
	set: undefined as Record<string, unknown> | undefined,
}))

vi.mock('../db', () => {
	const chain = (result: () => unknown) => {
		const c: Record<string, unknown> = {}
		for (const m of ['from', 'where', 'limit', 'returning', 'for', 'onConflictDoNothing']) c[m] = () => c
		c.values = (v: Record<string, unknown>) => {
			h.inserted = v
			return c
		}
		c.set = (v: Record<string, unknown>) => {
			h.set = v
			return c
		}
		c.orderBy = (o: unknown) => {
			h.orderBy = o
			return c
		}
		c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
			Promise.resolve(result()).then(res, rej)
		return c
	}
	const tx = {
		select: () => chain(() => [{ id: 'dep_1' }]),
		update: () => chain(() => [{ id: 'dep_1', status: 'running' }]),
	}
	const id = (x: unknown) => x
	return {
		db: {
			insert: () => chain(() => [{ id: 'dep_x' }]),
			select: () => chain(() => []),
			transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
		},
		deploys: { queuedAt: 'COL_QUEUED_AT', startedAt: 'COL_STARTED_AT' },
		and: id, appDomains: {}, appRepos: {}, asc: (c: unknown) => ({ asc: c }), createId: () => 'dep_x',
		desc: id, eq: id, isNull: id, notInArray: id, prefixes: { deploy: 'dep' }, sql: Object.assign((x: unknown) => x, { raw: id }),
	}
})
vi.mock('../ssh', () => ({}))
vi.mock('../deploy-queue', () => ({}))

import { claimNextQueuedDeploy, startDeploy } from '../deploys'

beforeEach(() => {
	h.inserted = undefined
	h.orderBy = undefined
	h.set = undefined
})

describe('queued_at', () => {
	it('startDeploy sets queuedAt at insert', async () => {
		await startDeploy({ serverId: 's', containerName: 'c', kind: 'git_deploy', inline: true })
		expect(h.inserted?.queuedAt).toBeInstanceOf(Date)
	})

	it('claim keeps queuedAt (only status + startedAt change)', async () => {
		await claimNextQueuedDeploy()
		expect(Object.keys(h.set ?? {}).sort()).toEqual(['startedAt', 'status'])
		expect(h.set).not.toHaveProperty('queuedAt')
	})

	it('claim orders by queuedAt ascending', async () => {
		await claimNextQueuedDeploy()
		expect(h.orderBy).toEqual({ asc: 'COL_QUEUED_AT' })
	})
})
