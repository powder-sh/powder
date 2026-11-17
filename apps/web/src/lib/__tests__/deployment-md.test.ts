import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../github', () => ({}))
vi.mock('../ssh', () => ({}))
vi.mock('../servers', () => ({}))
vi.mock('../oauth-token', () => ({}))
import { renderMarkdown } from '../sync-deployment-md'

describe('DEPLOYMENT.md', () => {
	const md = renderMarkdown({
		serverId: 'srv_main',
		containerName: 'web',
		workingDir: '/opt/apps/web',
		envFile: '/opt/apps/web.env',
		hostnames: ['web.example.com'],
		branch: 'main',
	})
	it('names the server by id only, never a host or ip', () => {
		expect(md).toContain('srv_main')
		expect(md).not.toMatch(/ssh root@/)
		expect(md).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
	})
})

describe('DEPLOYMENT.md links', () => {
	const md = renderMarkdown({
		serverId: 'srv_main',
		containerName: 'web',
		workingDir: '/opt/apps/web',
		envFile: '/opt/apps/web.env',
		hostnames: [],
		branch: 'main',
	})
	it('points at the public deploy docs, not a local agent skill file', () => {
		expect(md).toContain('/docs/deploys')
		expect(md).not.toContain('.claude/')
		expect(md).not.toContain('SKILL.md')
	})
})
