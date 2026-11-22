'use client'

// Landing "The dashboard": two working recreations of dashboard views with
// sample data, no API calls. The apps list (status filter, expandable rows,
// one app redeploying on a loop) and a failed deploy whose redeploy and roll
// back buttons replay a plausible outcome. Both share billing-worker's state,
// so a roll back in the deploy view turns its row live in the list.
// Reduced motion: nothing loops and outcomes land at once; every control
// still works. Uses the dashboard's own pieces (StatusLabel, Badge,
// DeployStrip, button variants) so it looks like the product.

import { DeployBars, DeployStrip } from '@/components/deploy-strip'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button-variants'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot, StatusLabel, type StatusTone } from '@/components/ui/status'
import { cn } from '@/lib/cn'
import type { DeployDay } from '@/lib/deploy-days'
import { tileBorders, tileLayout } from '@/lib/status-tiles'
import {
	ArrowDown,
	ChevronDown,
	ChevronRight,
	RefreshCw,
	RotateCcw,
	TriangleAlert,
	Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

// ---------------------------------------------------------------- shared

type Status = 'live' | 'deploying' | 'failed' | 'down'
const STATUSES: Status[] = ['live', 'deploying', 'failed', 'down']
const TONE: Record<Status, StatusTone> = {
	live: 'success',
	deploying: 'warning',
	failed: 'destructive',
	down: 'destructive',
}

/** billing-worker, driven by the deploy view's buttons. */
type Billing = 'failed' | 'rolling-back' | 'redeploying' | 'rolled-back' | 'redeployed'

function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(false)
	useEffect(() => {
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
		setReduced(mq.matches)
		const on = () => setReduced(mq.matches)
		mq.addEventListener('change', on)
		return () => mq.removeEventListener('change', on)
	}, [])
	return reduced
}

function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
	const ref = useRef<T>(null)
	const [inView, setInView] = useState(false)
	useEffect(() => {
		const el = ref.current
		if (!el || typeof IntersectionObserver === 'undefined') {
			setInView(true)
			return
		}
		const io = new IntersectionObserver((e) => setInView(e.some((x) => x.isIntersecting)), {
			threshold: 0.2,
		})
		io.observe(el)
		return () => io.disconnect()
	}, [])
	return [ref, inView]
}

// The window chrome both panels share with the hero replay.
function Frame({
	path,
	children,
	className,
}: {
	path: string
	children: React.ReactNode
	className?: string
}) {
	return (
		<div
			className={cn(
				'overflow-hidden rounded-[14px] border border-border-strong bg-card text-left shadow-[0_30px_80px_-30px_rgb(0_0_0/0.9),0_0_0_1px_rgb(62_230_255/0.06)]',
				className,
			)}
		>
			<div className="flex items-center gap-3 border-b border-border px-4 py-2.5 font-mono text-xs text-muted-foreground">
				<span className="flex shrink-0 gap-1.5" aria-hidden="true">
					<span className="h-2 w-2 rounded-full bg-border-strong" />
					<span className="h-2 w-2 rounded-full bg-border-strong" />
					<span className="h-2 w-2 rounded-full bg-border-strong" />
				</span>
				<span className="min-w-0 flex-1 truncate">{path}</span>
				<span className="shrink-0 text-2xs">sample data</span>
			</div>
			{children}
		</div>
	)
}

// ------------------------------------------------------------- apps list

// 30 days, one char per day: . none, 1-3 ok, f failed, m mixed.
const DAY0 = Date.UTC(2026, 9, 17)
function days(pattern: string): DeployDay[] {
	return [...pattern.padEnd(30, '.').slice(0, 30)].map((c, i) => ({
		day: new Date(DAY0 + i * 86_400_000).toISOString().slice(0, 10),
		ok: c === 'm' ? 1 : c === '.' || c === 'f' ? 0 : Number(c),
		failed: c === 'f' || c === 'm' ? 1 : 0,
	}))
}

type Commit = { sha: string; msg: string; ago: string; tone: StatusTone }

type AppRow = {
	name: string
	domain: string | null
	server: string
	status: Status
	pulse?: boolean
	sha: string
	branch: string
	when: string
	note?: string
	days: DeployDay[]
	commits: Commit[]
}

// acme-api redeploys on a loop: CYCLE ticks of one second, live first.
const CYCLE = 11
const LIVE_TICKS = 5
const ACME_STAGES = ['queued', 'preflight', 'build', 'build', 'build', 'health check']
const ACME_COMMITS = [
	{ sha: '298e45c', msg: 'rate limit per token' },
	{ sha: 'b71c0aa', msg: 'add /v2/invoices' },
	{ sha: 'e03f5d9', msg: 'log slow queries' },
	{ sha: '6d2a1fe', msg: 'retry stripe webhooks once' },
]

function buildApps(tick: number, billing: Billing): AppRow[] {
	const cycle = Math.floor(tick / CYCLE)
	const phase = tick % CYCLE
	const acmeDeploying = phase >= LIVE_TICKS
	const liveIdx = cycle % ACME_COMMITS.length
	const nextIdx = (cycle + 1) % ACME_COMMITS.length
	const acmeSha = ACME_COMMITS[acmeDeploying ? nextIdx : liveIdx]
	const acmeHistory: Commit[] = [0, 1, 2].map((k) => {
		const c = ACME_COMMITS[(liveIdx - k + ACME_COMMITS.length * 4) % ACME_COMMITS.length]
		return {
			...c,
			ago: k === 0 ? (cycle > 0 ? 'just now' : '52m ago') : `${k * 3}h ago`,
			tone: 'success',
		}
	})
	if (acmeDeploying)
		acmeHistory.unshift({ ...ACME_COMMITS[nextIdx], ago: 'building', tone: 'warning' })

	const billingCommits: Commit[] = [
		{ sha: 'ba7464a', msg: 'invoices: sum with tax', ago: '1h ago', tone: 'destructive' },
		{ sha: '08a8548', msg: 'retry webhook on 502', ago: '1d ago', tone: 'success' },
		{ sha: 'f19c3b2', msg: 'queue: batch of 50', ago: '3d ago', tone: 'success' },
	]
	if (billing === 'redeploying' || billing === 'redeployed')
		billingCommits.unshift({
			sha: 'c41d9e2',
			msg: 'fix: invoice.amount, not total',
			ago: billing === 'redeployed' ? 'just now' : 'building',
			tone: billing === 'redeployed' ? 'success' : 'warning',
		})
	const billingRow: AppRow = {
		name: 'billing-worker',
		domain: null,
		server: 'prod-eu-2',
		branch: 'main',
		status:
			billing === 'failed'
				? 'failed'
				: billing === 'rolling-back' || billing === 'redeploying'
					? 'deploying'
					: 'live',
		pulse: billing === 'rolling-back' || billing === 'redeploying',
		sha:
			billing === 'failed'
				? 'ba7464a'
				: billing === 'redeploying' || billing === 'redeployed'
					? 'c41d9e2'
					: '08a8548',
		when:
			billing === 'failed'
				? '1h ago · build failed'
				: billing === 'rolling-back'
					? 'rolling back'
					: billing === 'redeploying'
						? 'building'
						: billing === 'rolled-back'
							? 'just now · roll back'
							: 'just now · took 2m 38s',
		note:
			billing === 'failed'
				? 'build failed, 08a8548 still serving'
				: billing === 'rolled-back'
					? 'rolled back to 08a8548, nothing rebuilt'
					: undefined,
		days: days(
			`..1....1..2...1....1.1...1..${billing === 'failed' || billing === 'rolling-back' || billing === 'redeploying' ? '1f' : '1m'}`,
		),
		commits: billingCommits,
	}

	return [
		billingRow,
		{
			name: 'docs-site',
			domain: 'docs.example.com',
			server: 'prod-eu-2',
			status: 'down',
			sha: '3fa55c2',
			branch: 'main',
			when: '2h ago · took 1m 12s',
			note: 'health check: HTTP 502 for 4 min',
			days: days('1.....1......2.....1....1..1.'.padEnd(30, '.')),
			commits: [
				{ sha: '3fa55c2', msg: 'quickstart: new install flow', ago: '2h ago', tone: 'success' },
				{ sha: '91be04d', msg: 'search: index code blocks', ago: '2d ago', tone: 'success' },
				{ sha: 'a7d3e10', msg: 'fix broken anchor links', ago: '5d ago', tone: 'success' },
			],
		},
		{
			name: 'acme-api',
			domain: 'api.example.com',
			server: 'prod-eu-1',
			status: acmeDeploying ? 'deploying' : 'live',
			pulse: acmeDeploying,
			sha: acmeSha.sha,
			branch: 'main',
			when: acmeDeploying
				? `${ACME_STAGES[phase - LIVE_TICKS]} · 0:${String((phase - LIVE_TICKS) * 24).padStart(2, '0')}`
				: cycle > 0
					? 'just now · took 2m 11s'
					: '52m ago · took 2m 4s',
			days: days(`1.2..1.21..3.1..2.1.21..1.2.${1 + Math.min(cycle, 2)}`.padStart(30, '.')),
			commits: acmeHistory.slice(0, 3),
		},
		{
			name: 'storefront',
			domain: 'shop.example.com',
			server: 'prod-eu-1',
			status: 'live',
			sha: '257f077',
			branch: 'main',
			when: '3h ago · took 2m 0s',
			days: days('.1..1.1...1..2..1...1.m..1..1.'),
			commits: [
				{ sha: '257f077', msg: 'checkout: show tax per line', ago: '3h ago', tone: 'success' },
				{ sha: '9c1e4d0', msg: 'bump next to 16.1', ago: '1d ago', tone: 'success' },
				{ sha: '4a8b2f1', msg: 'product grid: lazy images', ago: '2d ago', tone: 'destructive' },
			],
		},
		{
			name: 'admin-panel',
			domain: 'admin.example.com',
			server: 'prod-eu-2',
			status: 'live',
			sha: '0311b30',
			branch: 'main',
			when: '1d ago · took 1m 40s',
			days: days('....1.......1......1.....1....'),
			commits: [
				{ sha: '0311b30', msg: 'users: export to csv', ago: '1d ago', tone: 'success' },
				{ sha: 'e5f7a92', msg: 'audit log filters', ago: '6d ago', tone: 'success' },
				{ sha: '1c0d8b4', msg: 'session timeout 12h', ago: '9d ago', tone: 'success' },
			],
		},
	]
}

function AppsList({ billing, onOpenDeploy }: { billing: Billing; onOpenDeploy: () => void }) {
	const reduced = useReducedMotion()
	const [ref, inView] = useInView<HTMLDivElement>()
	const [tick, setTick] = useState(0)
	const [filter, setFilter] = useState<Status | null>(null)
	const [open, setOpen] = useState<string | null>(null)
	const uid = useId()

	useEffect(() => {
		if (reduced || !inView) return
		const id = window.setInterval(() => {
			if (!document.hidden) setTick((t) => t + 1)
		}, 1000)
		return () => window.clearInterval(id)
	}, [reduced, inView])

	const apps = useMemo(() => buildApps(tick, billing), [tick, billing])
	const counts = useMemo(() => {
		const c: Record<Status, number> = { live: 0, deploying: 0, failed: 0, down: 0 }
		for (const a of apps) c[a.status]++
		return c
	}, [apps])
	const fleet = useMemo(
		() =>
			apps[0].days.map((d, i) => ({
				day: d.day,
				ok: apps.reduce((n, a) => n + a.days[i].ok, 0),
				failed: apps.reduce((n, a) => n + a.days[i].failed, 0),
			})),
		[apps],
	)
	const shown = filter ? apps.filter((a) => a.status === filter) : apps
	const acme = apps.find((a) => a.name === 'acme-api')

	return (
		<div ref={ref}>
			<Frame path="deploy.example.com/projects">
				<div className="p-3 sm:p-5">
					<div className="flex items-baseline justify-between gap-3">
						<div>
							<div className="text-lg font-semibold tracking-tight">apps</div>
							<div className="text-xs text-muted-foreground">5 apps on 2 servers</div>
						</div>
					</div>

					<div className="mt-4 grid grid-cols-1 overflow-hidden rounded-lg border border-border bg-background/40 lg:grid-cols-[auto_minmax(0,1fr)]">
						<fieldset
							aria-label="filter apps by status"
							className={cn(
								'grid min-w-0 border-b border-border lg:border-b-0 lg:border-r',
								tileLayout(STATUSES.length).grid,
							)}
						>
							{STATUSES.map((s, i) => {
								const active = filter === s
								const n = counts[s]
								return (
									<button
										key={s}
										type="button"
										aria-pressed={active}
										onClick={() => setFilter(active ? null : s)}
										className={cn(
											'relative flex min-h-14 min-w-0 flex-col justify-center px-3 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4 lg:min-w-26',
											active && 'bg-accent',
											tileBorders(STATUSES.length, i),
										)}
									>
										<span
											className={cn(
												'text-lg font-semibold tabular-nums tracking-tight sm:text-xl',
												n === 0 && 'text-muted-foreground',
												n > 0 && TONE[s] === 'destructive' && 'text-destructive',
											)}
										>
											{n}
										</span>
										<span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground sm:text-xs">
											<StatusDot
												tone={n > 0 ? TONE[s] : 'neutral'}
												className="hidden sm:inline-flex"
											/>
											<span className="truncate">{s}</span>
										</span>
										{active && (
											<span
												aria-hidden="true"
												className="absolute inset-x-0 bottom-0 h-0.5 bg-signal shadow-[0_0_8px_rgb(62_230_255/0.7)]"
											/>
										)}
									</button>
								)
							})}
						</fieldset>
						<div className="hidden min-w-0 items-center gap-6 px-4 py-3 md:flex">
							<div className="w-56 shrink-0 space-y-1 text-xs text-muted-foreground">
								<div className="truncate">
									last deploy: <span className="font-medium text-foreground">acme-api</span>{' '}
									<span className={acme?.status === 'deploying' ? 'text-warning' : ''}>
										{acme?.status === 'deploying' ? 'building' : 'live'}
									</span>
								</div>
								<div>uptime checked on every app</div>
							</div>
							<div className="min-w-0 flex-1">
								<DeployBars days={fleet} className="h-8" />
							</div>
						</div>
					</div>

					<div className="mt-4 overflow-hidden rounded-lg border border-border">
						<div
							aria-hidden="true"
							className="hidden grid-cols-[minmax(0,1.5fr)_minmax(0,0.7fr)_minmax(0,0.8fr)_minmax(0,1.3fr)_1rem] gap-4 border-b border-border bg-background/40 px-4 py-2.5 text-xs text-muted-foreground md:grid"
						>
							<span>app</span>
							<span>server</span>
							<span>status</span>
							<span>last deploy</span>
							<span />
						</div>
						<ul aria-label="apps">
							{shown.map((a) => (
								<AppItem
									key={a.name}
									app={a}
									open={open === a.name}
									detailId={`${uid}-${a.name}`}
									onToggle={() => setOpen(open === a.name ? null : a.name)}
									onOpenDeploy={onOpenDeploy}
								/>
							))}
							{shown.length === 0 && (
								<li className="px-4 py-8 text-center text-sm text-muted-foreground">
									no apps {filter} right now
								</li>
							)}
						</ul>
					</div>
				</div>
			</Frame>
		</div>
	)
}

function AppItem({
	app: a,
	open,
	detailId,
	onToggle,
	onOpenDeploy,
}: {
	app: AppRow
	open: boolean
	detailId: string
	onToggle: () => void
	onOpenDeploy: () => void
}) {
	const tone = TONE[a.status]
	return (
		<li className={cn('border-b border-border last:border-b-0', open && 'bg-accent/40')}>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={detailId}
				onClick={onToggle}
				className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:grid-cols-[minmax(0,1.5fr)_minmax(0,0.7fr)_minmax(0,0.8fr)_minmax(0,1.3fr)_1rem] md:gap-4"
			>
				<span className="min-w-0">
					<span className="block truncate text-[0.9375rem] font-medium">{a.name}</span>
					<span className="block truncate text-xs text-muted-foreground">
						{a.domain ?? 'worker, no domain'}
						<span className="md:hidden"> · {a.server}</span>
					</span>
					<DeployStrip days={a.days} className="mt-2 h-2.5" focusable={false} />
				</span>
				<span className="hidden truncate text-sm text-muted-foreground md:block">{a.server}</span>
				<span className="flex items-center gap-2 justify-self-end md:justify-self-start">
					<StatusLabel tone={tone} pulse={a.pulse} className="text-xs md:text-sm">
						{a.status}
					</StatusLabel>
					<ChevronDown
						aria-hidden="true"
						className={cn(
							'h-4 w-4 text-muted-foreground transition-transform md:hidden',
							open && 'rotate-180',
						)}
					/>
				</span>
				<span className="col-span-2 min-w-0 text-xs text-muted-foreground md:col-span-1">
					<span className="flex items-center gap-1.5">
						<span className="font-mono text-foreground">{a.sha}</span>
						<span>{a.branch}</span>
					</span>
					<span className={cn('mt-0.5 block truncate', a.status === 'deploying' && 'text-warning')}>
						{a.when}
					</span>
				</span>
				<ChevronDown
					aria-hidden="true"
					className={cn(
						'hidden h-4 w-4 text-muted-foreground transition-transform group-hover:text-foreground md:block',
						open && 'rotate-180',
					)}
				/>
			</button>
			<div
				id={detailId}
				className={cn(
					'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
					open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
				)}
			>
				<div className="min-h-0 overflow-hidden" inert={!open}>
					<div className="grid gap-4 px-4 pb-4 pt-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-8">
						<dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] content-start gap-y-1.5 text-xs">
							<dt className="text-muted-foreground">domain</dt>
							<dd className="truncate">{a.domain ?? 'none, a worker'}</dd>
							<dt className="text-muted-foreground">server</dt>
							<dd>{a.server}</dd>
							<dt className="text-muted-foreground">branch</dt>
							<dd>{a.branch}</dd>
							{a.note && (
								<>
									<dt className="text-muted-foreground">note</dt>
									<dd className={cn(tone === 'destructive' && 'text-destructive')}>{a.note}</dd>
								</>
							)}
						</dl>
						<div className="min-w-0">
							<div className="text-xs text-muted-foreground">recent deploys</div>
							<ul className="mt-1.5 max-w-md space-y-1.5">
								{a.commits.map((c) => (
									<li key={c.sha} className="flex min-w-0 items-center gap-2.5 text-xs">
										<StatusDot tone={c.tone} pulse={c.tone === 'warning'} className="h-1.5 w-1.5" />
										<span className="shrink-0 font-mono text-foreground">{c.sha}</span>
										<span className="min-w-0 flex-1 truncate">{c.msg}</span>
										<span className="shrink-0 text-muted-foreground">{c.ago}</span>
									</li>
								))}
							</ul>
							{a.name === 'billing-worker' && a.status === 'failed' && (
								<button
									type="button"
									onClick={onOpenDeploy}
									className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-md text-xs font-medium text-signal underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
								>
									open the failed deploy
									<ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
								</button>
							)}
						</div>
					</div>
				</div>
			</div>
		</li>
	)
}

// ---------------------------------------------------------- failed deploy

type LogLine = { t: number; stage?: string; text: string; kind?: 'dim' | 'live'; from?: number }

const ROLLBACK: LogLine[] = [
	{ t: 0, stage: 'rollback', text: 'to 08a8548, nothing to build' },
	{ t: 1, stage: 'image', text: 'billing-worker:deploy-08a8548' },
	{ t: 2, stage: 'compose up', text: 'billing-worker recreated' },
	{ t: 5, stage: 'health check', text: 'HTTP 200 in 0.9s' },
	{ t: 7, kind: 'live', text: '08a8548 live in 7s' },
]
const REDEPLOY: LogLine[] = [
	{ t: 0, stage: 'fetch', text: 'main at c41d9e2' },
	{ t: 2, stage: 'preflight', text: 'docker ok, 41 GB free' },
	{ t: 3, stage: 'build', text: 'building on this server' },
	{ t: 118, kind: 'dim', text: 'image built in 1m 55s', from: 4 },
	{ t: 119, stage: 'test gate', text: '.powder/test.sh passed' },
	{ t: 141, stage: 'swap-check', text: 'candidate HTTP 200' },
	{ t: 146, stage: 'compose up', text: 'billing-worker recreated' },
	{ t: 153, stage: 'health check', text: 'HTTP 200 in 1.1s' },
	{ t: 158, kind: 'live', text: 'c41d9e2 live in 2m 38s' },
]
const BUILD_STEPS = [
	'[deps 2/4] RUN pnpm install --frozen-lockfile',
	'[build 3/4] COPY . .',
	'[build 4/4] RUN pnpm build',
	'next build: compiled, types ok',
	'exporting layers',
]
const PLAY_MS = { rollback: 2600, redeploy: 6500 } as const

const SECTIONS: { name: string; lines: string[] }[] = [
	{ name: 'preamble', lines: ['deploy billing-worker main ba7464a (push by octo-dev)'] },
	{ name: 'preflight', lines: ['docker ok, 41 GB free'] },
	{
		name: 'fetch',
		lines: [
			'cloning acme/billing-worker (main)',
			'HEAD is now at ba7464a invoices: sum with tax',
			'Dockerfile found',
		],
	},
]
// The build section; the last three lines are the failure.
const BUILD_LOG = [
	'#1 [internal] load build definition from Dockerfile',
	'#5 [deps 2/4] RUN pnpm install --frozen-lockfile',
	'#5 12.40 Progress: resolved 812, reused 790, downloaded 22',
	'#9 [build 4/4] RUN pnpm build',
	'#9 3.211 > next build',
]

function clock(sec: number): string {
	const s = Math.floor(sec)
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function FailedDeploy({
	billing,
	setBilling,
	panelRef,
}: {
	billing: Billing
	setBilling: (b: Billing) => void
	panelRef: React.RefObject<HTMLDivElement | null>
}) {
	const reduced = useReducedMotion()
	const [elapsed, setElapsed] = useState(0)
	const [openSections, setOpenSections] = useState<Set<string>>(() => new Set(['build']))
	const raf = useRef<number | null>(null)
	const resetRef = useRef<HTMLButtonElement>(null)
	const redeployRef = useRef<HTMLButtonElement>(null)
	const focusAfter = useRef<'reset' | 'redeploy' | null>(null)

	const kind: 'rollback' | 'redeploy' | null =
		billing === 'rolling-back' || billing === 'rolled-back'
			? 'rollback'
			: billing === 'redeploying' || billing === 'redeployed'
				? 'redeploy'
				: null
	const lines = kind === 'rollback' ? ROLLBACK : kind === 'redeploy' ? REDEPLOY : []
	const total = lines.length ? lines[lines.length - 1].t : 0
	const running = billing === 'rolling-back' || billing === 'redeploying'
	const done = billing === 'rolled-back' || billing === 'redeployed'

	useEffect(
		() => () => {
			if (raf.current) cancelAnimationFrame(raf.current)
		},
		[],
	)

	useEffect(() => {
		if (focusAfter.current === 'reset') resetRef.current?.focus()
		if (focusAfter.current === 'redeploy') redeployRef.current?.focus()
		focusAfter.current = null
	})

	const run = useCallback(
		(k: 'rollback' | 'redeploy') => {
			if (raf.current) cancelAnimationFrame(raf.current)
			const seq = k === 'rollback' ? ROLLBACK : REDEPLOY
			const end = seq[seq.length - 1].t
			const finished: Billing = k === 'rollback' ? 'rolled-back' : 'redeployed'
			focusAfter.current = 'reset'
			if (reduced) {
				setElapsed(end)
				setBilling(finished)
				return
			}
			setElapsed(0)
			setBilling(k === 'rollback' ? 'rolling-back' : 'redeploying')
			const start = performance.now()
			const tick = (now: number) => {
				const sec = ((now - start) / PLAY_MS[k]) * end
				if (sec >= end) {
					setElapsed(end)
					setBilling(finished)
					raf.current = null
					return
				}
				setElapsed(sec)
				raf.current = requestAnimationFrame(tick)
			}
			raf.current = requestAnimationFrame(tick)
		},
		[reduced, setBilling],
	)

	const reset = () => {
		if (raf.current) cancelAnimationFrame(raf.current)
		raf.current = null
		focusAfter.current = 'redeploy'
		setElapsed(0)
		setBilling('failed')
	}

	const toggle = (name: string) =>
		setOpenSections((s) => {
			const n = new Set(s)
			if (n.has(name)) n.delete(name)
			else n.add(name)
			return n
		})

	const sha = kind === 'rollback' ? '08a8548' : kind === 'redeploy' ? 'c41d9e2' : 'ba7464a'

	return (
		<div ref={panelRef} tabIndex={-1} className="scroll-mt-24 rounded-[14px] focus:outline-none">
			<Frame
				path={`deploy.example.com/deploys/${kind === null ? 'd_8f2k1' : kind === 'rollback' ? 'd_8f2k2' : 'd_8f2k3'}`}
			>
				<div className="p-3 sm:p-5">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
								<span className="text-lg font-semibold tracking-tight">billing-worker</span>
								<span className="font-mono text-sm text-muted-foreground">{sha}</span>
								{billing === 'failed' ? (
									<Badge variant="destructive">failed</Badge>
								) : running ? (
									<Badge variant="warning">
										<StatusDot tone="warning" pulse className="h-1.5 w-1.5" />
										{kind === 'rollback' ? 'rolling back' : 'building'}
									</Badge>
								) : (
									<Badge variant="success">live</Badge>
								)}
							</div>
							<div className="mt-1 truncate text-xs text-muted-foreground">
								{kind === null
									? 'main · push by octo-dev · 11 Nov, 09:06 · 2m'
									: kind === 'rollback'
										? 'roll back from ba7464a · same image as 08a8548'
										: 'redeploy · main · c41d9e2 fix: invoice.amount, not total'}
							</div>
						</div>
						<div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
							{billing === 'failed' ? (
								<>
									<button
										ref={redeployRef}
										type="button"
										onClick={() => run('redeploy')}
										className={buttonVariants({ size: 'sm' })}
									>
										<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
										redeploy
									</button>
									<button
										type="button"
										onClick={() => run('rollback')}
										className={buttonVariants({ variant: 'outline', size: 'sm' })}
									>
										<Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
										roll back to <span className="font-mono">08a8548</span>
									</button>
								</>
							) : (
								<button
									ref={resetRef}
									type="button"
									// aria-disabled (not disabled) keeps focus on the button while
									// the run plays; the click does nothing until it finishes
									onClick={running ? undefined : reset}
									aria-disabled={running || undefined}
									className={buttonVariants({
										variant: 'outline',
										size: 'sm',
										className:
											'col-span-2 aria-disabled:pointer-events-auto aria-disabled:cursor-wait',
									})}
								>
									{running ? (
										<Spinner className="h-3.5 w-3.5" />
									) : (
										<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
									)}
									{running ? (kind === 'rollback' ? 'rolling back' : 'redeploying') : 'reset'}
								</button>
							)}
						</div>
					</div>

					<p className="sr-only" aria-live="polite">
						{billing === 'rolled-back'
							? 'Rolled back. 08a8548 is live.'
							: billing === 'redeployed'
								? 'Redeployed. c41d9e2 is live.'
								: ''}
					</p>

					{kind === null ? (
						<>
							<div className="mt-4 flex gap-3 rounded-lg border border-destructive/40 bg-destructive/[0.07] px-4 py-3">
								<TriangleAlert
									className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
									aria-hidden="true"
								/>
								<div className="min-w-0">
									<div className="text-sm font-medium [overflow-wrap:anywhere]">
										Type error: Property &apos;total&apos; does not exist on type
										&apos;Invoice&apos;.
									</div>
									<div className="mt-1 font-mono text-xs text-muted-foreground">
										failed at: build · exit code 1
									</div>
								</div>
							</div>

							<div className="mt-4 overflow-hidden rounded-lg border border-border">
								<div className="border-b border-border bg-background/40 px-4 py-2.5 text-xs text-muted-foreground">
									4 sections
								</div>
								{SECTIONS.map((s) => (
									<LogSection
										key={s.name}
										name={s.name}
										count={s.lines.length}
										open={openSections.has(s.name)}
										onToggle={() => toggle(s.name)}
									>
										{s.lines.map((l) => (
											<div key={l}>{l}</div>
										))}
									</LogSection>
								))}
								<LogSection
									name="build"
									count={BUILD_LOG.length + 3}
									failed
									open={openSections.has('build')}
									onToggle={() => toggle('build')}
								>
									{BUILD_LOG.map((l) => (
										<div key={l}>{l}</div>
									))}
									<div className="-mx-4 -mb-3 mt-0.5 bg-destructive/[0.1] px-4 py-2 text-destructive sm:-mx-5 sm:px-5">
										<div>
											#9 21.84 Type error: Property &apos;total&apos; does not exist on type
											&apos;Invoice&apos;.
										</div>
										<div className="whitespace-pre-wrap text-foreground">
											{'#9 21.84    42 |   const sum = invoice.'}
											<span className="underline decoration-destructive decoration-wavy underline-offset-4">
												total
											</span>{' '}
											+ tax
										</div>
										<div>
											#9 ERROR: process &quot;/bin/sh -c pnpm build&quot; did not complete
											successfully: exit code: 1
										</div>
									</div>
								</LogSection>
							</div>
						</>
					) : (
						<div className="relative mt-4 overflow-hidden rounded-lg border border-border bg-background/40">
							<span
								aria-hidden="true"
								className="absolute inset-x-0 top-0 h-px origin-left bg-signal shadow-[0_0_8px_rgb(62_230_255/0.7)]"
								style={{ transform: `scaleX(${total ? elapsed / total : 0})` }}
							/>
							<div className="px-4 py-4 font-mono text-[0.75rem] leading-[1.8] sm:px-5 sm:text-[0.8125rem]">
								{lines.map((l) => {
									const building = l.from !== undefined && elapsed >= l.from && elapsed < l.t
									const on = l.t <= elapsed || building
									const step = building
										? BUILD_STEPS[
												Math.min(
													BUILD_STEPS.length - 1,
													Math.floor(
														((elapsed - (l.from ?? 0)) / (l.t - (l.from ?? 0))) *
															BUILD_STEPS.length,
													),
												)
											]
										: null
									return (
										<div
											key={`${l.t}-${l.text}`}
											data-on={on}
											className="replay-line flex gap-2.5 whitespace-nowrap sm:gap-3"
										>
											<span className="hidden w-[3.2em] shrink-0 tabular-nums text-[#7f8ca1] sm:inline">
												{clock(building ? elapsed : l.t)}
											</span>
											{l.kind === 'live' ? (
												<span className="flex min-w-0 items-center gap-2 font-semibold text-signal [text-shadow:0_0_14px_rgb(62_230_255/0.7)]">
													<span
														className="wire-dot inline-flex h-2 w-2 shrink-0 rounded-full"
														aria-hidden="true"
													/>
													<span className="truncate">{l.text}</span>
												</span>
											) : l.kind === 'dim' ? (
												<span className="truncate text-muted-foreground">{step ?? l.text}</span>
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
							{done && (
								<div className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
									ba7464a stays in the deploy history as failed.
								</div>
							)}
						</div>
					)}
				</div>
			</Frame>
		</div>
	)
}

function LogSection({
	name,
	count,
	open,
	failed,
	onToggle,
	children,
}: {
	name: string
	count: number
	open: boolean
	failed?: boolean
	onToggle: () => void
	children: React.ReactNode
}) {
	const id = useId()
	return (
		<div className="border-b border-border last:border-b-0">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={id}
				onClick={onToggle}
				className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
			>
				<ChevronRight
					aria-hidden="true"
					className={cn(
						'h-3.5 w-3.5 text-muted-foreground transition-transform',
						open && 'rotate-90',
					)}
				/>
				<span className={cn('font-mono text-sm', failed && 'text-destructive')}>{name}</span>
				{failed && <Badge variant="destructive">failed here</Badge>}
				<span className="ml-auto text-xs text-muted-foreground">
					{count} {count === 1 ? 'line' : 'lines'}
				</span>
			</button>
			{open && (
				<div
					id={id}
					className="border-t border-border/60 px-4 py-3 font-mono text-[0.75rem] leading-[1.75] text-foreground/90 [overflow-wrap:anywhere] sm:px-5 sm:text-[0.8125rem]"
				>
					{children}
				</div>
			)}
		</div>
	)
}

// ------------------------------------------------------------------ section

export function DashboardDemo() {
	const [billing, setBilling] = useState<Billing>('failed')
	const deployRef = useRef<HTMLDivElement>(null)
	const openDeploy = useCallback(() => {
		const el = deployRef.current
		if (!el) return
		const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
		el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
		el.focus({ preventScroll: true })
	}, [])

	return (
		<div className="mt-8 space-y-10">
			<figure>
				<AppsList billing={billing} onOpenDeploy={openDeploy} />
				<figcaption className="mt-3 text-center text-sm text-muted-foreground">
					Every app on every server: live, deploying, failed or down, and its last deploy.
				</figcaption>
			</figure>
			<figure>
				<FailedDeploy billing={billing} setBilling={setBilling} panelRef={deployRef} />
				<figcaption className="mt-3 text-center text-sm text-muted-foreground">
					A failed build never goes live. The page shows where it broke, with redeploy and roll
					back.
				</figcaption>
			</figure>
		</div>
	)
}
