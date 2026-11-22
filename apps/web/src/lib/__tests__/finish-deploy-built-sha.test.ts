import { beforeEach, describe, expect, it, vi } from 'vitest'

// built_sha (0070) is written on its own, after the result is committed: if the column were
// missing (a deferred migration), the deploy's result must still be recorded, and the
// watchdog's reap must not name the column at all.
const H = vi.hoisted(() => ({
	sets: [] as Record<string, unknown>[],
	missingColumn: true,
	hangBuiltSha: false,
	release: null as (() => void) | null,
}))

const missing = () =>
	Object.assign(new Error('column "built_sha" of relation "deploys" does not exist'), { code: '42703' })

vi.mock('../db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const update = () => {
		let values: Record<string, unknown> = {}
		const c = {
			set: (v: Record<string, unknown>) => {
				values = v
				H.sets.push(v)
				return c
			},
			where: () => c,
			returning: async () => {
				if (H.missingColumn && 'builtSha' in values) throw missing()
				return [{ id: 'dep_1' }]
			},
			// awaited without returning(): the built_sha statement
			then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => {
				if (H.hangBuiltSha && 'builtSha' in values) {
					// a slow database: settles only when the test releases it
					H.release = () => ok(undefined)
					return
				}
				return H.missingColumn && 'builtSha' in values ? fail(missing()) : ok(undefined)
			},
		}
		return c
	}
	return { ...real, db: { update } }
})

import { finishDeploy, settleBuiltShaWrites } from '../deploys'
import { reapedColumns } from '../deploy-watchdog'

beforeEach(() => {
	H.sets = []
	H.missingColumn = true
	vi.restoreAllMocks()
	vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the built commit never costs a deploy its result', () => {
	it('column missing: the result is written, the built sha write fails alone and is logged', async () => {
		const r = await finishDeploy('dep_1', { status: 'failed', error: 'boom', builtSha: 'b'.repeat(40) })
		expect(r).toBe('written')
		await settleBuiltShaWrites()
		expect(H.sets[0]).toMatchObject({ status: 'failed' })
		expect(H.sets[0]).not.toHaveProperty('builtSha')
		expect(H.sets[1]).toEqual({ builtSha: 'b'.repeat(40) })
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('built commit not recorded'), expect.stringContaining('does not exist'))
	})
	it('a success is recorded the same way', async () => {
		await expect(finishDeploy('dep_1', { status: 'success', gitSha: 'a'.repeat(40), builtSha: 'a'.repeat(40) })).resolves.toBe('written')
		expect(H.sets[0]).toMatchObject({ status: 'success', gitSha: 'a'.repeat(40) })
	})
	it('column present: both statements run', async () => {
		H.missingColumn = false
		await finishDeploy('dep_1', { status: 'failed', error: 'boom', builtSha: 'c'.repeat(40) })
		await settleBuiltShaWrites()
		expect(H.sets).toHaveLength(2)
		expect(console.error).not.toHaveBeenCalled()
	})
	it('the result does not wait for the built_sha write', async () => {
		H.missingColumn = false
		H.hangBuiltSha = true
		const r = await finishDeploy('dep_1', { status: 'failed', error: 'boom', builtSha: 'd'.repeat(40) })
		expect(r).toBe('written')
		H.release?.()
		await settleBuiltShaWrites()
		H.hangBuiltSha = false
	})
	it('the watchdog reap does not name built_sha', () => {
		expect(Object.keys(reapedColumns())).not.toContain('builtSha')
	})
})
