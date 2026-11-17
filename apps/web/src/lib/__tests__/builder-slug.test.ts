// the builder workdir slug was `<server>-<basename(workdir)>-<app>`, so two apps
// could share /opt/builds/<slug> and rm -rf each other's in-flight clone.
import { describe, expect, it } from 'vitest'
import { builderDirSlug } from '../builder-slug'

describe('builderDirSlug', () => {
	it('is <16 hex>-<app> and stable', () => {
		const s = builderDirSlug('boxa', '/opt/apps/shopfront', 'shopfront')
		expect(s).toMatch(/^[0-9a-f]{16}-shopfront$/)
		expect(builderDirSlug('boxa', '/opt/apps/shopfront', 'shopfront')).toBe(s)
	})
	it('names that a plain join would collide get distinct slugs', () => {
		const pairs: Array<[[string, string, string], [string, string, string]]> = [
			[['server-a', '/opt/apps/b', 'web'], ['server', '/opt/apps/a-b', 'web']],
			[['boxa', '/opt/apps/one/shop', 'web'], ['boxa', '/opt/apps/two/shop', 'web']],
			[['boxa', '/opt/apps/x|y', 'z'], ['boxa', '/opt/apps/x', 'y|z']],
		]
		for (const [a, b] of pairs) expect(builderDirSlug(...a)).not.toBe(builderDirSlug(...b))
	})
})
