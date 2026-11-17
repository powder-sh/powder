import { describe, expect, it } from 'vitest'
import { AGENTS_MD_COMMIT_MESSAGE, renderAgentsMd } from '../agents-md'
import { SITE_URL } from '../site'

describe('AGENTS.md committed by /new (opt-in)', () => {
	const md = renderAgentsMd({ branch: 'main', dashboardUrl: 'https://deploy.example.com/' })

	it('says what a push does, where env vars live and how to check a deploy', () => {
		expect(md).toContain('git push origin main')
		expect(md).toContain('https://deploy.example.com/projects')
		expect(md).toMatch(/## Env vars/)
		expect(md).toMatch(/## Checking a deploy/)
		expect(md).toContain(`${SITE_URL}/docs/deploys`)
	})

	it('is neutral: no operator stories, agent product names or billing advice', () => {
		for (const bad of [/billing/i, /fleet/i, /claude/i, /taken down/i, /OOM/, /\bsed\b/, /deploy\.sh/]) {
			expect(md).not.toMatch(bad)
		}
		expect(AGENTS_MD_COMMIT_MESSAGE).not.toMatch(/guardrail/i)
	})

	it('uses the branch it is given', () => {
		expect(renderAgentsMd({ branch: 'prod', dashboardUrl: 'https://d.example' })).toContain('git push origin prod')
	})
})
