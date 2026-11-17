import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { compareDocs } from '../docs'

const d = (slug: string, order: number) => ({ slug, order })

describe('docs nav order', () => {
	it('puts quickstart first whatever its order, then frontmatter order', () => {
		const list = [d('self-hosting', 1), d('troubleshooting', 50), d('quickstart', 99), d('deploys', 3)]
		expect(list.sort(compareDocs).map((x) => x.slug)).toEqual(['quickstart', 'self-hosting', 'deploys', 'troubleshooting'])
	})
	it('a missing quickstart is no problem', () => {
		const list = [d('upgrading', 10), d('faq', 9), d('uninstall', 10)]
		expect(list.sort(compareDocs).map((x) => x.slug)).toEqual(['faq', 'uninstall', 'upgrading'])
	})
})
