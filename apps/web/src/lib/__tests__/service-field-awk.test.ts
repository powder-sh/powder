import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { SERVICE_FIELD_AWK } from '../deploy/fragments'

// Re-added: SERVICE_FIELD_AWK reads a top-level key of one service out of (resolved) compose
// text. It must work for 2- and 4-space indents and ignore nested keys of the same name.
describe('SERVICE_FIELD_AWK', () => {
	const get = (c: string, f: string) =>
		spawnSync('awk', ['-v', 'svc=app', '-v', `f=${f}`, SERVICE_FIELD_AWK], { input: c, encoding: 'utf8' }).stdout.trim()
	const two = 'services:\n  other:\n    container_name: x\n  app:\n    image: i2\n    container_name: c2\n    labels:\n      container_name: no\n'
	const four = 'services:\n    other:\n        container_name: x\n    app:\n        image: i4\n        container_name: c4\n        labels:\n            container_name: no\n'
	it('2-space indent', () => {
		expect(get(two, 'image:')).toBe('i2')
		expect(get(two, 'container_name:')).toBe('c2')
	})
	it('4-space indent', () => {
		expect(get(four, 'image:')).toBe('i4')
		expect(get(four, 'container_name:')).toBe('c4')
	})
	it('a key that only exists on another service, or nested, is not returned', () => {
		expect(get(two, 'networks:')).toBe('')
	})
})
