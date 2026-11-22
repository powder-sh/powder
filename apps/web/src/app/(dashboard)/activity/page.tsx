import { buttonVariants } from '@/components/ui/button-variants'
import { CopyButton } from '@/components/ui/copy-button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { StatusLabel, type StatusTone } from '@/components/ui/status'
import { TBody, THead, Table, TableFrame, Td, Th, Tr } from '@/components/ui/table'
import {
	ACTIVITY_FILTERS,
	ACTIVITY_WINDOWS,
	type ActivityEvent,
	type ActivityParams,
	activityHref,
	parseActivityParams,
} from '@/lib/activity-feed'
import { loadActivityPage } from '@/lib/activity-feed-db'
import { cn } from '@/lib/cn'
import { deployStatus } from '@/lib/deploy-status'
import { timeAgo } from '@/lib/format'
import { requirePageUser } from '@/lib/page-gate'
import { Activity as ActivityIcon } from 'lucide-react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

// Activity on all servers: one newest-first feed over deploys that are not
// a plain successful git deploy (restarts, rollbacks, env changes, image
// updates, manual applies, failed git deploys), env var audit rows (key and
// action, never values), backup failures, successful backups collapsed per app
// per day (backups filter only) and backup downloads/restores/verifies/drops.
// Sources, filters and the merge live in lib/activity-feed.ts (unit-tested).

function Segmented({
	label,
	items,
}: {
	label: string
	items: { key: string; label: string; href: string; active: boolean }[]
}) {
	return (
		<nav
			aria-label={label}
			className="inline-flex h-10 sm:h-9 max-w-full shrink-0 items-center gap-0.5 self-start overflow-x-auto rounded-md border border-border bg-muted/50 p-0.5"
		>
			{items.map((i) => (
				<Link
					key={i.key}
					href={i.href}
					aria-current={i.active ? 'true' : undefined}
					className={cn(
						'inline-flex h-full shrink-0 items-center rounded-[5px] px-3 text-sm transition-colors',
						i.active
							? 'bg-card font-medium text-foreground shadow-card ring-1 ring-border'
							: 'text-muted-foreground hover:text-foreground',
					)}
				>
					{i.label}
				</Link>
			))}
		</nav>
	)
}

// Deploy rows use the deploy vocabulary; backups and restores say ok / failed.
function eventStatus(e: ActivityEvent): { label: string; tone: StatusTone; pulse?: boolean } | null {
	if (!e.status) return null
	if (e.source === 'deploy') return deployStatus(e.status)
	if (e.status === 'success') return { label: 'ok', tone: 'success' }
	if (e.status === 'failed') return { label: 'failed', tone: 'destructive' }
	return { label: e.status.replace(/_/g, ' '), tone: 'neutral' }
}

function nextWiderWindow(params: ActivityParams) {
	return ACTIVITY_WINDOWS.find((w) => w.days > params.days) ?? null
}

export default async function ActivityPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
	await requirePageUser()
	const params = parseActivityParams(await searchParams)
	const { events, nextBefore } = await loadActivityPage(params)
	const wider = nextWiderWindow(params)
	const windowLabel = ACTIVITY_WINDOWS.find((w) => w.days === params.days)?.label ?? ''

	return (
		<div className="space-y-5">
			<title>activity · powder</title>
			<PageHeader
				title="activity"
				description={
					<>
						restarts, rollbacks, env changes, image updates, failed deploys, backup failures and
						restores, newest first. successful git deploys are on{' '}
						<Link href="/deploys" className="text-foreground underline underline-offset-2">
							deploys
						</Link>
						; cron firings are on each app&apos;s crons tab.
					</>
				}
			/>

			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<Segmented
					label="activity filter"
					items={ACTIVITY_FILTERS.map((f) => ({
						key: f.key,
						label: f.label,
						href: activityHref(params, { filter: f.key, before: null }),
						active: params.filter === f.key,
					}))}
				/>
				<Segmented
					label="time window"
					items={ACTIVITY_WINDOWS.map((w) => ({
						key: String(w.days),
						label: w.label,
						href: activityHref(params, { days: w.days, before: null }),
						active: params.days === w.days,
					}))}
				/>
			</div>

			{params.before && (
				<p className="text-xs text-muted-foreground">
					showing activity before {timeAgo(params.before)}.{' '}
					<Link
						href={activityHref(params, { before: null })}
						className="text-foreground underline underline-offset-2"
					>
						back to newest
					</Link>
				</p>
			)}

			{events.length === 0 ? (
				<EmptyState
					icon={ActivityIcon}
					title={`nothing in the last ${windowLabel}`}
					action={
						wider ? (
							<Link
								href={activityHref(params, { days: wider.days, before: null })}
								className={buttonVariants({ variant: 'outline', size: 'sm' })}
							>
								show {wider.label}
							</Link>
						) : undefined
					}
				>
					{params.filter === 'all'
						? 'restarts, rollbacks, env changes and backup failures show up here.'
						: `no ${params.filter} in this window. try a longer window or another filter.`}
				</EmptyState>
			) : (
				<div className="space-y-3">
					{/* Phones: one card per event. */}
					<ul
						aria-label="activity"
						className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card shadow-card md:hidden"
					>
						{events.map((e) => {
							const st = eventStatus(e)
							return (
								<li key={e.id} className="relative px-4 py-3">
									<div className="flex items-baseline justify-between gap-3">
										<Link
											href={e.href}
											className="min-w-0 truncate text-sm font-medium after:absolute after:inset-0"
										>
											{e.app}
										</Link>
										<span className="shrink-0 text-xs text-muted-foreground">{timeAgo(e.at)}</span>
									</div>
									<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
										{st && (
											<StatusLabel tone={st.tone} pulse={st.pulse} className="text-xs">
												{st.label}
											</StatusLabel>
										)}
										<span>{e.what}</span>
										{e.by && <span className="truncate">· {e.by}</span>}
									</div>
									{e.detail && (
										<div className="mt-1 flex items-start gap-1">
											<div
												className={cn(
													'ph-no-capture line-clamp-2 min-w-0 flex-1 break-words font-mono text-xs',
													e.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
												)}
											>
												{e.detail}
											</div>
											{e.status === 'failed' && (
												<CopyButton
													value={`${e.app}: ${e.what}\n${e.detail}`}
													label="copy the error"
													className="relative z-10 -my-2"
												/>
											)}
										</div>
									)}
								</li>
							)
						})}
					</ul>
					<TableFrame className="hidden md:block">
						<Table className="table-fixed">
							<caption className="sr-only">activity on all servers, newest first</caption>
							<colgroup>
								<col className="w-[22%]" />
								<col />
								<col className="w-28" />
								<col className="w-[18%]" />
								<col className="w-24" />
							</colgroup>
							<THead>
								<tr>
									<Th>app</Th>
									<Th>what</Th>
									<Th>status</Th>
									<Th>by</Th>
									<Th className="text-right">when</Th>
								</tr>
							</THead>
							<TBody>
								{events.map((e) => {
									const st = eventStatus(e)
									return (
										<Tr key={e.id} className="group">
											<Td className="truncate align-top">
												<Link
													href={e.href}
													title={e.app}
													className="font-medium hover:underline focus-visible:underline"
												>
													{e.app}
												</Link>
											</Td>
											<Td className="align-top">
												<div className="truncate text-muted-foreground">{e.what}</div>
												{e.detail && (
													<div className="mt-0.5 flex items-center gap-1">
														<div
															className={cn(
																'ph-no-capture min-w-0 truncate font-mono text-xs',
																e.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
															)}
															title={e.detail}
														>
															{e.detail}
														</div>
														{e.status === 'failed' && (
															<CopyButton
																value={`${e.app}: ${e.what}\n${e.detail}`}
																label="copy the error"
																reveal
																className="-my-1"
															/>
														)}
													</div>
												)}
											</Td>
											<Td className="align-top">
												{st ? (
													<StatusLabel tone={st.tone} pulse={st.pulse} className="text-xs">
														{st.label}
													</StatusLabel>
												) : (
													<span className="text-xs text-muted-foreground">-</span>
												)}
											</Td>
											<Td className="truncate align-top text-muted-foreground" title={e.by ?? undefined}>
												{e.by ?? '-'}
											</Td>
											<Td className="whitespace-nowrap text-right align-top text-xs text-muted-foreground">
												{timeAgo(e.at)}
											</Td>
										</Tr>
									)
								})}
							</TBody>
						</Table>
					</TableFrame>
					<div className="flex flex-wrap items-center justify-center gap-2 pt-1">
						{nextBefore ? (
							<Link
								href={activityHref(params, { before: nextBefore })}
								className={buttonVariants({ variant: 'outline', size: 'sm' })}
							>
								load older
							</Link>
						) : (
							<>
								<span className="text-xs text-muted-foreground">
									that is everything in the last {windowLabel}.
								</span>
								{wider && (
									<Link
										href={activityHref(params, { days: wider.days, before: null })}
										className={buttonVariants({ variant: 'ghost', size: 'sm' })}
									>
										show {wider.label}
									</Link>
								)}
							</>
						)}
					</div>
				</div>
			)}
		</div>
	)
}
