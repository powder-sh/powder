import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_HEALTH, APP_STATE, APP_STATES, appHealth } from '../app-health'
import { appRowHealth, countStatuses, parseStatusFilter } from '../apps-table'
import { deployKindBadge, deployKindLabel, deployStatus, triggeredByLabel } from '../deploy-status'

const NOW = 1_700_000_000_000
const fresh = new Date(NOW - 60_000).toISOString()
const stale = new Date(NOW - 2 * 3_600_000).toISOString()

describe('deploy status vocabulary', () => {
	it('maps every stored status to one label', () => {
		expect(deployStatus('queued').label).toBe('queued')
		expect(deployStatus('running').label).toBe('building')
		expect(deployStatus('success').label).toBe('ready')
		expect(deployStatus('failed').label).toBe('failed')
		expect(deployStatus('failed').tone).toBe('destructive')
		expect(deployStatus('weird').tone).toBe('neutral')
	})
	it('kinds read as words; a plain git deploy needs no badge', () => {
		expect(deployKindLabel('git_deploy')).toBe('deploy')
		expect(deployKindLabel('env_change')).toBe('env change')
		expect(deployKindBadge('git_deploy')).toBeNull()
		expect(deployKindBadge('rollback')).toBe('rollback')
	})
	it('triggered_by reads as how · who', () => {
		expect(triggeredByLabel('webhook:octo-dev')).toBe('push · octo-dev')
		expect(triggeredByLabel('push:octo-dev')).toBe('push · octo-dev')
		expect(triggeredByLabel('manual:alex@example.com')).toBe('manual · alex@example.com')
		expect(triggeredByLabel('alex@example.com')).toBe('manual · alex@example.com')
		expect(triggeredByLabel('reconcile')).toBe('reconcile')
		expect(triggeredByLabel(null)).toBeNull()
	})
})

describe('app health', () => {
	const ok = { status: 'success' }
	const lastRow = { id: 'd1', status: 'success' as const, kind: 'git_deploy', startedAt: fresh, finishedAt: fresh, gitSha: null, gitBranch: null }
	it('a deploy in flight wins', () => {
		expect(appHealth({ lastDeploy: { status: 'running' }, uptime: null }, NOW)).toBe('deploying')
		expect(appHealth({ lastDeploy: { status: 'queued' }, uptime: null }, NOW)).toBe('queued')
	})
	it('an unreachable server is unknown, not running and not missing', () => {
		expect(appHealth({ lastDeploy: ok, uptime: null, serverReachable: false }, NOW)).toBe(
			'unreachable',
		)
		expect(APP_HEALTH.unreachable.label).toBe('unknown · server unreachable')
		// Whatever the last uptime check said: every app on that server reads the same.
		for (const isUp of [true, false])
			expect(
				appHealth(
					{ lastDeploy: ok, uptime: { isUp, lastCheckedAt: fresh }, serverReachable: false },
					NOW,
				),
			).toBe('unreachable')
	})
	it('a missing container after a good deploy is down; before any, not deployed', () => {
		expect(appHealth({ lastDeploy: ok, uptime: null, containerMissing: true }, NOW)).toBe('down')
		expect(appHealth({ lastDeploy: null, uptime: null, containerMissing: true }, NOW)).toBe(
			'not_deployed',
		)
	})
	it('fresh downtime is down; stale downtime is ignored', () => {
		expect(appHealth({ lastDeploy: ok, uptime: { isUp: false, lastCheckedAt: fresh } }, NOW)).toBe(
			'down',
		)
		expect(appHealth({ lastDeploy: ok, uptime: { isUp: false, lastCheckedAt: stale } }, NOW)).toBe(
			'live',
		)
	})
	it('a failed last deploy reads as failed', () => {
		expect(appHealth({ lastDeploy: { status: 'failed' }, uptime: null }, NOW)).toBe('deploy_failed')
		expect(APP_HEALTH.deploy_failed.label).toBe('failed')
	})
	it('a stopped app reads stopped, never live', () => {
		const stop = { status: 'success', kind: 'stop' }
		const up = { isUp: true, lastCheckedAt: fresh }
		// The apps list: no container state, the newest row decides.
		expect(appHealth({ lastDeploy: stop, uptime: null }, NOW)).toBe('stopped')
		expect(appHealth({ lastDeploy: stop, uptime: up }, NOW)).toBe('stopped')
		expect(appHealth({ lastDeploy: stop, uptime: { isUp: false, lastCheckedAt: fresh } }, NOW)).toBe('stopped')
		expect(appRowHealth({ lastDeploy: { ...lastRow, kind: 'stop', status: 'success' }, uptime: null })).toBe('stopped')
		expect(APP_HEALTH.stopped.label).toBe('stopped')
		// The app page: the container state decides when it is known.
		expect(appHealth({ lastDeploy: stop, uptime: null, containerStatus: 'exited' }, NOW)).toBe('stopped')
		expect(appHealth({ lastDeploy: stop, uptime: null, containerStatus: 'running' }, NOW)).toBe('live')
		expect(appHealth({ lastDeploy: stop, uptime: null, containerMissing: true }, NOW)).toBe('down')
		expect(appHealth({ lastDeploy: stop, uptime: null, dockerFailed: true }, NOW)).toBe('stopped')
		// An exited container without a stop crashed: down, not stopped, not live.
		expect(appHealth({ lastDeploy: ok, uptime: null, containerStatus: 'exited' }, NOW)).toBe('down')
		expect(appHealth({ lastDeploy: ok, uptime: null, containerStatus: 'running' }, NOW)).toBe('live')
		// A stop in flight is still in flight.
		expect(appHealth({ lastDeploy: { status: 'running', kind: 'stop' }, uptime: null }, NOW)).toBe('deploying')
	})
	it('a failed stop or delete is not a failed deploy: the app still runs', () => {
		for (const kind of ['stop', 'delete']) {
			const d = { status: 'failed', kind }
			expect(appHealth({ lastDeploy: d, uptime: null }, NOW)).toBe('live')
			expect(appHealth({ lastDeploy: d, uptime: null, containerStatus: 'running' }, NOW)).toBe('live')
			expect(appHealth({ lastDeploy: d, uptime: { isUp: false, lastCheckedAt: fresh } }, NOW)).toBe('down')
		}
		expect(appHealth({ lastDeploy: { status: 'failed', kind: 'git_deploy' }, uptime: null }, NOW)).toBe('deploy_failed')
	})
	it('six app states; every detailed label starts with its state word', () => {
		expect(APP_STATES).toEqual(['live', 'deploying', 'failed', 'down', 'stopped', 'unknown'])
		for (const m of Object.values(APP_HEALTH)) {
			expect(APP_STATES).toContain(m.state)
			expect(m.label === APP_STATE[m.state].label || m.label.startsWith(`${APP_STATE[m.state].label} · `)).toBe(true)
			expect(m.tone).toBe(APP_STATE[m.state].tone)
		}
	})
	it('counters and filters are keyed by the same six words', () => {
		expect(Object.keys(countStatuses([], NOW)).sort()).toEqual([...APP_STATES].sort())
		for (const s of APP_STATES) expect(parseStatusFilter(s)).toBe(s)
		for (const old of ['failing', 'healthy', 'running']) expect(parseStatusFilter(old)).toBe('all')
	})
})

// Guard: the labels live in lib/deploy-status.ts and lib/app-health.ts only. A page
// that renders a stored status raw or keeps its own label map fails here.
describe('no second copy of the status vocabulary', () => {
	const root = join(__dirname, '..', '..')
	const files: string[] = []
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name)
			if (statSync(p).isDirectory()) walk(p)
			else if (/\.tsx?$/.test(name)) files.push(p)
		}
	}
	walk(join(root, 'app'))
	walk(join(root, 'components'))

	const banned: [RegExp, string][] = [
		[/label:\s*'(ready|error|building|deploy failed)'/, 'local deploy status label map'],
		[/(^|>)\s*\{(d|deploy|dep)\.status\}\s*(<|$)/, 'deploy status rendered raw'],
		[/\{(d|deploy|dep)\.status\.replace\(/, 'deploy status rendered raw'],
		[/>(success|ready|building|error)<\/Badge>/, 'deploy status badge with its own label'],
		[/\.kind\.replace\(/, 'deploy kind rendered raw'],
		[
			/'container doesn't exist on the server yet'|no container on the server\./,
			'SSH failure shown as a missing container',
		],
		[/statusText\(|STATUS_META\b|STATUS_TONE\b/, 'local status helper'],
		[/label="(failing|healthy)"|'failing'/, 'app state word outside lib/app-health.ts'],
	]
	// Server rows have their own status (connected/unreachable) on a page outside this rule.
	const allowed = new Set([
		'app/(dashboard)/servers/[id]/page.tsx',
		'app/(dashboard)/servers/[id]/[name]/page.tsx',
	])

	// The apps page's counter strip and filters render APP_STATE labels only:
	// no hand-written state words, so a counter cannot say one thing and a row another.
	it('the apps counter strip and filters read the shared states', () => {
		const page = readFileSync(join(root, 'app', '(dashboard)', 'projects', 'page.tsx'), 'utf8')
		expect(page).toMatch(/APP_STATES\.map\(/)
		expect(page).toMatch(/APP_STATE\[/)
		const words = /(label=|label:\s*)['"`{]*\s*['"`](failing|healthy|running|stopped|deploying|live|failed|down|unknown)['"`]/
		const hits = page.split('\n').filter((l) => words.test(l))
		expect(hits).toEqual([])
		expect(page).not.toMatch(/['"](failing|healthy)['"]/)
	})
	it('a streaming log never says live', () => {
		for (const f of ['app/(dashboard)/deploys/[id]/page.tsx', 'components/live-logs-card.tsx']) {
			const src = readFileSync(join(root, f), 'utf8')
			expect(src, f).toMatch(/streaming/)
			expect(src, f).not.toMatch(/['"]live['"]|>\s*live\s*</)
		}
	})

	it('every page reads labels from the shared modules', () => {
		const hits: string[] = []
		for (const f of files) {
			const rel = relative(root, f)
			if (allowed.has(rel)) continue
			const lines = readFileSync(f, 'utf8').split('\n')
			lines.forEach((line, i) => {
				for (const [re, why] of banned)
					if (re.test(line)) hits.push(`${rel}:${i + 1} ${why}: ${line.trim()}`)
			})
		}
		expect(hits).toEqual([])
	})
})
