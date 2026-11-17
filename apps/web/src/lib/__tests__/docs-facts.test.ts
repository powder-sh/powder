import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENV_WEBHOOK_EVENTS, NOTIFY_EVENTS } from '../notify-routing'

// docs facts that drifted from the code.

const ROOT = resolve(__dirname, '../../../../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const DOCS = [
	'README.md',
	'CHANGELOG.md',
	'docs/SELF-HOSTING.md',
	'apps/web/content/docs/self-hosting.md',
	'apps/web/content/docs/security-model.md',
	'docker/powder.env.example',
]
const paragraphs = (t: string) => t.split(/\n\s*\n|\n(?=\| )|\n(?=- )/)

describe('docs match the code', () => {
	it('every list of the events POWDER_NOTIFY_WEBHOOK_URL gets is ENV_WEBHOOK_EVENTS', () => {
		const bad: string[] = []
		for (const f of DOCS) {
			for (const p of paragraphs(read(f))) {
				if (!p.includes('POWDER_NOTIFY_WEBHOOK_URL')) continue
				const named = NOTIFY_EVENTS.filter((e) => p.includes(e))
				// a list (two or more events), not a sentence about one event
				if (named.length < 2) continue
				if (
					ENV_WEBHOOK_EVENTS.some((e) => !p.includes(e)) ||
					named.some((e) => !ENV_WEBHOOK_EVENTS.includes(e))
				)
					bad.push(`${f}: ${p.slice(0, 120)}`)
			}
		}
		expect(bad).toEqual([])
		// the settings page renders the list from code
		const page = read('apps/web/src/app/(dashboard)/settings/notifications/page.tsx')
		expect(page).toContain("ENV_WEBHOOK_EVENTS.map(notifyEventLabel).join(', ')")
		// the notification events table lists every event
		const self = read('docs/SELF-HOSTING.md')
		for (const e of NOTIFY_EVENTS) expect(self).toContain(`\`${e}\``)
	})

	it('a Cloudflare origin lock always says where: DOCKER-USER or a cloud firewall (ufw does not filter Docker ports)', () => {
		const bad: string[] = []
		for (const f of DOCS) {
			for (const p of paragraphs(read(f))) {
				if (
					/lock the origin|origin lock|Cloudflare's (IP )?ranges/i.test(p) &&
					!p.includes('DOCKER-USER')
				)
					bad.push(`${f}: ${p.slice(0, 120)}`)
			}
		}
		expect(bad).toEqual([])
	})

	it('the install steps open /setup with the token before the first GitHub login', () => {
		const steps = read('apps/web/content/docs/self-hosting.md')
		const s6 = steps.slice(steps.indexOf('\n6. '), steps.indexOf('\n', steps.indexOf('\n6. ') + 1))
		expect(s6).toContain('/setup')
		expect(s6.indexOf('/setup')).toBeLessThan(s6.indexOf('continue with github'))
		// The operator reference links to the quickstart instead of repeating it.
		expect(read('docs/SELF-HOSTING.md')).toContain('[Quickstart](../apps/web/content/docs/quickstart.md)')
	})

	it('PostHog session recording is off (posthog-provider disables it), restore is in the dashboard', () => {
		expect(read('apps/web/src/components/posthog-provider.tsx')).toContain(
			'disable_session_recording: true',
		)
		for (const f of ['README.md', 'apps/web/content/docs/security-model.md']) {
			expect(read(f)).not.toMatch(/session recording\s+(is on|with inputs)/i)
			expect(read(f)).toMatch(/session recording\s+(is\s+)?off/i)
		}
		expect(read('apps/web/content/docs/security-model.md')).not.toContain('Restore is manual')
	})

	it('the app layout in the docs is what /new renders (context ., env file next to the dir)', () => {
		for (const f of ['docs/SELF-HOSTING.md', 'apps/web/content/docs/self-hosting.md']) {
			expect(read(f)).toContain('build: { context: ., dockerfile: <path> }')
		}
		expect(read('apps/web/src/lib/compose-render.ts')).toContain('      context: .\n')
		expect(read('README.md')).not.toContain('`build: ./src`')
	})

	it('docker compose 2.24+ is a stated requirement (the override files use !reset / !override)', () => {
		for (const f of ['docs/SELF-HOSTING.md', 'apps/web/content/docs/self-hosting.md'])
			expect(read(f)).toMatch(/## Requirements\n\n[\s\S]*?`docker compose` 2\.24 or newer/)
	})
})
