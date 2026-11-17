'use client'

// Hero terminal: replays one deploy, from `git push` through the real stage
// banners in lib/deploy/script.ts (preflight, build, test gate, swap gate,
// db migrate, release, swap-check, compose up, health check, tag) to live.
// Timings are a typical deploy (3m 31s end to end), replayed fast. Every
// line is in the DOM from the first paint and only fades in, so nothing
// shifts. Reduced motion (and no JS) shows the finished log.

import { RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

type Line = {
	t: number
	stage?: string
	text: string
	kind?: 'cmd' | 'dim' | 'live'
	/** While the clock is between `from` and `t`, this slot shows build progress. */
	from?: number
}

const TOTAL = 211

/** 211 -> "3m 31s". */
function formatDeploySeconds(sec: number): string {
	const m = Math.floor(sec / 60)
	const s = Math.round(sec % 60)
	return m > 0 ? `${m}m ${s}s` : `${s}s`
}
const PLAY_MS = 8000
// The first lines (push, queue, preflight, build start) are in the server
// render, so the panel never opens mostly empty; the replay continues from there.
const START = 4
const SPEED = Math.round((TOTAL * 1000) / PLAY_MS)

const LINES: Line[] = [
	{ t: 0, kind: 'cmd', text: 'git push origin main' },
	{ t: 1, kind: 'dim', text: 'powder: deploy queued for blog' },
	{ t: 2, stage: 'preflight', text: 'docker ok, 38 GB free' },
	{ t: 4, stage: 'build', text: 'building on this server' },
	{ t: 146, kind: 'dim', text: 'image built in 2m 22s', from: 5 },
	{ t: 147, stage: 'test gate', text: '.powder/test.sh passed' },
	{ t: 178, stage: 'swap gate', text: 'no newer push waiting, go' },
	{ t: 179, stage: 'db migrate', text: '1 migration applied' },
	{ t: 182, stage: 'release', text: 'no release cmd, skip' },
	{ t: 183, stage: 'swap-check', text: 'candidate HTTP 200' },
	{ t: 189, stage: 'compose up', text: 'blog recreated' },
	{ t: 197, stage: 'health check', text: 'HTTP 200 in 1.2s' },
	{ t: 209, stage: 'tag', text: 'blog:deploy-k3x9a2f' },
	{ t: TOTAL, kind: 'live', text: `live in ${formatDeploySeconds(TOTAL)}` },
]

// Shown in the build line's slot while the build runs, so the long stage reads as work.
const BUILD_STEPS = [
	'FROM node:22-alpine',
	'COPY package.json pnpm-lock.yaml',
	'RUN pnpm install --frozen-lockfile',
	'COPY . .',
	'RUN pnpm build',
	'COPY --from=build /app/.next',
	'exporting layers',
]

function buildProgress(l: Line, elapsed: number): string | null {
	if (l.from === undefined || elapsed < l.from || elapsed >= l.t) return null
	const f = (elapsed - l.from) / (l.t - l.from)
	const i = Math.min(BUILD_STEPS.length - 1, Math.floor(f * BUILD_STEPS.length))
	return `[${i + 1}/${BUILD_STEPS.length}] ${BUILD_STEPS[i]}`
}

function clock(sec: number): string {
	const s = Math.min(Math.floor(sec), TOTAL)
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function DeployReplay() {
	// Seconds of the deploy shown so far. START on the server render (CSS shows
	// all lines under reduced motion, and the noscript rule does the same
	// without JS).
	const [elapsed, setElapsed] = useState(START)
	const [playing, setPlaying] = useState(false)
	const ref = useRef<HTMLDivElement>(null)
	const raf = useRef<number | null>(null)

	const play = useCallback(() => {
		if (raf.current) cancelAnimationFrame(raf.current)
		const start = performance.now()
		setPlaying(true)
		const tick = (now: number) => {
			const sec = START + ((now - start) * SPEED) / 1000
			if (sec >= TOTAL) {
				setElapsed(TOTAL)
				setPlaying(false)
				raf.current = null
				return
			}
			setElapsed(sec)
			raf.current = requestAnimationFrame(tick)
		}
		setElapsed(START)
		raf.current = requestAnimationFrame(tick)
	}, [])

	useEffect(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			setElapsed(TOTAL)
			return
		}
		const el = ref.current
		if (!el || typeof IntersectionObserver === 'undefined') {
			play()
			return
		}
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					io.disconnect()
					play()
				}
			},
			{ threshold: 0.35 },
		)
		io.observe(el)
		return () => {
			io.disconnect()
			if (raf.current) cancelAnimationFrame(raf.current)
		}
	}, [play])

	const done = elapsed >= TOTAL
	const current = [...LINES].reverse().find((l) => l.stage && l.t <= elapsed)

	return (
		<div
			ref={ref}
			className="wire-panel overflow-hidden rounded-[14px] border border-border-strong bg-card text-left"
		>
			<noscript>
				<style>{'.replay-line{opacity:1;transform:none}'}</style>
			</noscript>
			<div className="relative flex items-center gap-3 border-b border-border px-4 py-3 font-mono text-xs font-medium">
				<span className="min-w-0 flex-1 truncate text-muted-foreground">
					blog.example.com · main · a1b2c3d
				</span>
				<span
					className={`inline-flex shrink-0 items-center gap-2 tabular-nums ${done ? 'text-signal' : 'text-muted-foreground'}`}
					aria-hidden="true"
				>
					{done && <span className="wire-dot h-1.5 w-1.5 rounded-full" />}
					{done
						? `live ${clock(TOTAL)}`
						: playing
							? `${clock(elapsed)} · ${current?.stage ?? 'push'}`
							: '0:00'}
				</span>
				<span
					aria-hidden="true"
					className="absolute inset-x-0 bottom-0 h-px origin-left bg-signal shadow-[0_0_8px_rgb(62_230_255/0.7)]"
					style={{ transform: `scaleX(${elapsed / TOTAL})` }}
				/>
			</div>
			<div className="px-4 py-4 font-mono text-[0.75rem] leading-[1.8] text-foreground sm:px-6 sm:py-5 sm:text-[0.875rem]">
				{LINES.map((l) => {
					const progress = buildProgress(l, elapsed)
					return (
						<div
							key={`${l.t}-${l.text}`}
							data-on={l.t <= elapsed || progress !== null}
							className="replay-line flex gap-3 whitespace-nowrap"
						>
							<span className="w-[3.2em] shrink-0 tabular-nums text-[#7f8ca1]">
								{clock(progress ? elapsed : l.t)}
							</span>
							{l.kind === 'cmd' ? (
								<span className="truncate font-medium text-foreground">
									<span className="text-muted-foreground">$ </span>
									{l.text}
								</span>
							) : l.kind === 'live' ? (
								<span className="flex min-w-0 items-center gap-2 font-semibold text-signal [text-shadow:0_0_14px_rgb(62_230_255/0.7)]">
									<span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
										{done && (
											<span className="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-signal opacity-60 [animation-iteration-count:3]" />
										)}
										<span className="wire-dot relative inline-flex h-2 w-2 rounded-full" />
									</span>
									<span className="truncate">{l.text}</span>
								</span>
							) : l.kind === 'dim' ? (
								<span className="truncate text-muted-foreground">{progress ?? l.text}</span>
							) : (
								<span className="flex min-w-0 gap-3">
									<span className="w-[12ch] shrink-0 font-medium text-info">{l.stage}</span>
									<span className="truncate">{l.text}</span>
								</span>
							)}
						</div>
					)
				})}
			</div>
			<div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 font-mono text-2xs text-muted-foreground">
				<span className="truncate">A typical deploy, replayed at {SPEED}x</span>
				<button
					type="button"
					onClick={play}
					className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-foreground transition-colors hover:text-signal ${done ? '' : 'invisible'}`}
				>
					<RotateCcw className="h-3 w-3" aria-hidden="true" />
					Replay
				</button>
			</div>
		</div>
	)
}
