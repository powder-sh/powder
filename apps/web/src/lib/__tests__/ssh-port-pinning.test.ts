import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf8')

describe('per-port host key pinning is wired', () => {
	// lib/ssh.ts is a barrel now; the connection code lives in lib/ssh/*.
	const ssh = read('lib/ssh/connection.ts') + read('lib/ssh/files.ts')
	it('hostVerifierFor and explainSshError receive the port', () => {
		expect(ssh).toContain('hostVerifierFor(target.host, target.port ?? 22)')
		expect(ssh).not.toMatch(/explainSshError\(server\.host, err\)/)
		expect(ssh).toContain('explainSshError(server.host, err, server.port ?? 22)')
	})
	it('repo import verifies against pinned GitHub keys, not accept-new', () => {
		const route = read('app/api/servers/[id]/containers/[name]/repo/import/route.ts')
		expect(route).not.toContain('accept-new')
		expect(route).toContain('GITHUB_KNOWN_HOSTS_SETUP')
		expect(route).toContain('GIT_SSH_HOSTKEY_OPTS')
	})
})
