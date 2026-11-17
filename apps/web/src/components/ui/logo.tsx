import { cn } from '@/lib/cn'
import {
	BRAND,
	MARK,
	MARK_SMALL,
	WORDMARK_LETTERS,
	WORDMARK_O,
	WORDMARK_VIEWBOX,
	ringPath,
} from './logo-geometry'

// The powder logo, "Escape" (brand/, geometry in logo-geometry.ts): the o of
// powder is a cyan charge ring with a gap, and its spark has got out. The
// wordmark is outlined Geist Bold, so it renders the same everywhere.
//
// variant "glow": the dark public site and login. Letters in currentColor,
// cyan ring with a neon halo, white spark.
// variant "tile" (default): the dashboard, light and dark. Flat; ring in a
// darker cyan on light (5.1:1 on #fafafa) and the brand cyan on dark.
// PowderMark is the ring + spark alone; tile puts it on the dark app-icon tile.

type Variant = 'glow' | 'tile'

function Ring({
	spec,
	ringClass,
	sparkClass,
	glow,
}: {
	spec: typeof MARK
	ringClass: string
	sparkClass: string
	/** id of the GlowDef filter to draw a halo with */
	glow?: string
}) {
	const d = ringPath(spec)
	return (
		<>
			{glow && (
				<path
					d={d}
					fill="none"
					stroke={BRAND.cyan}
					strokeWidth={spec.stroke}
					opacity="0.75"
					filter={`url(#${glow})`}
				/>
			)}
			{glow && (
				<circle
					cx={spec.sparkX}
					cy={spec.sparkY}
					r={spec.sparkR}
					fill={BRAND.cyan}
					filter={`url(#${glow})`}
				/>
			)}
			<path d={d} fill="none" strokeWidth={spec.stroke} className={ringClass} />
			<circle cx={spec.sparkX} cy={spec.sparkY} r={spec.sparkR} className={sparkClass} />
		</>
	)
}

// Static ids, one per blur: every copy on a page defines the same filter
// under the same id, so a duplicate id resolves to an identical definition.
const GLOW_MARK = 'powder-glow-mark'
const GLOW_WORD = 'powder-glow-word'
const GlowDef = ({ id, blur }: { id: string; blur: number }) => (
	<defs>
		<filter id={id} x="-50%" y="-50%" width="200%" height="200%">
			<feGaussianBlur stdDeviation={blur} />
		</filter>
	</defs>
)

const FLAT_RING = 'stroke-[#0e7490] dark:stroke-[#3ee6ff]'
const FLAT_SPARK = 'fill-[#0e7490] dark:fill-white'
const LIT_RING = 'stroke-[#3ee6ff]'
const LIT_SPARK = 'fill-white'

export function PowderMark({
	size = 24,
	variant = 'tile',
	className,
}: {
	size?: number
	variant?: Variant
	className?: string
}) {
	const spec = size < 24 ? MARK_SMALL : MARK
	if (variant === 'glow') {
		return (
			<svg
				viewBox="0 0 64 64"
				width={size}
				height={size}
				aria-hidden="true"
				className={cn('shrink-0 overflow-visible', className)}
			>
				<GlowDef id={GLOW_MARK} blur={2.2} />
				<Ring spec={spec} ringClass={LIT_RING} sparkClass={LIT_SPARK} glow={GLOW_MARK} />
			</svg>
		)
	}
	return (
		<svg
			viewBox="0 0 64 64"
			width={size}
			height={size}
			aria-hidden="true"
			className={cn('shrink-0', className)}
		>
			<rect width="64" height="64" rx="14" fill={BRAND.bg} />
			<rect
				x="0.75"
				y="0.75"
				width="62.5"
				height="62.5"
				rx="13.25"
				fill="none"
				stroke={BRAND.cyan}
				strokeOpacity="0.22"
				strokeWidth="1.5"
			/>
			<g transform="translate(7 7) scale(0.78125)">
				<Ring spec={spec} ringClass={LIT_RING} sparkClass={LIT_SPARK} />
			</g>
		</svg>
	)
}

/**
 * The powder wordmark. `size` is the em size in px (the wordmark is about
 * 3.5 em wide and 0.9 em tall), so size={26} sits like 26px bold text.
 * `mark` renders the ring + spark alone instead (PowderMark at that size).
 */
export function Logo({
	size = 26,
	variant = 'tile',
	mark = false,
	className,
}: {
	size?: number
	variant?: Variant
	mark?: boolean
	className?: string
}) {
	if (mark) return <PowderMark size={size} variant={variant} className={className} />
	const vb = WORDMARK_VIEWBOX
	const h = (size * vb.height) / 100
	const w = (size * vb.width) / 100
	const glow = variant === 'glow'
	return (
		<svg
			viewBox={`${vb.x} ${vb.y} ${vb.width} ${vb.height}`}
			width={Number(w.toFixed(1))}
			height={Number(h.toFixed(1))}
			role="img"
			aria-label="powder"
			className={cn('shrink-0 overflow-visible', className)}
		>
			{glow && <GlowDef id={GLOW_WORD} blur={3.2} />}
			<path d={WORDMARK_LETTERS} fill="currentColor" />
			<Ring
				spec={WORDMARK_O}
				ringClass={glow ? LIT_RING : FLAT_RING}
				sparkClass={glow ? LIT_SPARK : FLAT_SPARK}
				glow={glow ? GLOW_WORD : undefined}
			/>
		</svg>
	)
}
