// The repo connect route validates repoUrl and branch BEFORE generating a key,
// storing a row or touching git (git option injection, credentials in URL).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createRepo = vi.fn()
const generateDeployKey = vi.fn(async () => ({ pub: 'p', priv: 'k' }))
vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => ({ user: { id: 'u' }, server: { id: 's', kind: 'compose' } }),
}))
vi.mock('@/lib/repos', () => ({
	projectNameProblem: async () => null,
	appNamesOnServer: async () => [],
	createRepo: (...a: unknown[]) => createRepo(...a),
	decryptWebhookSecret: () => '',
	deleteRepo: async () => {},
	getRepoFor: async () => null,
}))
vi.mock('@/lib/keygen', () => ({ generateDeployKey: () => generateDeployKey() }))
vi.mock('@/lib/ssh', () => ({
	inspectContainer: async () => ({ compose: { workingDir: '/opt/apps/web' } }),
	runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
	writeFileSecret: async () => {},
	deleteRemoteFile: async () => {},
}))

import { POST } from '@/app/api/servers/[id]/containers/[name]/repo/route'

const call = (body: unknown) =>
	POST(
		new Request('https://dash.example/api/servers/s/containers/web/repo', {
			method: 'POST',
			body: JSON.stringify(body),
		}) as never,
		{ params: Promise.resolve({ id: 's', name: 'web' }) },
	)

beforeEach(() => {
	createRepo.mockReset()
	generateDeployKey.mockClear()
})

describe('POST /repo validation', () => {
	for (const [label, body] of [
		['dash-led repoUrl', { repoUrl: '--upload-pack=touch /tmp/pwn', branch: 'main' }],
		['dash-led branch', { repoUrl: 'git@github.com:a/b.git', branch: '--upload-pack=x' }],
		['credentials in the URL', { repoUrl: 'https://x-access-token:ghs_abc@github.com/a/b.git' }],
		['non-string branch', { repoUrl: 'git@github.com:a/b.git', branch: ['main'] }],
	] as const) {
		it(`400 on ${label}, nothing stored`, async () => {
			const res = await call(body)
			expect(res.status).toBe(400)
			expect(createRepo).not.toHaveBeenCalled()
			expect(generateDeployKey).not.toHaveBeenCalled()
		})
	}
	it('a clean URL goes through to createRepo with the default branch', async () => {
		createRepo.mockResolvedValue({
			row: { repoUrl: 'git@github.com:a/b.git', branch: 'main', webhookToken: 't' },
			webhookSecret: 'w',
		})
		const res = await call({ repoUrl: 'git@github.com:a/b.git' })
		expect(res.status).toBe(200)
		expect(createRepo).toHaveBeenCalledWith(expect.objectContaining({ branch: 'main' }))
	})
})
