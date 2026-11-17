// PostHog is configured at build time: the key needs the host (the /ingest rewrite
// target), and every documented build-time variable reaches the build.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { posthogKey } from '../posthog-config'

const root = resolve(__dirname, '..', '..', '..', '..', '..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')
const VARS = ['NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_POSTHOG_HOST', 'NEXT_PUBLIC_POSTHOG_UI_HOST']

describe('posthogKey', () => {
	it('is the key when key and host are both set', () => {
		expect(posthogKey('phk_x', 'https://eu.i.posthog.com')).toBe('phk_x')
		expect(posthogKey(' phk_x ', 'https://eu.i.posthog.com/')).toBe('phk_x')
	})
	it('is null without a host: /ingest has no rewrite then', () => {
		expect(posthogKey('phk_x', undefined)).toBeNull()
		expect(posthogKey('phk_x', '')).toBeNull()
		expect(posthogKey('phk_x', '  ')).toBeNull()
		expect(posthogKey('phk_x', '/')).toBeNull()
	})
	it('is null without a key', () => {
		expect(posthogKey(undefined, 'https://eu.i.posthog.com')).toBeNull()
		expect(posthogKey('', 'https://eu.i.posthog.com')).toBeNull()
	})
	it('the provider initialises only through posthogKey', () => {
		const s = read('apps/web/src/components/posthog-provider.tsx')
		expect(s).toContain(
			'const POSTHOG_KEY = posthogKey(process.env.NEXT_PUBLIC_POSTHOG_KEY, process.env.NEXT_PUBLIC_POSTHOG_HOST)',
		)
		expect(s.match(/process\.env\.NEXT_PUBLIC_POSTHOG_KEY/g)).toHaveLength(1)
	})
})

describe('PostHog build-time variables reach the build', () => {
	it('the Dockerfile builder declares each as ARG and ENV', () => {
		const df = read('docker/web.Dockerfile')
		for (const v of VARS) {
			expect(df).toContain(`ARG ${v}=""`)
			expect(df).toContain(`ENV ${v}=$${v}`)
		}
	})
	it('both compose builds pass each as a build arg', () => {
		const compose = read('docker-compose.yml')
		for (const v of VARS) {
			expect(compose.split(`${v}: \${${v}:-}`).length - 1, v).toBe(2)
		}
	})
})
