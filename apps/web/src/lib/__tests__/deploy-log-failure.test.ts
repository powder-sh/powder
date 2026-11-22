import { describe, expect, it } from 'vitest'
import { deployLogText, errorCoveredByOutput, errorToStore, failureTail, logTailText } from '../deploy-log'
import { LOG_WINDOW_CHARS, failureTailFromWindows } from '../deploy-log-read'

// A step failure's error repeated the whole log that output already holds: the deploy
// page showed it twice. One copy now, the error only when it adds something, and the
// short views show the end of the log, where the cause is.
const lines = (n: number, p = 'line') => Array.from({ length: n }, (_, i) => `${p} ${i}`).join('\n')
const LOG = `── build ──\n${lines(5000)}\nError: Cannot find module ./missing\n__POWDER_FAIL__ step=build code=1\n`

describe('deploy page log: one copy', () => {
	it('an old row whose error repeats the output renders the log once', () => {
		const text = deployLogText({ output: `[env] rendered\n${LOG}`, error: LOG })
		expect(text.match(/Cannot find module/g)).toHaveLength(1)
		expect(text).not.toContain('ERROR: ')
		expect(text).not.toContain('__POWDER_FAIL__')
	})
	it('an error that says something the output does not is kept in front', () => {
		const text = deployLogText({ output: LOG, error: 'env render failed: permission denied' })
		expect(text.startsWith('ERROR: env render failed: permission denied\n\n')).toBe(true)
		expect(text).toContain('Cannot find module')
	})
	it('one extra line is enough to keep the error', () => {
		expect(errorCoveredByOutput(`${LOG}\n[rollback] restored the previous image`, LOG)).toBe(false)
		expect(errorCoveredByOutput(LOG, `${LOG}\n[rollback] restored`)).toBe(true)
	})
	it('no error, or no output', () => {
		expect(deployLogText({ output: 'a', error: null })).toBe('a')
		expect(deployLogText({ output: null, error: 'boom' })).toBe('ERROR: boom\n\n')
	})
})

describe('what the runner stores in error', () => {
	it('a step failure keeps only the tail (the output has the rest), the trailer included', () => {
		const stored = errorToStore(LOG, `[env] ok\n${LOG}`)
		expect(stored.length).toBeLessThanOrEqual(8 * 1024)
		expect(stored).toContain('Cannot find module')
		expect(stored).toContain('__POWDER_FAIL__ step=build code=1')
		expect(errorCoveredByOutput(stored, LOG)).toBe(true)
	})
	it('an error the output lacks is stored whole', () => {
		const e = `${lines(3000, 'builder')}\nbuilder died`
		expect(errorToStore(e, LOG)).toBe(e)
	})
})

describe('the tail', () => {
	it('is the end of the log, whole lines, bounded', () => {
		const t = logTailText(LOG)
		expect(t.split('\n')).toHaveLength(60)
		expect(t.endsWith('__POWDER_FAIL__ step=build code=1')).toBe(true)
		expect(logTailText('x'.repeat(20_000)).length).toBe(8 * 1024)
	})
	it('a failure tail comes from the error only when it adds something', () => {
		expect(failureTail({ output: LOG, error: LOG })).toContain('Cannot find module')
		const t = failureTail({ output: LOG, error: 'health check failed: /api/health answered 503' })
		expect(t.endsWith('Error: Cannot find module ./missing\n\nERROR: health check failed: /api/health answered 503')).toBe(true)
		expect(failureTail({ output: null, error: 'superseded by a newer deploy' })).toBe('superseded by a newer deploy')
	})
	it('the per-app tab gets the masked tail from windows, the partial first line dropped', () => {
		const secret = `token ghp_${'A'.repeat(36)}`
		const window = `${secret.slice(10)}\n${lines(100)}\nError: boom`
		const padded = window.padStart(LOG_WINDOW_CHARS, 'x')
		const r = failureTailFromWindows({ output: padded, error: null })
		expect(r.logTail.endsWith('Error: boom')).toBe(true)
		expect(r.logCut).toBe(true)
		const short = failureTailFromWindows({ output: 'a\nb\nError: boom', error: 'a\nb\nError: boom' })
		expect(short).toEqual({ logTail: 'a\nb\nError: boom', logCut: false })
	})
})
