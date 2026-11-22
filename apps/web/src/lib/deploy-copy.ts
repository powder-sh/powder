// What the "copy error" control on an app's deployments tab and on the deploy page puts
// on the clipboard.
//
// A failed deploy copies a self-contained block that can be pasted into a chat
// or an issue as is: which app, which deploy, which commit, where it broke, and
// the end of the log (never megabytes). Everything comes from the deploy row the page
// already holds (masked on read by the API); nothing is fetched for it.
// A successful or live deploy copies the output shown, unchanged.

import { fenceFor } from './agent-help-prompts'
import { type DeployCommitFacts, deployCommit, formatCommitLabel } from './deploy-commit'
import { logTailText, stripFailMarkers, tailCuts } from './deploy-log'
import { parseDeployFailure } from './deploy-failure'
import { summaryBeyondStep } from './notify-text'

export interface FailedDeployCopy {
	app: string
	deployId: string
	sha?: string | null
	/** true when `sha` is only the commit the push requested (lib/deploy-commit.ts) */
	shaRequested?: boolean
	branch?: string | null
	failedStep?: string | null
	exitCode?: number | null
	summary?: string | null
	/** The error text as shown on the page (fail markers already stripped). Only its last
	 *  lines are copied (lib/deploy-log.ts logTailText): the cause is at the end, and the
	 *  full log is one click away on the deploy page. */
	error: string
	/** true when `error` is already the end of a longer log */
	logCut?: boolean
}

export function failedDeployCopyBlock(o: FailedDeployCopy): string {
	const commit = o.sha
		? `${formatCommitLabel({ short: o.sha.slice(0, 7), requested: o.shaRequested === true })}${o.branch ? ` (${o.branch})` : ''}`
		: null
	const head = [
		// the app name is unknown until the project has loaded: leave it out then
		o.app ? `powder deploy failed: ${o.app}` : 'powder deploy failed',
		`deploy: ${o.deployId}`,
		commit ? `commit: ${commit}` : o.branch ? `branch: ${o.branch}` : null,
		o.failedStep ? `failed at: ${o.failedStep}` : null,
		o.exitCode != null ? `exit code: ${o.exitCode}` : null,
		// a summary that only repeats the step is left out (summaryBeyondStep)
		o.summary && summaryBeyondStep(o.failedStep, o.summary) ? `summary: ${summaryBeyondStep(o.failedStep, o.summary)}` : null,
	]
		.filter((l): l is string => l !== null)
		.join('\n')
	const cut = o.logCut === true || tailCuts(o.error)
	const body = logTailText(o.error) || '(no error text recorded)'
	const fence = fenceFor(body)
	const label = cut ? `last lines of the log (full log: /deploys/${o.deployId}):` : 'error:'
	return `${head}\n\n${label}\n${fence}\n${body}\n${fence}\n`
}

/** The failed-deploy block from a row of the deployments tab: the stored summary, step
 *  and exit code, and the end of the log the API sent (lib/deploy-log-read.ts). A row
 *  with no stored summary falls back to parsing that tail. */
export function failedDeployCopyFromRow(
	app: string,
	d: DeployCommitFacts & {
		id: string
		gitBranch: string | null
		logTail?: string | null
		logCut?: boolean
		failedStep?: string | null
		exitCode?: number | null
		errorSummary?: string | null
	},
): string {
	const tail = d.logTail ?? ''
	const parsed = !d.errorSummary && !d.failedStep && tail ? parseDeployFailure(tail) : null
	const commit = deployCommit(d)
	return failedDeployCopyBlock({
		app,
		deployId: d.id,
		sha: commit?.sha ?? null,
		shaRequested: commit?.requested,
		branch: d.gitBranch,
		failedStep: d.failedStep ?? parsed?.failedStep ?? null,
		exitCode: d.exitCode ?? parsed?.exitCode ?? null,
		summary: d.errorSummary ?? parsed?.errorSummary ?? null,
		error: stripFailMarkers(tail),
		logCut: d.logCut,
	})
}
