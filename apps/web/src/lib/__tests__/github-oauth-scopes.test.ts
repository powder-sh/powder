// The scopes README.md and the security model name are exactly the ones sign-in
// asks GitHub for.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GITHUB_OAUTH_SCOPES } from '../github-oauth-scopes'

const REPO = resolve(__dirname, '../../../../..')

/** The backticked names in the first paragraph/bullet of `text` that contains `marker`. */
function scopesNear(text: string, marker: string): string[] {
	const block = text.split(/\n(?=- |\n)/).find((b) => b.includes(marker))
	expect(block, marker).toBeTruthy()
	return [...(block as string).matchAll(/`([^`]+)`/g)].map((m) => m[1] as string)
}

describe('GitHub OAuth scopes', () => {
	it('sign-in uses the shared list', () => {
		expect(readFileSync(join(REPO, 'apps/web/src/lib/auth.ts'), 'utf8')).toContain(
			'scope: [...GITHUB_OAUTH_SCOPES]',
		)
	})
	it('README.md lists exactly those scopes', () => {
		const text = readFileSync(join(REPO, 'README.md'), 'utf8')
		expect(scopesNear(text, 'GitHub OAuth app asks for')).toEqual([...GITHUB_OAUTH_SCOPES])
	})
	it('the security model lists exactly those scopes', () => {
		const text = readFileSync(join(REPO, 'apps/web/content/docs/security-model.md'), 'utf8')
		expect(scopesNear(text, '**GitHub OAuth.**')).toEqual([...GITHUB_OAUTH_SCOPES])
	})
})
