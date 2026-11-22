// Which GitHub Actions runs count (lib/ci-runs.ts): only active workflows, and a run on
// an older commit than the deployed one never drives a failure. Invented ids only.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { activeWorkflowIds, ciRunsVerdict, isRepoWorkflow, isRunNotDeployed } from '../ci-runs'

const run = (
	id: number,
	workflow_id: number,
	head_sha: string,
	conclusion: string | null,
	created_at: string,
) => ({
	id,
	workflow_id,
	head_sha,
	status: conclusion === null ? 'in_progress' : 'completed',
	conclusion,
	created_at,
})

// the deployed commit bbb: its deploy was queued 12:00 and finished about four minutes later
const deployed = { sha: 'bbb', queuedAt: '2026-03-10T12:00:00Z' }

describe('activeWorkflowIds', () => {
	it('keeps only state active', () => {
		const ids = activeWorkflowIds([
			{ id: 1, state: 'active', path: '.github/workflows/w1.yml' },
			{ id: 2, state: 'deleted', path: '.github/workflows/w2.yml' },
			{ id: 3, state: 'disabled_manually', path: '.github/workflows/w3.yml' },
			{ id: 4, state: 'disabled_inactivity', path: '.github/workflows/w4.yml' },
		])
		expect([...ids]).toEqual([1])
	})
})

describe('isRepoWorkflow', () => {
	it("a file under .github/workflows/ is the repo's own; GitHub-managed dynamic ones are not", () => {
		expect(isRepoWorkflow({ path: '.github/workflows/test.yml' })).toBe(true)
		expect(isRepoWorkflow({ path: '.github/workflows/build.yaml' })).toBe(true)
		expect(isRepoWorkflow({ path: 'dynamic/dependabot/dependabot-updates' })).toBe(false)
		expect(isRepoWorkflow({ path: 'dynamic/pages/pages-build-deployment' })).toBe(false)
		expect(isRepoWorkflow({ path: 'dynamic/github-code-scanning/codeql' })).toBe(false)
		expect(isRepoWorkflow({ path: '.github/workflows/sub/x.yml' })).toBe(false)
		expect(isRepoWorkflow({ path: '' })).toBe(false)
	})
})

describe('isRunNotDeployed (not the deployed commit)', () => {
	it('another commit created before the deploy was queued is not the deployed commit', () => {
		expect(
			isRunNotDeployed({ head_sha: 'aaa', created_at: '2026-03-10T11:00:00Z' }, deployed),
		).toBe(true)
	})
	it('the deployed commit is current, however old the run', () => {
		expect(
			isRunNotDeployed({ head_sha: 'bbb', created_at: '2026-03-01T00:00:00Z' }, deployed),
		).toBe(false)
	})
	it('a push that lands while the deploy runs is newer: current', () => {
		// created 12:02, after the deploy of bbb started and before it finished
		expect(
			isRunNotDeployed({ head_sha: 'ccc', created_at: '2026-03-10T12:02:00Z' }, deployed),
		).toBe(false)
	})
	it('after a rollback to an older commit, runs of the rolled-back newer commit are not the deployed commit', () => {
		const rolledBackTo = { sha: 'aaa', queuedAt: '2026-03-11T09:00:00Z' }
		expect(
			isRunNotDeployed({ head_sha: 'bbb', created_at: '2026-03-10T11:50:00Z' }, rolledBackTo),
		).toBe(true)
		expect(
			isRunNotDeployed({ head_sha: 'aaa', created_at: '2026-03-01T00:00:00Z' }, rolledBackTo),
		).toBe(false)
	})
	it('a run created after the deploy (a newer push) is current', () => {
		expect(
			isRunNotDeployed({ head_sha: 'ccc', created_at: '2026-03-10T12:30:00Z' }, deployed),
		).toBe(false)
	})
	it('nothing deployed, or no queue time: current', () => {
		expect(isRunNotDeployed({ head_sha: 'aaa', created_at: '2026-03-10T11:00:00Z' }, null)).toBe(
			false,
		)
		expect(
			isRunNotDeployed(
				{ head_sha: 'aaa', created_at: '2026-03-10T11:00:00Z' },
				{ sha: 'bbb', queuedAt: null },
			),
		).toBe(false)
		expect(isRunNotDeployed({ head_sha: 'aaa', created_at: 'garbage' }, deployed)).toBe(false)
	})
})

describe('ciRunsVerdict', () => {
	it('a repo whose only workflow was deleted shows no runs and nothing failing', () => {
		const runs = [
			run(10, 7, 'aaa', 'failure', '2026-03-01T00:00:00Z'),
			run(9, 7, 'aaa', 'failure', '2026-02-28T00:00:00Z'),
		]
		const v = ciRunsVerdict(
			runs,
			[{ id: 7, state: 'deleted', path: '.github/workflows/w7.yml' }],
			deployed,
		)
		expect(v.workflows).toBe('known')
		expect(v.activeWorkflows).toBe(0)
		expect(v.runs).toEqual([])
		expect(v.dropped).toBe(2)
		expect(v.failingRun).toBeNull()
	})
	it('a repo whose only active workflow is GitHub-managed counts as no workflows: no runs, no red', () => {
		const runs = [
			run(8, 50, 'bbb', 'failure', '2026-03-11T00:00:00Z'),
			run(7, 50, 'bbb', 'success', '2026-03-10T11:00:00Z'),
		]
		const v = ciRunsVerdict(
			runs,
			[{ id: 50, state: 'active', path: 'dynamic/dependabot/dependabot-updates' }],
			deployed,
		)
		expect(v.workflows).toBe('known')
		expect(v.activeWorkflows).toBe(0)
		expect(v.runs).toEqual([])
		expect(v.dropped).toBe(2)
		expect(v.failingRun).toBeNull()
	})
	it("next to a repo workflow, a dynamic workflow's runs are dropped and never fail the app", () => {
		const runs = [
			run(9, 50, 'ccc', 'failure', '2026-03-11T00:00:00Z'),
			run(8, 1, 'ccc', 'success', '2026-03-11T00:00:00Z'),
		]
		const v = ciRunsVerdict(
			runs,
			[
				{ id: 1, state: 'active', path: '.github/workflows/ci.yml' },
				{ id: 50, state: 'active', path: 'dynamic/pages/pages-build-deployment' },
			],
			deployed,
		)
		expect(v.activeWorkflows).toBe(1)
		expect(v.runs.map((r) => r.id)).toEqual([8])
		expect(v.failingRun).toBeNull()
	})
	it('a repo with no workflows at all keeps nothing', () => {
		const v = ciRunsVerdict([run(1, 5, 'aaa', 'failure', '2026-03-01T00:00:00Z')], [], deployed)
		expect(v.runs).toEqual([])
		expect(v.failingRun).toBeNull()
	})
	it('workflows unknown (GitHub did not answer): no run is kept, nothing turns red', () => {
		const v = ciRunsVerdict([run(1, 5, 'bbb', 'failure', '2026-03-11T00:00:00Z')], null, deployed)
		expect(v.workflows).toBe('unknown')
		expect(v.runs).toEqual([])
		expect(v.failingRun).toBeNull()
	})
	it('a red run on an older commit is kept but muted and never the failing run', () => {
		const runs = [
			run(3, 1, 'bbb', 'success', '2026-03-10T11:30:00Z'),
			run(2, 1, 'aaa', 'failure', '2026-03-09T00:00:00Z'),
		]
		const v = ciRunsVerdict(
			runs,
			[{ id: 1, state: 'active', path: '.github/workflows/w1.yml' }],
			deployed,
		)
		expect(v.runs.map((r) => [r.id, r.notDeployed])).toEqual([
			[3, false],
			[2, true],
		])
		expect(v.failingRun).toBeNull()
	})
	it('a red run on the deployed or a newer commit is the failing run', () => {
		const runs = [
			run(5, 1, 'ccc', 'failure', '2026-03-11T00:00:00Z'),
			run(4, 1, 'bbb', 'timed_out', '2026-03-10T11:00:00Z'),
			run(3, 2, 'ccc', 'failure', '2026-03-11T00:00:00Z'),
		]
		const v = ciRunsVerdict(
			runs,
			[
				{ id: 1, state: 'active', path: '.github/workflows/w1.yml' },
				{ id: 2, state: 'deleted', path: '.github/workflows/w2.yml' },
			],
			deployed,
		)
		expect(v.runs.map((r) => r.id)).toEqual([5, 4])
		expect(v.dropped).toBe(1)
		expect(v.failingRun?.id).toBe(5)
		const onlyDeployed = ciRunsVerdict(
			runs.slice(1),
			[{ id: 1, state: 'active', path: '.github/workflows/w1.yml' }],
			deployed,
		)
		expect(onlyDeployed.failingRun?.id).toBe(4)
	})
	it('anchored on queued_at: a push while the deployed commit waited in the queue is current', () => {
		// queued 10:00, claimed by the worker 10:05 (started_at reset), finished later
		const waited = { sha: 'bbb', queuedAt: '2026-03-12T10:00:00Z' }
		const wf = [{ id: 1, state: 'active', path: '.github/workflows/w1.yml' }]
		const during = run(21, 1, 'ccc', 'failure', '2026-03-12T10:02:00Z')
		const before = run(20, 1, 'aaa', 'failure', '2026-03-12T09:59:00Z')
		expect(isRunNotDeployed(during, waited)).toBe(false)
		expect(isRunNotDeployed(before, waited)).toBe(true)
		const v = ciRunsVerdict([during, before], wf, waited)
		expect(v.failingRun?.id).toBe(21)
		expect(ciRunsVerdict([before], wf, waited).failingRun).toBeNull()
	})
	it('a red run of a push made during the running deploy is the failing run', () => {
		const runs = [
			run(12, 1, 'ccc', 'failure', '2026-03-10T12:02:00Z'),
			run(11, 1, 'aaa', 'failure', '2026-03-10T11:00:00Z'),
		]
		const v = ciRunsVerdict(
			runs,
			[{ id: 1, state: 'active', path: '.github/workflows/w1.yml' }],
			deployed,
		)
		expect(v.runs.map((r) => [r.id, r.notDeployed])).toEqual([
			[12, false],
			[11, true],
		])
		expect(v.failingRun?.id).toBe(12)
	})
	it('runs unreadable (GitHub error, rate limit, timeout): unknown, never "no workflows"', () => {
		const v = ciRunsVerdict(
			null,
			[{ id: 1, state: 'active', path: '.github/workflows/w1.yml' }],
			deployed,
		)
		expect(v.workflows).toBe('unknown')
		expect(v.runs).toEqual([])
		expect(v.failingRun).toBeNull()
	})
	it('a run in progress is never the failing run', () => {
		const v = ciRunsVerdict(
			[run(6, 1, 'ccc', null, '2026-03-11T00:00:00Z')],
			[{ id: 1, state: 'active', path: '.github/workflows/w1.yml' }],
			deployed,
		)
		expect(v.failingRun).toBeNull()
	})
})

// Guard: every reader of GitHub Actions runs goes through ciRunsVerdict, so no badge,
// pill or banner anywhere can read raw runs (a deleted workflow, an old commit).
describe('one authority for Actions state', () => {
	it('only the ci route calls listRunsForRepo, and it applies ciRunsVerdict', () => {
		const src = join(__dirname, '../..')
		const walk = (dir: string): string[] =>
			readdirSync(dir).flatMap((n) => {
				const p = join(dir, n)
				if (statSync(p).isDirectory()) return n === '__tests__' ? [] : walk(p)
				return /\.tsx?$/.test(n) ? [p] : []
			})
		const callers = walk(src)
			.filter((f) => /listRunsForRepo\(|actions\/runs\b/.test(readFileSync(f, 'utf8')))
			.map((f) => relative(src, f))
			.sort()
		expect(callers).toEqual(['app/api/projects/[id]/ci/route.ts', 'lib/github-ci.ts'])
		const route = readFileSync(join(src, 'app/api/projects/[id]/ci/route.ts'), 'utf8')
		expect(route).toMatch(/ciRunsVerdict\(runs, workflows, deployed\)/)
		expect(route).not.toMatch(/runs\.find\(/)
	})
})
