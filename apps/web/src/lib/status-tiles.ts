// Grid for a strip of status counters (the apps page summary and the landing page
// demo). Narrow: an even grid of `cols` columns. From the `wide` breakpoint: every
// tile in one row. Dividers sit only between tiles, never on the outer edges, and
// rows are split by a horizontal divider.
//
// Tailwind only generates classes it finds as literal strings in the source, so a
// column count cannot be built at runtime. Each supported tile count therefore has
// its own entry here with literal class names. A count with no entry throws, and a
// unit test checks that every counter strip's count has one.

export interface TileLayout {
	// Columns below the wide breakpoint. Must divide the tile count, so no row is short.
	cols: number
	// Container grid classes: narrow columns plus the one-row columns at the breakpoint.
	grid: string
	// At the breakpoint: the left divider for a tile that starts a narrow row,
	// and the reset of the top divider for a tile in a later narrow row.
	wideLeft: string
	wideNoTop: string
}

const TILE_LAYOUTS: Readonly<Record<number, TileLayout>> = {
	// Landing page demo: 2 by 2, one row from sm.
	4: { cols: 2, grid: 'grid-cols-2 sm:grid-cols-4', wideLeft: 'sm:border-l', wideNoTop: 'sm:border-t-0' },
	// Apps page: 3 by 2, one row only where six tiles and the deploy summary both fit.
	6: {
		cols: 3,
		grid: 'grid-cols-3 2xl:grid-cols-6',
		wideLeft: '2xl:border-l',
		wideNoTop: '2xl:border-t-0',
	},
}

export function hasTileLayout(count: number): boolean {
	return TILE_LAYOUTS[count] !== undefined
}

export function tileLayout(count: number): TileLayout {
	const l = TILE_LAYOUTS[count]
	if (!l) throw new Error(`no status tile layout for ${count} tiles: add one to lib/status-tiles.ts`)
	return l
}

// Border classes for tile `i` of `count`.
export function tileBorders(count: number, i: number): string {
	const l = tileLayout(count)
	const startsRow = i % l.cols === 0
	const laterRow = i >= l.cols
	const out = ['border-border']
	if (!startsRow) out.push('border-l')
	else if (i > 0) out.push(l.wideLeft)
	if (laterRow) out.push('border-t', l.wideNoTop)
	return out.join(' ')
}
