import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OverrideMergeError } from '../compose-override-io'
import { overrideFailureOutcome } from '../deploy/run'

// a compose override that cannot be merged with the app's compose refuses the
// deploy; any other override failure (server I/O) goes on without it, with a WARN line.
describe('override failure', () => {
	it('refuses when the merged config is invalid', () => {
		const o = overrideFailureOutcome(
			new OverrideMergeError('compose override produced an INVALID compose config'),
			'myapp',
			true,
		)
		expect('refuse' in o && o.refuse).toContain('deploy: refusing')
	})
	it('goes on with a WARN line for other failures', () => {
		const o = overrideFailureOutcome(
			new Error('could not create the compose override dir'),
			'my app',
			false,
		)
		expect('log' in o && o.log).toContain('[compose-guard] WARN my_app override_failed')
		expect('log' in o && o.log).toContain('continuing without it')
	})
	it('the deploy wires the merge error class, and applyComposeOverride throws it only for an invalid merge', () => {
		const run = readFileSync(join(__dirname, '..', 'deploy', 'run.ts'), 'utf8')
		expect(run).toMatch(/overrideFailureOutcome\(err, [^)]*err instanceof OverrideMergeError\)/)
		const io = readFileSync(join(__dirname, '..', 'compose-override-io.ts'), 'utf8')
		expect(io.match(/new OverrideMergeError\(/g)).toHaveLength(1)
		expect(io).toMatch(
			/if \(merged\.code !== 0\) \{\s*await restore\(\)\s*throw new OverrideMergeError/,
		)
	})
})
