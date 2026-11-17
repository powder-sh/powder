import { beforeEach, describe, expect, it, vi } from 'vitest'

let stdout = ''
const reports: { host: string; overCap: string | null }[] = []

vi.mock('../ssh', async () => {
	const actual = await vi.importActual<typeof import('../ssh')>('../ssh')
	return { ...actual, runCommand: vi.fn(async () => ({ code: 0, stdout, stderr: '' })) }
})
vi.mock('../hq', async () => {
	const actual = await vi.importActual<typeof import('../hq')>('../hq')
	return {
		...actual,
		reportBuildHostDiskToHq: vi.fn(async (host: string, overCap: string | null) => {
			reports.push({ host, overCap })
		}),
	}
})

import { capPruneBuildHost } from '../builder'

const builder = { id: 'builder:5.6.7.8', name: 'powder-builder', host: '5.6.7.8', port: 22 } as never

beforeEach(() => {
	reports.length = 0
})

describe('build host cap prune report', () => {
	it('posts nothing when the cache size could not be read', async () => {
		stdout = 'POWDER_BUILDER_PRUNE cache_mb=-1 cap_mb=30000 root_pct=60\n'
		await capPruneBuildHost(builder, '5.6.7.8')
		stdout = 'POWDER_BUILDER_PRUNE cache_mb=-1 cap_mb=30000 root_pct=95\n'
		await capPruneBuildHost(builder, '5.6.7.8')
		expect(reports).toEqual([])
	})
	it('posts nothing when the prune was skipped (no marker)', async () => {
		stdout = '[builder-prune] another prune is running, skipped\n'
		await capPruneBuildHost(builder, '5.6.7.8')
		expect(reports).toEqual([])
	})
	it('resolves under the cap and over the soft cap after a prune that shrank it; warns on real risk', async () => {
		stdout = 'POWDER_BUILDER_PRUNE cache_mb=20000 cap_mb=30000 root_pct=60\n'
		await capPruneBuildHost(builder, '5.6.7.8')
		// pruned 72.2 -> 62.9 GB, cap 30 GB, root 29%: healthy.
		stdout = 'POWDER_BUILDER_PRUNE cache_mb=62890 cap_mb=30000 root_pct=29 pruned=1 skip=none last_prune_age_s=0 before_mb=72160 stuck=0\n'
		await capPruneBuildHost(builder, '5.6.7.8')
		// the third prune in a row that left more than the one before.
		stdout = 'POWDER_BUILDER_PRUNE cache_mb=140000 cap_mb=30000 root_pct=55 pruned=1 skip=none last_prune_age_s=0 before_mb=135000 stuck=3\n'
		await capPruneBuildHost(builder, '5.6.7.8')
		stdout = 'POWDER_BUILDER_PRUNE cache_mb=62890 cap_mb=30000 root_pct=86 pruned=1 skip=none last_prune_age_s=0 before_mb=72160 stuck=0\n'
		await capPruneBuildHost(builder, '5.6.7.8')
		expect(reports).toEqual([
			{ host: '5.6.7.8', overCap: null },
			{ host: '5.6.7.8', overCap: null },
			{ host: '5.6.7.8', overCap: 'build cache 140 GB over the 30 GB cap and larger after each of 3 prunes in a row' },
			{ host: '5.6.7.8', overCap: 'root disk 86% full' },
		])
	})
	it('an unwritable growth streak file is logged once per host and path', async () => {
		const logs: string[] = []
		const spy = vi.spyOn(console, 'log').mockImplementation((m: string) => {
			logs.push(m)
		})
		try {
			stdout = '[builder-prune] /x/builder-prune.stuck is not writable: the cache growth streak is not kept\nPOWDER_BUILDER_PRUNE cache_mb=20000 cap_mb=30000 root_pct=60\n'
			await capPruneBuildHost(builder, '9.9.9.9')
			await capPruneBuildHost(builder, '9.9.9.9')
		} finally {
			spy.mockRestore()
		}
		expect(logs.filter((l) => l.includes('growth streak is not kept'))).toHaveLength(1)
	})
})
