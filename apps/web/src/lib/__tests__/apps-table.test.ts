import { describe, expect, it } from 'vitest'
import {
	type AppRow,
	countStatuses,
	deployDuration,
	deriveStatus,
	filterApps,
	fleetHeartbeat,
	parseStatusFilter,
	shortSha,
	sortApps,
} from '../apps-table'

const NOW = Date.parse('2026-11-01T12:00:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()

function app(
	over: Partial<AppRow> & { name?: string; deploy?: string | null; at?: number },
): AppRow {
	const { name = 'a', deploy = 'success', at = 10, ...rest } = over
	return {
		id: name,
		serverId: 's1',
		serverName: 'srv-one',
		containerName: name,
		repoUrl: `https://github.com/o/${name}`,
		branch: 'main',
		createdAt: iso(1000),
		domain: null,
		envCount: 0,
		lastDeploy: deploy
			? {
					id: `d-${name}`,
					status: deploy as 'success',
					kind: 'git_deploy',
					startedAt: iso(at),
					finishedAt: iso(at - 1),
					gitSha: 'abcdef123456',
					gitBranch: 'main',
				}
			: null,
		uptime: null,
		...rest,
	}
}

describe('deriveStatus', () => {
	it('running/queued deploy is deploying, even if site is down', () => {
		const up = { isUp: false, lastCheckedAt: iso(1), lastStatusCode: 502 }
		expect(deriveStatus(app({ deploy: 'running', uptime: up }), NOW)).toBe('deploying')
		expect(deriveStatus(app({ deploy: 'queued' }), NOW)).toBe('deploying')
	})
	it('fresh downtime beats a successful deploy', () => {
		const up = { isUp: false, lastCheckedAt: iso(5), lastStatusCode: 502 }
		expect(deriveStatus(app({ uptime: up }), NOW)).toBe('down')
	})
	it('stale downtime is ignored', () => {
		const up = { isUp: false, lastCheckedAt: iso(90), lastStatusCode: 502 }
		expect(deriveStatus(app({ uptime: up }), NOW)).toBe('live')
	})
	it('failed last deploy is failed', () => {
		expect(deriveStatus(app({ deploy: 'failed' }), NOW)).toBe('failed')
	})
	it('never deployed with no uptime is unknown; uptime up alone is live', () => {
		expect(deriveStatus(app({ deploy: null }), NOW)).toBe('unknown')
		const up = { isUp: true, lastCheckedAt: iso(1), lastStatusCode: 200 }
		expect(deriveStatus(app({ deploy: null, uptime: up }), NOW)).toBe('live')
	})
})

describe('countStatuses', () => {
	it('counts every app under exactly one of the six states', () => {
		const stopped = app({ name: 'e' })
		const failedStop = app({ name: 'f' })
		if (stopped.lastDeploy) stopped.lastDeploy.kind = 'stop'
		if (failedStop.lastDeploy) failedStop.lastDeploy = { ...failedStop.lastDeploy, kind: 'stop', status: 'failed' }
		const apps = [
			app({ name: 'a' }),
			app({ name: 'b', deploy: 'running' }),
			app({ name: 'c', deploy: 'failed' }),
			app({ name: 'd', deploy: null }),
			stopped,
			failedStop,
		]
		expect(countStatuses(apps, NOW)).toEqual({ live: 2, deploying: 1, failed: 1, down: 0, stopped: 1, unknown: 1 })
		expect(filterApps(apps, { status: 'stopped', server: '', q: '' }, NOW).map((a) => a.id)).toEqual(['e'])
	})
	it('apps on an unreachable server count as unknown, and the filter finds them', () => {
		const apps = [app({ name: 'a' }), app({ name: 'u', serverReachable: false })]
		expect(countStatuses(apps, NOW)).toEqual({ live: 1, deploying: 0, failed: 0, down: 0, stopped: 0, unknown: 1 })
		expect(parseStatusFilter('unknown')).toBe('unknown')
		const hit = filterApps(apps, { status: 'unknown', server: '', q: '' }, NOW)
		expect(hit.map((a) => a.id)).toEqual(['u'])
	})
})

describe('filterApps', () => {
	const apps = [
		app({ name: 'web', domain: 'web.example.com' }),
		app({ name: 'api', deploy: 'failed', serverId: 's2', serverName: 'srv-two' }),
		app({ name: 'job', deploy: 'running' }),
	]
	const base = { status: 'all' as const, server: '', q: '' }
	it('status filters', () => {
		expect(filterApps(apps, { ...base, status: 'failed' }, NOW).map((a) => a.id)).toEqual(['api'])
		expect(filterApps(apps, { ...base, status: 'deploying' }, NOW).map((a) => a.id)).toEqual([
			'job',
		])
		expect(filterApps(apps, { ...base, status: 'live' }, NOW).map((a) => a.id)).toEqual(['web'])
	})
	it('server and search combine', () => {
		expect(filterApps(apps, { ...base, server: 's2' }, NOW).map((a) => a.id)).toEqual(['api'])
		expect(filterApps(apps, { ...base, q: 'EXAMPLE.com' }, NOW).map((a) => a.id)).toEqual(['web'])
		expect(filterApps(apps, { ...base, server: 's2', q: 'web' }, NOW)).toEqual([])
	})
})

describe('sortApps', () => {
	it('failed first, then most recent deploy, never-deployed last', () => {
		const apps = [
			app({ name: 'old', at: 500 }),
			app({ name: 'new', at: 5 }),
			app({ name: 'bad-old', deploy: 'failed', at: 900 }),
			app({ name: 'bad-new', deploy: 'failed', at: 20 }),
			app({ name: 'never', deploy: null }),
		]
		expect(sortApps(apps, NOW).map((a) => a.id)).toEqual([
			'bad-new',
			'bad-old',
			'new',
			'old',
			'never',
		])
	})
	it('does not mutate its input', () => {
		const apps = [app({ name: 'b', at: 50 }), app({ name: 'a', at: 5 })]
		sortApps(apps, NOW)
		expect(apps[0]?.id).toBe('b')
	})
})

describe('helpers', () => {
	it('parseStatusFilter falls back to all', () => {
		expect(parseStatusFilter('failed')).toBe('failed')
		expect(parseStatusFilter('failing')).toBe('all')
		expect(parseStatusFilter('junk')).toBe('all')
		expect(parseStatusFilter(null)).toBe('all')
	})
	it('shortSha and deployDuration', () => {
		expect(shortSha('abcdef123456')).toBe('abcdef1')
		expect(shortSha(null)).toBeNull()
		expect(deployDuration({ startedAt: iso(10), finishedAt: null })).toBeNull()
		expect(deployDuration({ startedAt: iso(10), finishedAt: iso(9) })).toBe('1m 0s')
		expect(
			deployDuration({ startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:42Z' }),
		).toBe('42s')
	})
})

describe('fleetHeartbeat', () => {
	it('a stop or delete row is not the last deploy', () => {
		const stopped = app({ name: 's', at: 1, deploy: 'failed' })
		if (stopped.lastDeploy) stopped.lastDeploy.kind = 'stop'
		const h = fleetHeartbeat([app({ name: 'a', at: 30 }), stopped], NOW)
		expect(h.last).toEqual({ app: 'a', status: 'success', startedAt: iso(30) })
	})
	it('counts fresh up/down checks, treats stale or missing checks as unchecked, finds the latest deploy', () => {
		const h = fleetHeartbeat(
			[
				app({
					name: 'a',
					at: 30,
					uptime: { isUp: true, lastCheckedAt: iso(2), lastStatusCode: 200 },
				}),
				app({
					name: 'b',
					at: 5,
					uptime: { isUp: false, lastCheckedAt: iso(3), lastStatusCode: 502 },
				}),
				app({
					name: 'c',
					at: 50,
					uptime: { isUp: false, lastCheckedAt: iso(120), lastStatusCode: 502 },
				}),
				app({ name: 'd', deploy: null }),
			],
			NOW,
		)
		expect(h).toMatchObject({ up: 1, down: 1, unchecked: 2 })
		expect(h.last).toEqual({ app: 'b', status: 'success', startedAt: iso(5) })
		expect(fleetHeartbeat([], NOW)).toEqual({ up: 0, down: 0, unchecked: 0, last: null })
	})
})
