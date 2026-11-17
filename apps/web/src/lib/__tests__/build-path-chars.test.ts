import { describe, expect, it } from 'vitest'
import { composeViolations, isHighSeverity } from '../compose-safety'

// build paths reach the deploy script as data; the compose guard holds them to
// [A-Za-z0-9._/-] (the on-server preflight refuses the same set in every guard mode).

const ctx = { appName: 'shop', projectDir: '/opt/apps/shop' }
const build = (b: unknown) =>
	composeViolations({ services: { shop: { image: 'shop:latest', build: b } } }, ctx).filter(
		(v) => v.code === 'build',
	)

describe('compose guard: build path charset', () => {
	it('accepts the standard and resolved shapes', () => {
		expect(build({ context: './src', dockerfile: 'Dockerfile' })).toEqual([])
		expect(build({ context: '/opt/apps/shop/src', dockerfile: 'docker/Dockerfile.prod' })).toEqual(
			[],
		)
		expect(
			build({
				context: './src/apps/web_1',
				dockerfile: '/opt/apps/shop/src/apps/web_1/Dockerfile',
			}),
		).toEqual([])
		expect(build('./src')).toEqual([])
		expect(build({ context: './src', additional_contexts: { shared: './src/shared' } })).toEqual([])
	})

	it('refuses a context with sed / shell syntax (the sed `e` shape)', () => {
		const v = build({ context: './src/z@@;e touch /pwn;#', dockerfile: 'Dockerfile' })
		expect(v.map((x) => x.message).join('\n')).toContain(
			'build.context "./src/z@@;e touch /pwn;#" contains a character outside [A-Za-z0-9._/-]',
		)
		expect(v[0] && isHighSeverity(v[0])).toBe(true)
		expect(build('./src/a b')).toHaveLength(1)
	})

	it('refuses a dockerfile and an additional context outside the charset', () => {
		expect(build({ context: './src', dockerfile: 'Docker$(id)file' })[0]?.message).toContain(
			'build.dockerfile "Docker$(id)file" contains a character outside',
		)
		expect(
			build({ context: './src', additional_contexts: { x: './src/a;b' } })[0]?.message,
		).toContain('build.additional_contexts.x "./src/a;b" contains a character outside')
	})

	it('does not double-report a path that is already outside the app', () => {
		expect(build({ context: '../x;y' })).toHaveLength(1)
	})
})
