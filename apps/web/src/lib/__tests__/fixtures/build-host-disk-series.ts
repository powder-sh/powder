// What one build host's cap prune reported over the card's first days (a
// 301 GB root disk, cap 30 GB), plus the one time in the same month its disk
// was at real risk. `source` says where each sample was recorded. No full
// series is kept anywhere: the prune's log lines live in the worker's container
// log, which starts over at every release.
//
// `rootPct` marked estimated was not recorded with the sample; it is taken from
// the samples that carry both numbers (root % = 5 + cache GB / 3, within 4 points
// on every recorded pair below).

export interface DiskSample {
	at: string
	source: 'card' | 'worker-log' | 'host-cron-note'
	cacheMb: number
	rootPct: number
	rootEstimated?: true
	pruned: boolean
	skip: 'locked' | 'busy' | 'failed' | 'recent' | null
	lastPruneAgeSec: number
	stuckPrunes: number
}

/** The card's whole life: 13 samples, cache 6 to 70 GB, root disk 7 to 31%. */
export const BUILD_HOST_DISK_SERIES: DiskSample[] = [
	// three cards of the first rule ("over the cap after the prune")
	{ at: '2026-11-15T19:13:48Z', source: 'card', cacheMb: 65000, rootPct: 27, rootEstimated: true, pruned: true, skip: null, lastPruneAgeSec: 0, stuckPrunes: 0 },
	{ at: '2026-11-15T21:20:03Z', source: 'card', cacheMb: 70000, rootPct: 28, rootEstimated: true, pruned: true, skip: null, lastPruneAgeSec: 0, stuckPrunes: 1 },
	// root % of this prune: the marker line kept in builder-cap-prune-report.test.ts
	{ at: '2026-11-15T21:45:28Z', source: 'card', cacheMb: 62890, rootPct: 29, pruned: true, skip: null, lastPruneAgeSec: 0, stuckPrunes: 0 },
	// the card of the 6h rule: every prune for 6h met an image pull (the card says 6h: an age of 6h to 7h)
	{ at: '2026-11-19T05:42:07Z', source: 'card', cacheMb: 34000, rootPct: 16, rootEstimated: true, pruned: false, skip: 'busy', lastPruneAgeSec: 6 * 3600 + 600, stuckPrunes: 0 },
	// the prune that closed it
	{ at: '2026-11-19T06:57:38Z', source: 'card', cacheMb: 6000, rootPct: 7, pruned: true, skip: null, lastPruneAgeSec: 0, stuckPrunes: 0 },
	// 24 minutes of a busy evening, as logged
	{ at: '2026-11-19T19:54:55Z', source: 'worker-log', cacheMb: 33090, rootPct: 16, pruned: false, skip: 'recent', lastPruneAgeSec: 1431, stuckPrunes: 0 },
	{ at: '2026-11-19T19:56:05Z', source: 'worker-log', cacheMb: 36430, rootPct: 17, pruned: false, skip: 'recent', lastPruneAgeSec: 1501, stuckPrunes: 0 },
	{ at: '2026-11-19T20:01:41Z', source: 'worker-log', cacheMb: 49130, rootPct: 22, pruned: false, skip: 'recent', lastPruneAgeSec: 1837, stuckPrunes: 0 },
	{ at: '2026-11-19T20:04:55Z', source: 'worker-log', cacheMb: 53990, rootPct: 24, pruned: false, skip: 'recent', lastPruneAgeSec: 2031, stuckPrunes: 0 },
	{ at: '2026-11-19T20:05:26Z', source: 'worker-log', cacheMb: 55160, rootPct: 24, pruned: false, skip: 'recent', lastPruneAgeSec: 2062, stuckPrunes: 0 },
	{ at: '2026-11-19T20:13:59Z', source: 'worker-log', cacheMb: 67450, rootPct: 31, pruned: false, skip: 'recent', lastPruneAgeSec: 2575, stuckPrunes: 0 },
	{ at: '2026-11-19T20:16:07Z', source: 'worker-log', cacheMb: 67450, rootPct: 29, pruned: false, skip: 'recent', lastPruneAgeSec: 2703, stuckPrunes: 0 },
	{ at: '2026-11-19T20:18:24Z', source: 'worker-log', cacheMb: 67450, rootPct: 27, pruned: false, skip: 'recent', lastPruneAgeSec: 2840, stuckPrunes: 0 },
]

/** The real risk of the month, before powder pruned build hosts at all: two
 *  days of deploys left 232 GB of build cache on the 301 GB disk (the note on
 *  the host's own prune cron). No build failed on a full disk. */
export const BUILD_HOST_DISK_RISK_EVENT: DiskSample = {
	at: '2026-10-28T00:00:00Z',
	source: 'host-cron-note',
	cacheMb: 232000,
	rootPct: 82,
	rootEstimated: true,
	pruned: false,
	skip: 'recent',
	lastPruneAgeSec: 1800,
	stuckPrunes: 0,
}
