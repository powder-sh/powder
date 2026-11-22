// The build host disk card must be raised for a disk at real risk only. Replay
// of what one build host's prune reported (fixtures/build-host-disk-series.ts):
// the cache sat over its 30 GB soft cap in 12 of 13 samples while the root disk
// never passed 31%, and the card was raised 4 times in 4 days.
import { describe, expect, it } from 'vitest'
import { BUILDER_PRUNE_STALE_SEC, BUILDER_ROOT_PCT_WARN, type BuilderPruneResult, builderPruneVerdict } from '../builder-prune'
import { BUILD_HOST_DISK_RISK_EVENT, BUILD_HOST_DISK_SERIES, type DiskSample } from './fixtures/build-host-disk-series'

const CAP_MB = 30000
const result = (s: DiskSample): BuilderPruneResult => ({ cacheMb: s.cacheMb, capMb: CAP_MB, rootPct: s.rootPct, pruned: s.pruned, skip: s.skip, lastPruneAgeSec: s.lastPruneAgeSec, beforeMb: null, stuckPrunes: s.stuckPrunes })
const warnings = (series: DiskSample[], staleSec?: number) =>
	series.filter((s) => {
		const v = builderPruneVerdict(result(s), staleSec)
		return v.post && v.problem !== null
	})

describe('build host disk card: replay of the recorded series', () => {
	it('the series: over the soft cap almost always, the disk never near full', () => {
		expect(BUILD_HOST_DISK_SERIES.length).toBe(13)
		expect(BUILD_HOST_DISK_SERIES.filter((s) => s.cacheMb > CAP_MB).length).toBe(12)
		expect(Math.max(...BUILD_HOST_DISK_SERIES.map((s) => s.rootPct))).toBe(31)
	})

	it('before: the first rule (over the cap after a prune) warned 3 times, the 6h rule once more', () => {
		expect(BUILD_HOST_DISK_SERIES.filter((s) => s.pruned && s.cacheMb > CAP_MB).map((s) => s.at)).toEqual(['2026-11-15T19:13:48Z', '2026-11-15T21:20:03Z', '2026-11-15T21:45:28Z'])
		expect(warnings(BUILD_HOST_DISK_SERIES, 6 * 3600).map((s) => s.at)).toEqual(['2026-11-19T05:42:07Z'])
	})

	it('after: no card on the whole series', () => {
		expect(BUILDER_PRUNE_STALE_SEC).toBe(24 * 3600)
		expect(warnings(BUILD_HOST_DISK_SERIES)).toEqual([])
	})

	it('a prune skipped for 6h on a disk 16% full posts nothing (the log line carries it)', () => {
		const s = BUILD_HOST_DISK_SERIES.find((x) => x.at === '2026-11-19T05:42:07Z')
		expect(s && builderPruneVerdict(result(s))).toEqual({ post: false })
	})

	it('the real risk of the month still warns: 232 GB of cache, root disk about 82% full', () => {
		expect(warnings([BUILD_HOST_DISK_RISK_EVENT])).toEqual([BUILD_HOST_DISK_RISK_EVENT])
		expect(builderPruneVerdict(result(BUILD_HOST_DISK_RISK_EVENT))).toEqual({ post: true, afterPrune: false, problem: 'root disk 82% full' })
	})

	it('a disk that fills warns from the threshold on, whether the prune ran, was skipped or failed', () => {
		const base = BUILD_HOST_DISK_SERIES[5] as DiskSample
		for (const rootPct of [BUILDER_ROOT_PCT_WARN - 1, BUILDER_ROOT_PCT_WARN, 85, 96]) {
			for (const shape of [
				{ pruned: true, skip: null },
				{ pruned: false, skip: 'recent' as const },
				{ pruned: false, skip: 'busy' as const },
				{ pruned: false, skip: 'failed' as const },
			]) {
				const v = builderPruneVerdict(result({ ...base, ...shape, rootPct }))
				const warned = v.post && v.problem !== null
				expect(warned, `${rootPct}% ${JSON.stringify(shape)}`).toBe(rootPct >= BUILDER_ROOT_PCT_WARN)
			}
		}
	})

	it('a prune that has not run for a day warns, whatever the disk', () => {
		const base = BUILD_HOST_DISK_SERIES[3] as DiskSample
		expect(builderPruneVerdict(result({ ...base, lastPruneAgeSec: 24 * 3600 - 1 }))).toEqual({ post: false })
		expect(builderPruneVerdict(result({ ...base, lastPruneAgeSec: 24 * 3600 }))).toEqual({
			post: true,
			afterPrune: false,
			problem: 'the build cache has not been pruned for 24h because an image pull was in progress every time; cache 34 GB, cap 30 GB',
		})
	})
})
