// powder logo geometry, "Escape": the o of powder is a charge ring with a gap,
// and its spark has already got out through it. One source for the React logo,
// the OG cards and the generated icons (brand/, app/icon.svg, public/icon-*).
//
// Wordmark: Geist Bold "powder", outlined, custom-kerned (tracking -3.6/100,
// pairs po -0.6, ow -1.6, wd -1.0, er +0.6), baseline at y=73, units are
// 1/100 em. The o is drawn, not set: ring outer radius 28 (x-height/2 = 26.8,
// so it overshoots like a real o), stroke 14.6 = Geist Bold bowl weight, butt
// ends to match Geist's flat terminals.
//
// Mark: the same ring and spark, fit to a 64 grid. Below 24px a dedicated
// heavier drawing: thicker ring, narrower gap, bigger spark tucked closer, so
// it stays "o with an escaping spark" rather than "C plus dot".

/** p, w, d, e, r of the wordmark as one path (the o is drawn separately). */
export const WORDMARK_LETTERS =
	'M0 88V19.4H14.4L14.7 30.7L13.5 30.2Q15.5 24.4 20 21.3Q24.5 18.2 30.5 18.2Q38 18.2 43 21.9Q48 25.6 50.55 31.95Q53.1 38.3 53.1 46.2Q53.1 54 50.55 60.4Q48 66.8 42.95 70.5Q37.9 74.2 30.4 74.2Q26.5 74.2 23.1 72.75Q19.7 71.3 17.25 68.7Q14.8 66.1 13.7 62.5L15 61.7V88ZM26.3 62.7Q31.6 62.7 34.65 58.3Q37.7 53.9 37.7 46.2Q37.7 38.5 34.65 34.1Q31.6 29.7 26.3 29.7Q22.8 29.7 20.25 31.55Q17.7 33.4 16.35 37.1Q15 40.8 15 46.2Q15 51.6 16.35 55.3Q17.7 59 20.25 60.85Q22.8 62.7 26.3 62.7ZM127.2 73 111.3 19.4H126.4L135.6 55.7L145.5 19.4H157.7L167.6 55.7L176.9 19.4H192L176.1 73H161.5L151.6 39.5L141.7 73ZM215.2 74.2Q208.4 74.2 203.45 70.75Q198.5 67.3 195.85 61.05Q193.2 54.8 193.2 46.2Q193.2 37.6 195.9 31.35Q198.6 25.1 203.55 21.65Q208.5 18.2 215.2 18.2Q220.9 18.2 225.05 20.55Q229.2 22.9 231.3 27V2H246.3V73H232L231.7 65.1Q229.5 69.4 225.15 71.8Q220.8 74.2 215.2 74.2ZM220.1 62.7Q223.7 62.7 226.2 60.8Q228.7 58.9 230 55.25Q231.3 51.6 231.3 46.2Q231.3 40.7 230 37.05Q228.7 33.4 226.2 31.55Q223.7 29.7 220.1 29.7Q214.8 29.7 211.7 34.15Q208.6 38.6 208.6 46.2Q208.6 53.7 211.75 58.2Q214.9 62.7 220.1 62.7ZM280 74.2Q271.8 74.2 265.75 70.75Q259.7 67.3 256.35 61Q253 54.7 253 46.2Q253 37.7 256.35 31.45Q259.7 25.2 265.7 21.7Q271.7 18.2 279.9 18.2Q287.9 18.2 293.8 21.7Q299.7 25.2 302.95 31.7Q306.2 38.2 306.2 47.2V50.2H268.5Q268.8 56.6 271.95 59.7Q275.1 62.8 280.3 62.8Q284.1 62.8 286.65 61.2Q289.2 59.6 290.3 56.3L305.4 57.2Q303.3 65.2 296.5 69.7Q289.7 74.2 280 74.2ZM268.5 41H290.8Q290.5 35.1 287.55 32.2Q284.6 29.3 279.9 29.3Q275.2 29.3 272.15 32.35Q269.1 35.4 268.5 41ZM313.4 73V19.4H327.6L328.1 35L327 34.7Q328.3 26.6 331.6 23Q334.9 19.4 340.7 19.4H345.6V31.8H340.7Q336.5 31.8 333.8 32.9Q331.1 34 329.75 36.4Q328.4 38.8 328.4 42.9V73Z'

export const WORDMARK_VIEWBOX = { x: 0, y: -2, width: 346, height: 92 }

type RingSpec = {
	cx: number
	cy: number
	/** ring centre-line radius */
	r: number
	stroke: number
	/** gap, degrees clockwise from 3 o'clock (svg coordinates) */
	gapFrom: number
	gapTo: number
	sparkX: number
	sparkY: number
	sparkR: number
}

const rad = (a: number) => (a * Math.PI) / 180
const n = (v: number) => Number(v.toFixed(2))

/** Ring arc path: runs clockwise from the end of the gap round to its start. */
export function ringPath(s: RingSpec): string {
	const x0 = n(s.cx + s.r * Math.cos(rad(s.gapTo)))
	const y0 = n(s.cy + s.r * Math.sin(rad(s.gapTo)))
	const x1 = n(s.cx + s.r * Math.cos(rad(s.gapFrom)))
	const y1 = n(s.cy + s.r * Math.sin(rad(s.gapFrom)))
	return `M${x0} ${y0}A${s.r} ${s.r} 0 1 1 ${x1} ${y1}`
}

// The o in "o units": centre at 0,0, outer radius 28.
type OSpec = { stroke: number; gap: number; sparkDist: number; sparkR: number }
const BISECTOR = -58 // the spark leaves at about 1 o'clock, clear of the w
const O_LARGE: OSpec = { stroke: 14.6, gap: 44, sparkDist: 45, sparkR: 7.2 }
const O_SMALL: OSpec = { stroke: 18, gap: 38, sparkDist: 40, sparkR: 9.4 }

function place(o: OSpec, k: number, cx: number, cy: number): RingSpec {
	const sd = o.sparkDist * k
	return {
		cx: n(cx),
		cy: n(cy),
		r: n((28 - o.stroke / 2) * k),
		stroke: n(o.stroke * k),
		gapFrom: BISECTOR - o.gap / 2,
		gapTo: BISECTOR + o.gap / 2,
		sparkX: n(cx + sd * Math.cos(rad(BISECTOR))),
		sparkY: n(cy + sd * Math.sin(rad(BISECTOR))),
		sparkR: n(o.sparkR * k),
	}
}

// Fit ring + spark into a 64-unit square with `pad` on the tight side, centred.
function fit(o: OSpec, pad: number): RingSpec {
	const top = o.sparkDist * Math.sin(rad(-BISECTOR)) + o.sparkR
	const right = Math.max(28, o.sparkDist * Math.cos(rad(BISECTOR)) + o.sparkR)
	const h = top + 28
	const w = right + 28
	const k = (64 - 2 * pad) / Math.max(h, w)
	return place(o, k, 32 - ((right - 28) / 2) * k, 32 + ((top - 28) / 2) * k)
}

/** The o inside the wordmark (wordmark units). */
export const WORDMARK_O = place(O_LARGE, 1, 83.5, 46.2)
/** Mark on the 64 grid, 24px and up. */
export const MARK = fit(O_LARGE, 2)
/** Mark on the 64 grid, under 24px (favicons, small chrome). */
export const MARK_SMALL = fit(O_SMALL, 1)

export const BRAND = {
	bg: '#05070c',
	cyan: '#3ee6ff',
	spark: '#ffffff',
	text: '#eef6ff',
	/** cyan for light backgrounds: 5.1:1 on #fafafa */
	cyanInk: '#0e7490',
} as const
