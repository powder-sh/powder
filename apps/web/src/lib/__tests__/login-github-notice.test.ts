// /login without GitHub OAuth configured: a notice naming the two env vars and the
// quickstart, not a "Continue with GitHub" button that cannot work.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }))
vi.mock('@/lib/auth-client', () => ({ signIn: { email: async () => ({}), social: async () => ({}) } }))

import { LoginForm } from '../../app/(auth)/login/login-form'
import { githubOAuthConfigured } from '../github-oauth'

describe('login page and GitHub OAuth config', () => {
	it('not configured: the notice with both env vars and the quickstart link, no GitHub button', () => {
		const html = renderToStaticMarkup(createElement(LoginForm, { github: false }))
		expect(html).toContain('GITHUB_CLIENT_ID')
		expect(html).toContain('GITHUB_CLIENT_SECRET')
		expect(html).toContain('href="/docs/quickstart"')
		expect(html).not.toContain('Continue with GitHub')
		expect(html).toContain('Sign in with email')
	})
	it('configured: the GitHub button, no notice', () => {
		const html = renderToStaticMarkup(createElement(LoginForm, { github: true }))
		expect(html).toContain('Continue with GitHub')
		expect(html).not.toContain('GITHUB_CLIENT_ID')
	})
	it('reads both env vars at call time; the page is rendered per request', () => {
		expect(githubOAuthConfigured({ GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b' } as unknown as NodeJS.ProcessEnv)).toBe(true)
		expect(githubOAuthConfigured({ GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: '' } as unknown as NodeJS.ProcessEnv)).toBe(false)
		expect(githubOAuthConfigured({} as unknown as NodeJS.ProcessEnv)).toBe(false)
		const page = readFileSync(join(__dirname, '../../app/(auth)/login/page.tsx'), 'utf8')
		expect(page).toContain("export const dynamic = 'force-dynamic'")
		expect(page).toContain('githubOAuthConfigured()')
	})
})
