// The "Ask your agent" prompts on the landing page must follow the documented
// install and upgrade paths, not an older manual procedure.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, '../../components/agent-prompts.tsx'), 'utf8')
const prompt = (id: string) => {
	const start = src.indexOf(`id: '${id}'`)
	expect(start).toBeGreaterThan(-1)
	return src.slice(start, src.indexOf('\n\t},', start))
}

describe('agent prompts', () => {
	it('install: release tag, bin/install.sh, the OAuth callback, the setup token, --set-admin', () => {
		const p = prompt('install')
		for (const s of [
			'git clone --branch <latest tag> https://github.com/powder-sh/powder /opt/apps/powder/src',
			'sudo bin/install.sh',
			'https://<host>/api/auth/callback/github',
			"docker logs powder 2>&1 | grep 'setup token'",
			'https://<host>/setup',
			'sudo bin/install.sh --set-admin <id>',
		])
			expect(p).toContain(s)
		for (const old of ['drizzle', '--baseline', 'openssl rand', 'powder.env.example', 'self-deploy.sh'])
			expect(p).not.toContain(old)
	})
	it('upgrade: on the server with install.sh, links the upgrading page', () => {
		const p = prompt('upgrade')
		expect(p).toContain("doc('upgrading')")
		expect(p).toContain('git fetch --tags && git checkout <new tag> && sudo bin/install.sh')
		expect(p).not.toContain('#upgrading-powder')
	})
	it('server: root, git and flock, then check server', () => {
		const p = prompt('server')
		expect(p).toContain('git and flock')
		expect(p).toContain('"check server"')
	})
})
