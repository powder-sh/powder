// Which GitHub Actions runs count. The one rule every reader of Actions state goes
// through (the ci tab today, any badge or pill later), so a deleted workflow or a
// red run on a commit that is not deployed can never paint an app red:
//   1. a run counts only when its workflow is active (state "active") and is a file of
//      the repo under .github/workflows/; runs of a deleted or disabled workflow, and of
//      GitHub's built-in workflows (dynamic/dependabot/..., dynamic/pages/...), are dropped;
//   2. a kept run is "not the deployed commit" when its head_sha is not the deployed
//      commit AND it was created before the deploy of that commit was QUEUED (queued_at:
//      started_at is reset when the worker claims the row). A push that lands while that
//      deploy waits in the queue or runs is newer than it, so its run stays current. After a
//      rollback, runs of the rolled-back newer commit are "not the deployed commit" too.
//      Such a run is shown muted and never drives a failure banner or badge.
// Pure: no network, no DB.

export interface RunLike {
	id: number
	workflow_id: number
	head_sha: string
	status: string
	conclusion: string | null
	created_at: string
}

export interface WorkflowLike {
	id: number
	state: string
	/** ".github/workflows/<file>" for the repo's own workflows; GitHub's built-in ones
	 *  (Dependabot updates, Pages builds, code scanning) have "dynamic/..." paths. */
	path: string
}

/** The latest successful deploy of the app: its commit and when that deploy was queued
 *  (deploys.queued_at, never overwritten). */
export interface DeployedCommit {
	sha: string | null
	queuedAt: string | null
}

export type CiRunsVerdict<R extends RunLike> =
	| { workflows: 'unknown'; activeWorkflows: 0; runs: []; dropped: number; failingRun: null }
	| {
			workflows: 'known'
			activeWorkflows: number
			runs: (R & { notDeployed: boolean })[]
			dropped: number
			/** The newest completed, failed run that is current, or null. Only this may turn anything red. */
			failingRun: (R & { notDeployed: boolean }) | null
	  }

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out'])

/** A workflow the repo itself defines: a file under .github/workflows/. */
export function isRepoWorkflow(w: Pick<WorkflowLike, 'path'>): boolean {
	return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(w.path ?? '')
}

/** Ids of the repo's own workflows that are active. */
export function activeWorkflowIds(workflows: readonly WorkflowLike[]): Set<number> {
	return new Set(
		workflows.filter((w) => w.state === 'active' && isRepoWorkflow(w)).map((w) => w.id),
	)
}

/** True when the run is "not the deployed commit" (rule 2 above). No deployed commit,
 *  or no queue time: nothing to compare with, the run counts as current. */
export function isRunNotDeployed(
	run: Pick<RunLike, 'head_sha' | 'created_at'>,
	deployed: DeployedCommit | null,
): boolean {
	if (!deployed?.sha || !deployed.queuedAt) return false
	if (run.head_sha === deployed.sha) return false
	const runAt = Date.parse(run.created_at)
	const deployAt = Date.parse(deployed.queuedAt)
	if (!Number.isFinite(runAt) || !Number.isFinite(deployAt)) return false
	return runAt < deployAt
}

/** Apply both rules to a repo's runs. `runs` or `workflows` null = GitHub could not be
 *  read (error, rate limit, timeout): no run can be judged, so none is kept and the
 *  verdict says "unknown", never "no workflows". Runs keep their input order (newest first). */
export function ciRunsVerdict<R extends RunLike>(
	runs: readonly R[] | null,
	workflows: readonly WorkflowLike[] | null,
	deployed: DeployedCommit | null,
): CiRunsVerdict<R> {
	if (runs === null || workflows === null) {
		return {
			workflows: 'unknown',
			activeWorkflows: 0,
			runs: [],
			dropped: runs?.length ?? 0,
			failingRun: null,
		}
	}
	const active = activeWorkflowIds(workflows)
	const kept = runs
		.filter((r) => active.has(r.workflow_id))
		.map((r) => ({ ...r, notDeployed: isRunNotDeployed(r, deployed) }))
	const failingRun =
		kept.find(
			(r) =>
				!r.notDeployed && r.status === 'completed' && FAILED_CONCLUSIONS.has(r.conclusion ?? ''),
		) ?? null
	return {
		workflows: 'known',
		activeWorkflows: active.size,
		runs: kept,
		dropped: runs.length - kept.length,
		failingRun,
	}
}
