// GitHub API paths are built from validated, encoded segments,
// and repo URLs are parsed for github.com only.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeploymentStatus, createWebhook, parseGithubRepoUrl, repoPath } from '../github'
import { parseRepoUrl } from '../github-deployments'

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({}))
vi.mock('../integrations', () => ({}))

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('GitHub API paths', () => {
	it('parses github.com URLs only, plain names only', () => {
		expect(parseRepoUrl('git@github.com:acme/web.git')).toEqual({ owner: 'acme', repo: 'web' })
		expect(parseRepoUrl('https://github.com/acme/web')).toEqual({ owner: 'acme', repo: 'web' })
		expect(parseRepoUrl('https://github.com/acme/web.git/')).toEqual({ owner: 'acme', repo: 'web' })
		expect(parseRepoUrl('ssh://git@github.com/acme/my.repo.git')).toEqual({
			owner: 'acme',
			repo: 'my.repo',
		})
		for (const bad of [
			'git@evil.example:acme/web.git',
			'https://evil.example/acme/web',
			'https://evil.example/github.com/acme/web',
			'https://github.com/acme/web/../../../user/keys',
			'https://github.com/acme/web/hooks',
			'git@github.com:acme/../x.git',
			'git@github.com:../x.git',
			'https://github.com/acme/web%2F..',
		])
			expect(parseRepoUrl(bad), bad).toBeNull()
		expect(parseGithubRepoUrl('https://github.com/a/..')).toBeNull()
	})
	it('repoPath encodes and refuses / and ..', () => {
		expect(repoPath('acme', 'web.app')).toBe('/repos/acme/web.app')
		for (const [o, r] of [
			['acme', '../user'],
			['acme', 'a/b'],
			['..', 'x'],
			['', 'x'],
			['acme', 'x?y'],
		])
			expect(() => repoPath(o as string, r as string)).toThrow(/invalid GitHub/)
	})
	it('API calls refuse a crafted owner/repo before any request', async () => {
		const f = vi.fn()
		vi.stubGlobal('fetch', f)
		await expect(createWebhook('t', 'acme', '../../user', 'https://x', 's')).rejects.toThrow()
		await expect(createDeploymentStatus('t', 'acme/x', 'web', 1, 'success')).rejects.toThrow()
		expect(f).not.toHaveBeenCalled()
	})
})
