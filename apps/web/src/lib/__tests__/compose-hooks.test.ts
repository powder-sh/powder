// post_start / pre_stop hooks run as `docker exec` in the container; a
// `privileged: true` hook gets every capability the service may not have.
import { describe, expect, it } from 'vitest'
import { composeViolations, isHighSeverity } from '../compose-safety'

const ctx = { appName: 'myapp', projectDir: '/opt/apps/myapp', resolved: true }
const doc = (hook: Record<string, unknown>) => ({
	name: 'myapp',
	services: { myapp: { image: 'myapp:latest', post_start: [hook], pre_stop: [hook] } },
})

describe('compose lifecycle hooks', () => {
	it('refuses a privileged hook as high severity', () => {
		const v = composeViolations(doc({ command: 'id', privileged: true }), ctx)
		expect(v.map((x) => x.code)).toEqual(['privileged', 'privileged'])
		expect(v.every(isHighSeverity)).toBe(true)
	})
	it('treats every truthy privileged value as privileged', () => {
		for (const p of [1, '1', 'true', 'TRUE', 'yes', 'on'])
			expect(
				composeViolations(doc({ command: 'id', privileged: p }), ctx).map((x) => x.code),
			).toContain('privileged')
		for (const p of [false, 0, '0', 'false', 'no', 'off'])
			expect(composeViolations(doc({ command: 'id', privileged: p }), ctx)).toEqual([])
	})
	it('refuses unknown hook keys and a non-string user', () => {
		expect(composeViolations(doc({ command: 'id', bogus: 1 }), ctx).map((x) => x.code)).toContain(
			'unknown_key',
		)
		expect(
			composeViolations(doc({ command: 'id', user: { x: 1 } }), ctx).map((x) => x.code),
		).toContain('unknown_key')
	})
	it('allows a plain hook', () => {
		expect(
			composeViolations(
				doc({
					command: ['sh', '-c', 'echo hi'],
					user: 'root',
					privileged: false,
					working_dir: '/app',
					environment: { A: '1' },
				}),
				ctx,
			),
		).toEqual([])
	})
})
