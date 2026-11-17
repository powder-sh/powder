// small doc and comment drift. powder's own compose commands in the install
// docs must pass --env-file /opt/apps/powder.env (compose-time POWDER_* come from it),
// /setup must be opened on the BETTER_AUTH_URL host, email alerts exist (SMTP targets),
// and no comment may call cf-connecting-ip the default IP header.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../../../../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const DOCS = ['docs/SELF-HOSTING.md', 'apps/web/content/docs/self-hosting.md']

describe('doc drift', () => {
	it('powder compose commands (up/build/logs/exec) carry --env-file', () => {
		const bad: string[] = []
		for (const f of DOCS) {
			for (const m of read(f).matchAll(/`(docker compose [^`]*)`/g)) {
				const cmd = m[1] as string
				// app-side commands (swap check) and `config` mentions are not powder's
				if (!/\b(up|build|logs|exec)\b/.test(cmd) || cmd.includes('<app>')) continue
				if (!cmd.includes('--env-file')) bad.push(`${f}: ${cmd}`)
			}
		}
		expect(bad).toEqual([])
	})
	it('/setup is opened on the BETTER_AUTH_URL host', () => {
		// docs/SELF-HOSTING.md links to the install steps instead of repeating them.
		expect(read('apps/web/content/docs/self-hosting.md')).toMatch(
			/`\/setup` on the\s+dashboard host, the one in `BETTER_AUTH_URL`/,
		)
	})
	it('the security model does not say there are no email alerts', () => {
		const md = read('apps/web/content/docs/security-model.md')
		expect(md).not.toMatch(/There is no email/)
		expect(md).toMatch(/POWDER_SMTP_URL/)
	})
	it('no comment calls cf-connecting-ip the default', () => {
		for (const f of ['apps/web/src/lib/auth.ts', 'apps/web/src/lib/webhook-gate.ts'])
			expect(read(f)).not.toMatch(/[Dd]efault (is )?(Cloudflare's header|cf-connecting-ip)/)
	})
})
