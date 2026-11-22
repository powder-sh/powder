// The failed-deploy block the deployments tab copies: self-contained (app, deploy,
// commit, step, exit code, summary, then the error as shown), and lines it has no
// data for are left out rather than printed empty.
import { describe, expect, it } from 'vitest'
import { failedDeployCopyBlock, failedDeployCopyFromRow } from '../deploy-copy'

describe('failedDeployCopyBlock', () => {
	it('every field: header lines in order, then the error in a fence', () => {
		const out = failedDeployCopyBlock({
			app: 'demo',
			deployId: 'dep_abc123',
			sha: '0123456789abcdef',
			branch: 'main',
			failedStep: 'build',
			exitCode: 1,
			summary: 'module not found: ./missing',
			error: 'step 4/9\nError: Cannot find module ./missing\n',
		})
		expect(out).toBe(
			[
				'powder deploy failed: demo',
				'deploy: dep_abc123',
				'commit: 0123456 (main)',
				'failed at: build',
				'exit code: 1',
				'summary: module not found: ./missing',
				'',
				'error:',
				'```',
				'step 4/9',
				'Error: Cannot find module ./missing',
				'```',
				'',
			].join('\n'),
		)
	})

	it('no step, exit code or sha: those lines are left out; a branch alone is kept', () => {
		const out = failedDeployCopyBlock({
			app: 'shop',
			deployId: 'dep_x',
			branch: 'release',
			error: 'connection refused',
		})
		expect(out).toBe(
			'powder deploy failed: shop\ndeploy: dep_x\nbranch: release\n\nerror:\n```\nconnection refused\n```\n',
		)
		expect(out).not.toContain('failed at')
		expect(out).not.toContain('exit code')
		expect(out).not.toContain('commit')
	})

	it('a sha without a branch, exit code 0 is still printed', () => {
		const out = failedDeployCopyBlock({
			app: 'demo',
			deployId: 'dep_y',
			sha: 'abcdef1234',
			exitCode: 0,
			error: 'x',
		})
		expect(out).toContain('commit: abcdef1\n')
		expect(out).toContain('exit code: 0\n')
	})

	it('a log with backtick fences gets a longer fence, so it cannot close the block', () => {
		const out = failedDeployCopyBlock({ app: 'demo', deployId: 'dep_z', error: 'a\n```\nb' })
		expect(out).toContain('\n````\na\n```\nb\n````\n')
	})

	it('empty error text says so', () => {
		expect(failedDeployCopyBlock({ app: 'demo', deployId: 'dep_e', error: '  \n' })).toContain(
			'(no error text recorded)',
		)
	})
})

describe('failedDeployCopyFromRow', () => {
	it('reads step and exit code from the fail trailer and drops the trailer from the text', () => {
		const out = failedDeployCopyFromRow('demo', {
			id: 'dep_1',
			gitSha: 'feedfacecafe',
			gitBranch: 'main',
			logTail: '── build ──\nnpm ERR! missing script: build\n__POWDER_FAIL__ step=build code=2\n',
		})
		expect(out).toContain('failed at: build\n')
		expect(out).toContain('exit code: 2\n')
		// the parser's fallback summary ("failed during: build") only repeats the step
		expect(out).not.toContain('summary: ')
		expect(out).toContain('npm ERR! missing script: build')
		expect(out).not.toContain('__POWDER_FAIL__')
	})

	it('no trailer: no step or exit code line, summary from the last line', () => {
		const out = failedDeployCopyFromRow('demo', {
			id: 'dep_2',
			gitSha: null,
			gitBranch: null,
			logTail: 'ssh: connect to host srv-1 port 22: Connection timed out',
		})
		expect(out).not.toContain('failed at')
		expect(out).not.toContain('exit code')
		expect(out).toContain('summary: ')
	})
	it('a summary that names the cause is kept', () => {
		const out = failedDeployCopyFromRow('demo', {
			id: 'dep_3',
			gitSha: null,
			gitBranch: null,
			logTail:
				'── build ──\nwrite /var/lib: no space left on device\n__POWDER_FAIL__ step=build code=1\n',
		})
		expect(out).toContain('summary: disk full on the server (no space left on device)\n')
	})

	it('a mixed-case step: the fallback summary is still recognised as a repeat', () => {
		const out = failedDeployCopyFromRow('demo', {
			id: 'dep_4',
			gitSha: null,
			gitBranch: null,
			logTail: '── Build Image ──\nsomething odd\n__POWDER_FAIL__ step=Build Image code=1\n',
		})
		expect(out).toContain('failed at: Build Image\n')
		expect(out).not.toContain('summary: ')
	})
})

describe('the copy is the summary plus the end of the log, never megabytes', () => {
	const big = `${Array.from({ length: 20_000 }, (_, i) => `step ${i} ok`).join('\n')}\nError: the real cause\n`
	it('a long error copies only its last lines, labelled, and keeps the cause', () => {
		const out = failedDeployCopyBlock({ app: 'shop', deployId: 'dep_big', summary: 'the real cause', error: big })
		expect(out.length).toBeLessThan(10 * 1024)
		expect(out).toContain('Error: the real cause')
		expect(out).toContain('last lines of the log (full log: /deploys/dep_big):')
		expect(out).not.toContain('step 0 ok')
	})
	it('a row of the tab uses the stored summary, step and exit code', () => {
		const out = failedDeployCopyFromRow('shop', {
			id: 'dep_6',
			gitSha: null,
			gitBranch: null,
			failedStep: 'test gate',
			exitCode: 3,
			errorSummary: 'tests failed',
			logTail: 'FAIL one.test.ts',
			logCut: true,
		})
		expect(out).toContain('failed at: test gate\n')
		expect(out).toContain('exit code: 3\n')
		expect(out).toContain('summary: tests failed\n')
		expect(out).toContain('last lines of the log')
	})
})

describe('failedDeployCopyBlock without an app name', () => {
	it('the first line leaves the name out instead of printing an empty one', () => {
		const out = failedDeployCopyBlock({ app: '', deployId: 'dep_5', error: 'x' })
		expect(out.split('\n')[0]).toBe('powder deploy failed')
	})
})
