import { describe, expect, it } from 'vitest'
import {
	DEPLOY_DAYS,
	bucketDeployDays,
	dayCounts,
	dayLabel,
	dayTitle,
	dayTone,
	emptyDays,
	sumDeployDays,
	summarizeDays,
} from '../deploy-days'

const NOW = Date.parse('2026-11-04T09:30:00Z')

describe('deploy days (strip data from the deploys table)', () => {
	it('emptyDays is a fixed window of UTC days ending today, oldest first', () => {
		const d = emptyDays(NOW)
		expect(d).toHaveLength(DEPLOY_DAYS)
		expect(d[0].day).toBe('2026-10-06')
		expect(d.at(-1)?.day).toBe('2026-11-04')
		expect(d.every((x) => x.ok === 0 && x.failed === 0)).toBe(true)
	})

	it('buckets per app key, keeps the window length, drops days outside it', () => {
		const m = bucketDeployDays(
			[
				{ server_id: 's1', container_name: 'blog', day: '2026-11-04', ok: 2, failed: 1 },
				{ server_id: 's1', container_name: 'blog', day: '2026-11-01', ok: '3', failed: '0' },
				{ server_id: 's1', container_name: 'blog', day: '2026-09-01', ok: 9, failed: 9 },
				{
					server_id: 's2',
					container_name: 'blog',
					day: new Date('2026-10-06T00:00:00Z'),
					ok: 0,
					failed: 1,
				},
			],
			NOW,
		)
		const blog = m.get('s1|blog')
		expect(blog).toHaveLength(DEPLOY_DAYS)
		expect(blog?.at(-1)).toEqual({ day: '2026-11-04', ok: 2, failed: 1 })
		expect(blog?.at(-4)).toEqual({ day: '2026-11-01', ok: 3, failed: 0 })
		expect(summarizeDays(blog ?? [])).toEqual({ ok: 5, failed: 1, activeDays: 2 })
		// Same container name on another server is a different app.
		expect(m.get('s2|blog')?.[0]).toEqual({ day: '2026-10-06', ok: 0, failed: 1 })
		expect(m.has('s3|x')).toBe(false)
	})

	it('sums series day by day for the fleet strip', () => {
		const m = bucketDeployDays(
			[
				{ server_id: 'a', container_name: 'x', day: '2026-11-04', ok: 1, failed: 0 },
				{ server_id: 'b', container_name: 'y', day: '2026-11-04', ok: 2, failed: 3 },
			],
			NOW,
		)
		const fleet = sumDeployDays([...m.values()], NOW)
		expect(fleet.at(-1)).toEqual({ day: '2026-11-04', ok: 3, failed: 3 })
		expect(sumDeployDays([], NOW)).toHaveLength(DEPLOY_DAYS)
	})

	it('tones and labels say what is on record, nothing more', () => {
		expect(dayTone({ ok: 0, failed: 0 })).toBe('none')
		expect(dayTone({ ok: 2, failed: 0 })).toBe('ok')
		expect(dayTone({ ok: 0, failed: 1 })).toBe('failed')
		expect(dayTone({ ok: 1, failed: 1 })).toBe('mixed')
		expect(dayLabel({ day: '2026-11-03', ok: 2, failed: 1 })).toBe(
			'Tue 3 Nov 2026 (UTC): 2 ok, 1 failed',
		)
		expect(dayLabel({ day: '2026-11-03', ok: 0, failed: 0 })).toBe('Tue 3 Nov 2026 (UTC): no deploys')
	})

	it('the tooltip title is the weekday and full UTC date, whatever the local zone', () => {
		expect(dayTitle({ day: '2026-11-20' })).toBe('Fri 20 Nov 2026 (UTC)')
		expect(dayTitle({ day: '2026-01-01' })).toBe('Thu 1 Jan 2026 (UTC)')
		expect(dayTitle({ day: '2025-12-31' })).toBe('Wed 31 Dec 2025 (UTC)')
		// A day bucketed from a Date keeps its UTC calendar day.
		const [d] = bucketDeployDays(
			[{ server_id: 's', container_name: 'a', day: new Date('2026-11-04T23:30:00Z'), ok: 1, failed: 0 }],
			NOW,
		).get('s|a')?.slice(-1) ?? []
		expect(d && dayTitle(d)).toBe('Wed 4 Nov 2026 (UTC)')
		expect(dayTitle({ day: 'garbage' })).toBe('garbage (UTC)')
	})

	it('the tooltip counts name ok and failed, or say no deploys', () => {
		expect(dayCounts({ ok: 3, failed: 1 })).toBe('3 ok, 1 failed')
		expect(dayCounts({ ok: 3, failed: 0 })).toBe('3 ok')
		expect(dayCounts({ ok: 0, failed: 2 })).toBe('2 failed')
		expect(dayCounts({ ok: 0, failed: 0 })).toBe('no deploys')
	})
})
