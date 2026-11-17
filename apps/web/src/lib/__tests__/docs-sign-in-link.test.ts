import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSiteAllowedPath } from '../hosts'

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8')

afterEach(() => {
	vi.unstubAllEnvs()
	vi.resetModules()
})

describe('docs header sign-in link (static pages)', () => {
	it('the route links the login without a split, and nothing with one', async () => {
		vi.stubEnv('POWDER_SITE_HOST', '')
		const { GET } = await import('../../app/api/sign-in-link/route')
		expect(await GET().json()).toEqual({ href: '/login' })
		vi.stubEnv('POWDER_SITE_HOST', 'powder.example.com')
		expect(await GET().json()).toEqual({ href: null })
	})

	it('a split site host never serves it, so the site cannot point at the dashboard', () => {
		expect(isSiteAllowedPath('/api/sign-in-link')).toBe(false)
	})

	it('the docs header asks in the browser, the page stays static', () => {
		const chrome = read('components/site-chrome.tsx')
		expect(chrome).toContain('<SignInLink />')
		const link = read('components/sign-in-link.tsx')
		expect(link.startsWith("'use client'")).toBe(true)
		expect(link).toContain("fetch('/api/sign-in-link')")
		expect(link).not.toMatch(/process\.env|connection\(/)
	})
})
