// Open Graph / Twitter card renderer (1200x630) in the live wire brand: dark
// page, the glowing "p." mark, Geist 800 headline with the lit phrase, and the
// cyan wire running into a "live" pill. Used by app/opengraph-image.tsx,
// app/twitter-image.tsx and the docs cards. Cards are prerendered at build (no
// request data), so the font reads happen then.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
	WORDMARK_LETTERS,
	WORDMARK_O,
	WORDMARK_VIEWBOX,
	ringPath,
} from '@/components/ui/logo-geometry'
import { ImageResponse } from 'next/og'

export const OG_SIZE = { width: 1200, height: 630 }
export const OG_CONTENT_TYPE = 'image/png'
export const HERO_LINE = 'Push to deploy on servers you own.'

const BG = '#05070c'
const TEXT = '#eef6ff'
const MUTED = '#95a3b6'
const CYAN = '#3ee6ff'
const LIT = '#dffaff'
const LINE = '#243042'
const GLOW =
	'0 0 6px rgba(62,230,255,.55), 0 0 28px rgba(62,230,255,.45), 0 0 70px rgba(62,230,255,.25)'

async function font(file: string) {
	return readFile(join(process.cwd(), 'src', 'app', 'fonts', file))
}

// The Escape wordmark, drawn with explicit colours (no classes in next/og).
// `size` is the em size in px.
function Wordmark({ size }: { size: number }) {
	const vb = WORDMARK_VIEWBOX
	const o = WORDMARK_O
	const d = ringPath(o)
	return (
		<svg
			width={(size * vb.width) / 100}
			height={(size * vb.height) / 100}
			viewBox={`${vb.x} ${vb.y} ${vb.width} ${vb.height}`}
			aria-hidden="true"
			style={{ overflow: 'visible' }}
		>
			<defs>
				<filter id="g" x="-50%" y="-50%" width="200%" height="200%">
					<feGaussianBlur stdDeviation="3.2" />
				</filter>
			</defs>
			<path d={WORDMARK_LETTERS} fill={TEXT} />
			<path
				d={d}
				fill="none"
				stroke={CYAN}
				strokeWidth={o.stroke}
				opacity="0.75"
				filter="url(#g)"
			/>
			<circle cx={o.sparkX} cy={o.sparkY} r={o.sparkR} fill={CYAN} filter="url(#g)" />
			<path d={d} fill="none" stroke={CYAN} strokeWidth={o.stroke} />
			<circle cx={o.sparkX} cy={o.sparkY} r={o.sparkR} fill="#ffffff" />
		</svg>
	)
}

export async function renderCard(opts: {
	title: string
	eyebrow?: string
	sub?: string
}): Promise<ImageResponse> {
	const [display, body, mono] = await Promise.all([
		font('Geist-ExtraBold.ttf'),
		font('Geist-Regular.ttf'),
		font('GeistMono-Medium.ttf'),
	])
	const long = opts.title.length > 40
	// The hero line lights "you own." like the site; other titles stay plain.
	// One span per word so the lines break between words and the lit words
	// carry their own glow.
	const words = opts.title.split(' ')
	const litFrom = opts.title.endsWith(' you own.') ? words.length - 2 : words.length
	return new ImageResponse(
		<div
			style={{
				width: '100%',
				height: '100%',
				display: 'flex',
				flexDirection: 'column',
				justifyContent: 'space-between',
				padding: '60px 72px',
				background: `radial-gradient(ellipse 70% 45% at 50% -12%, rgba(62,230,255,.11) 0%, ${BG} 72%)`,
				backgroundColor: BG,
				color: TEXT,
				fontFamily: 'Geist',
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center' }}>
				<Wordmark size={64} />
			</div>

			<div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
				{opts.eyebrow && (
					<div
						style={{
							fontFamily: 'GeistMono',
							fontSize: 24,
							color: CYAN,
							textTransform: 'uppercase',
							letterSpacing: 2.4,
						}}
					>
						{opts.eyebrow}
					</div>
				)}
				<div
					style={{
						display: 'flex',
						flexWrap: 'wrap',
						fontFamily: 'GeistX',
						fontSize: long ? 76 : 100,
						lineHeight: 0.98,
						letterSpacing: long ? -3.6 : -5,
						maxWidth: 1040,
					}}
				>
					{words.map((w, i) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: words of a fixed title, order never changes
							key={i}
							style={{
								marginRight: i < words.length - 1 ? '0.2em' : 0,
								...(i >= litFrom ? { color: LIT, textShadow: GLOW } : {}),
							}}
						>
							{w}
						</span>
					))}
				</div>
				{opts.sub && (
					<div style={{ fontSize: 29, color: MUTED, maxWidth: 960, lineHeight: 1.4 }}>
						{opts.sub}
					</div>
				)}
			</div>

			<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
				<div style={{ display: 'flex', alignItems: 'center' }}>
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 14,
							border: `1px solid ${LINE}`,
							borderTop: `1px solid ${CYAN}`,
							background: '#0a0e16',
							borderRadius: 14,
							padding: '14px 22px',
							fontFamily: 'GeistMono',
							fontSize: 24,
							color: TEXT,
							boxShadow: '0 -12px 40px -18px rgba(62,230,255,.6)',
						}}
					>
						<span style={{ color: MUTED }}>$</span>
						<span>git push</span>
					</div>
					{/* the wire, with its spark, into "live" */}
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							width: 120,
							height: 2,
							background: `linear-gradient(90deg, rgba(62,230,255,0), ${CYAN})`,
							boxShadow: '0 0 12px rgba(62,230,255,.6)',
						}}
					/>
					<div
						style={{
							width: 12,
							height: 12,
							borderRadius: 6,
							background: '#ffffff',
							boxShadow: `0 0 6px #fff, 0 0 18px ${CYAN}, 0 0 40px ${CYAN}`,
						}}
					/>
					<div
						style={{
							display: 'flex',
							marginLeft: 16,
							fontFamily: 'GeistMono',
							fontSize: 24,
							color: CYAN,
							textShadow: '0 0 14px rgba(62,230,255,.7)',
						}}
					>
						live
					</div>
				</div>
				<div style={{ fontFamily: 'GeistMono', fontSize: 22, color: MUTED }}>
					powder.sh · open source, AGPL-3.0-or-later
				</div>
			</div>
		</div>,
		{
			...OG_SIZE,
			fonts: [
				{ name: 'GeistX', data: display, weight: 800, style: 'normal' },
				{ name: 'Geist', data: body, weight: 400, style: 'normal' },
				{ name: 'GeistMono', data: mono, weight: 500, style: 'normal' },
			],
		},
	)
}
