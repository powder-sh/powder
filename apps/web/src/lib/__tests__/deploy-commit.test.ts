import { describe, expect, it } from 'vitest'
import { deployEvent } from '../activity-feed'
import { debugDeployPrompt } from '../agent-help-prompts'
import { deployCommit, deployCommitLabel, formatCommitLabel } from '../deploy-commit'
import { failedDeployCopyBlock, failedDeployCopyFromRow } from '../deploy-copy'

// One function names a deploy's commit for every display: went live, else built, else
// requested (labelled). git_sha alone keeps meaning "what went live".
const LIVE = '1'.repeat(40)
const BUILT = '2'.repeat(40)
const REQ = '3'.repeat(40)

describe('deployCommit', () => {
	it('prefers the live commit, then the built one, then the requested one', () => {
		expect(deployCommit({ gitSha: LIVE, builtSha: BUILT, requestedSha: REQ })).toEqual({ sha: LIVE, short: '1111111', requested: false })
		expect(deployCommit({ gitSha: null, builtSha: BUILT, requestedSha: REQ })).toEqual({ sha: BUILT, short: '2222222', requested: false })
		expect(deployCommit({ gitSha: null, builtSha: null, requestedSha: REQ })).toEqual({ sha: REQ, short: '3333333', requested: true })
		expect(deployCommit({ gitSha: null, builtSha: null, requestedSha: null })).toBeNull()
		expect(deployCommit({})).toBeNull()
	})
	it('labels a requested commit', () => {
		expect(deployCommitLabel({ requestedSha: REQ })).toBe('3333333 (requested)')
		expect(deployCommitLabel({ builtSha: BUILT })).toBe('2222222')
		// one form everywhere: the page, the tab, the copy block and the prompt
		expect(formatCommitLabel({ short: '3333333', requested: true })).toBe('3333333 (requested)')
	})
})

describe('displays read the deploy commit', () => {
	const failedOld = { id: 'dep_1', gitSha: null, builtSha: null, requestedSha: REQ, gitBranch: null, logTail: 'x' }
	it('the copied error block of a pre-swap failure names the requested commit', () => {
		expect(failedDeployCopyFromRow('shop', failedOld)).toContain('commit: 3333333 (requested)')
		expect(failedDeployCopyFromRow('shop', { ...failedOld, builtSha: BUILT })).toContain('commit: 2222222')
		expect(failedDeployCopyBlock({ app: 'shop', deployId: 'dep_1', sha: REQ, shaRequested: true, error: '' })).toContain('commit: 3333333 (requested)')
	})
	it('the activity feed shows the commit of a failed git deploy', () => {
		const row = {
			id: 'dep_1',
			containerName: 'shop',
			kind: 'git_deploy',
			status: 'failed',
			queuedAt: new Date(0),
			startedAt: new Date(0),
			triggeredBy: null,
			gitSha: null,
			builtSha: BUILT as string | null,
			requestedSha: REQ,
			errorSummary: 'boom',
		}
		expect(deployEvent(row).what).toContain('2222222')
		expect(deployEvent({ ...row, builtSha: null }).what).toContain('3333333 (requested)')
	})
	it('the debug prompt labels a requested commit', () => {
		expect(debugDeployPrompt({ app: 'shop', sha: REQ, shaRequested: true, log: 'x' })).toContain('commit 3333333 (requested)')
	})
})
