import { describe, expect, it, vi } from 'vitest'

const cmds: string[] = []
vi.mock('@/lib/access', () => ({ requireContainerAccess: async () => ({ server: { id: 's' }, user: { id: 'u' } }) }))
vi.mock('@/lib/keygen', () => ({ generateDeployKey: vi.fn() }))
vi.mock('@/lib/repos', () => ({
	createRepo: vi.fn(),
	decryptWebhookSecret: () => 'x',
	deleteRepo: vi.fn(),
	getRepoFor: async () => ({ repoUrl: 'r', branch: 'main', deployKeyPub: 'k', webhookToken: 't' }),
}))
vi.mock('@/lib/ssh', () => ({
	deleteRemoteFile: vi.fn(),
	writeFileSecret: vi.fn(),
	inspectContainer: async () => ({ compose: { workingDir: '/opt/apps/x$(touch /tmp/pwn)`id`"y' } }),
	runCommand: async (_s: unknown, cmd: string) => {
		cmds.push(cmd)
		return { code: 0, stdout: '', stderr: '' }
	},
}))

import { GET } from '../../app/api/servers/[id]/containers/[name]/repo/route'

describe('repo route quoting', () => {
	it('workingDir is single-quoted with shq, not JSON.stringify', async () => {
		const req = Object.assign(new Request('http://x/api'), { nextUrl: new URL('http://x/api') }) as never
		await GET(req, { params: Promise.resolve({ id: 's', name: 'x' }) })
		expect(cmds[0]).toBe(`test -d '/opt/apps/x$(touch /tmp/pwn)\`id\`"y/.git'`)
	})
})
