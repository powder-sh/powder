// dashboard web hardening that has no other test home.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getTransport } from '../mailer'

const src = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

describe('web hardening', () => {
	it('PostHog session replay is off in code', () => {
		const s = src('components/posthog-provider.tsx')
		expect(s).toContain('disable_session_recording: true')
		expect(s).not.toMatch(/session_recording:\s*\{/)
	})
	it('the webhook URL / deploy key copy line is excluded from capture', () => {
		const s = src('components/repo-card.tsx')
		const copyLine = s.slice(s.indexOf('function CopyLine'))
		expect(copyLine).toMatch(/className="ph-no-capture /)
	})
	it('nodemailer >= 10 gets the SMTP timeouts as transport options next to the url', () => {
		const t = getTransport('smtp://u:p@127.0.0.1:2525') as unknown as {
			options: Record<string, unknown>
		}
		expect(t.options.host).toBe('127.0.0.1')
		expect(t.options.connectionTimeout).toBe(10_000)
		expect(t.options.socketTimeout).toBe(10_000)
		const pkg = JSON.parse(src('../package.json')) as { dependencies: Record<string, string> }
		expect(
			Number(pkg.dependencies.nodemailer?.replace(/^\^/, '').split('.')[0]),
		).toBeGreaterThanOrEqual(10)
	})
})
