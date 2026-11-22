import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_STATES } from '../app-health'
import { hasTileLayout, tileBorders, tileLayout } from '../status-tiles'

const root = join(__dirname, '..', '..')

// Reads the demo's own STATUSES list, so a state added there needs a layout too.
function demoStatusCount(): number {
	const src = readFileSync(join(root, 'components', 'dashboard-demo.tsx'), 'utf8')
	const m = src.match(/const STATUSES: Status\[\] = \[([^\]]*)\]/)
	if (!m) throw new Error('STATUSES not found in dashboard-demo.tsx')
	return m[1].split(',').filter((s) => s.trim()).length
}

describe('status counter tiles', () => {
	it('every counter strip has a layout for its tile count', () => {
		expect(hasTileLayout(APP_STATES.length), `${APP_STATES.length} app states`).toBe(true)
		expect(hasTileLayout(demoStatusCount()), 'landing demo states').toBe(true)
	})

	it('the counter strips take their grid from the layout, not a fixed column count', () => {
		for (const f of ['app/(dashboard)/projects/page.tsx', 'components/dashboard-demo.tsx']) {
			const src = readFileSync(join(root, f), 'utf8')
			expect(src, f).toMatch(/tileLayout\(/)
			expect(src, f).toMatch(/tileBorders\(/)
			expect(src, f).not.toMatch(/grid-cols-[4-9] divide-x/)
		}
	})

	it('a tile count with no layout throws', () => {
		expect(() => tileLayout(7)).toThrow(/no status tile layout for 7/)
	})

	for (const n of [4, 6, APP_STATES.length]) {
		describe(`${n} tiles`, () => {
			const l = tileLayout(n)
			const tiles = Array.from({ length: n }, (_, i) => tileBorders(n, i).split(' '))

			it('fills every narrow row and lists both column counts as literal classes', () => {
				expect(n % l.cols).toBe(0)
				expect(l.cols).toBeGreaterThan(1)
				expect(l.grid.split(' ')).toContain(`grid-cols-${l.cols}`)
				expect(l.grid).toMatch(new RegExp(`(^| )[a-z0-9]+:grid-cols-${n}( |$)`))
			})

			it('narrow: vertical dividers only between tiles, a top divider only on later rows', () => {
				tiles.forEach((c, i) => {
					expect(c.includes('border-l'), `tile ${i} left`).toBe(i % l.cols !== 0)
					expect(c.includes('border-t'), `tile ${i} top`).toBe(i >= l.cols)
				})
			})

			it('one row: a divider left of every tile but the first, no top dividers', () => {
				tiles.forEach((c, i) => {
					const left = c.includes('border-l') || c.includes(l.wideLeft)
					expect(left, `tile ${i} left`).toBe(i > 0)
					expect(!c.includes('border-t') || c.includes(l.wideNoTop), `tile ${i} top`).toBe(true)
				})
			})
		})
	}
})
