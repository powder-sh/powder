import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { renderLabelsBlock } from '../app-domains'
import { composeWordProblem, healthPathFor, resolveBaseDomain } from '../app-hosts'
import { COMPOSE_RAW_AWK } from '../deploy/fragments'

// the raw compose guard refuses "include" / "extends" anywhere in a compose
// file, powder's override included: such values never reach the labels.
const rawGuard = (text: string) =>
	spawnSync('awk', ['-v', 'gen=1', COMPOSE_RAW_AWK], {
		input: text,
		encoding: 'utf8',
		env: { ...process.env, LC_ALL: 'C' },
	})

describe('include/extends values', () => {
	it('a saved hostname with the words is refused with a clear message', () => {
		expect(composeWordProblem('docs-include.example.com', 'hostname')).toMatch(/include.*extends/)
		expect(composeWordProblem('shop.example.com', 'hostname')).toBeNull()
	})
	it('a base domain or health path with the words is treated as unset', () => {
		expect(resolveBaseDomain('s1', 'apps.extends.example')).toBeNull()
		expect(healthPathFor('/api/include/health')).toBe('/')
		expect(healthPathFor('https://x.example.com/healthz')).toBe('/healthz')
	})
	it('the rendered labels drop such a host and pass the raw guard', () => {
		const block = renderLabelsBlock({
			containerName: 'shop',
			hosts: ['shop.example.com', 'include.example.com'],
			containerPort: 3000,
			redirects: { redirects: [], rewrites: [], headers: {} } as never,
			healthUrl: '/extends',
		})
		expect(block).not.toMatch(/include|extends/i)
		const r = rawGuard(`services:\n  shop:\n${block}\n`)
		expect(r.stdout).toBe('')
		expect(r.status).toBe(0)
	})
})
