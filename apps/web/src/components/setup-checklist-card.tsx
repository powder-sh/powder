'use client'

// Setup checklist on the dashboard home. Loads cheaply (env + cached results,
// no SSH); "check now" asks the server to SSH and resolve DNS.
// Before the first app it is a short to-do list. Once an app exists it folds
// into one quiet line ("setup: N items left") that expands and can be put
// away; the choice lives in localStorage and settings can bring it back.
// Row actions are never filled buttons: the page's one primary is "new app".

import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { cn } from '@/lib/cn'
import {
	type ChecklistItem,
	type ChecklistSummary,
	summarizeChecklist,
} from '@/lib/setup-checklist'
import { Check, ChevronDown, Circle, CircleDashed, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'

const CHECKLIST_HIDDEN_KEY = 'powder.setupChecklist.dismissed'

export function readChecklistHidden(): boolean {
	try {
		return localStorage.getItem(CHECKLIST_HIDDEN_KEY) === '1'
	} catch {
		return false
	}
}

export function setChecklistHidden(hidden: boolean): void {
	try {
		if (hidden) localStorage.setItem(CHECKLIST_HIDDEN_KEY, '1')
		else localStorage.removeItem(CHECKLIST_HIDDEN_KEY)
	} catch {
		// private mode or storage off: the card just stays visible
	}
}

interface ChecklistResponse {
	items: ChecklistItem[]
	complete: boolean
}

export function SetupChecklistCard({ quiet = false }: { quiet?: boolean }) {
	const [data, setData] = useState<ChecklistResponse | null>(null)
	const [hidden, setHidden] = useState(true)
	const [expanded, setExpanded] = useState(false)
	const [running, setRunning] = useState(false)

	useEffect(() => {
		setHidden(readChecklistHidden())
		fetch('/api/setup/checklist')
			.then((r) => (r.ok ? (r.json() as Promise<ChecklistResponse>) : null))
			.then(setData)
			.catch(() => setData(null))
	}, [])

	async function runChecks() {
		setRunning(true)
		try {
			const res = await fetch('/api/setup/checklist?action=run', { method: 'POST' }).catch(() => null)
			if (res?.ok) setData((await res.json()) as ChecklistResponse)
		} catch {
			// the last results stay on screen; run again
		} finally {
			setRunning(false)
		}
	}

	function hide() {
		setChecklistHidden(true)
		setHidden(true)
	}

	if (!data) return null
	const sum = summarizeChecklist(data.items)
	const open = data.items.filter((i) => i.state !== 'done')
	if (open.length === 0) return null
	// Folded once an app exists or the required steps are done; hidden on request.
	const folded = quiet || sum.ready
	if (folded && hidden) return null

	if (folded && !expanded) {
		return (
			<div className="flex items-center gap-1 rounded-lg border border-border pl-2 pr-1 text-xs text-muted-foreground sm:pl-3">
				<button
					type="button"
					aria-expanded={false}
					onClick={() => setExpanded(true)}
					className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left transition-colors hover:text-foreground sm:min-h-9"
				>
					<ChevronDown className="h-3.5 w-3.5 shrink-0 -rotate-90" aria-hidden="true" />
					<span className="shrink-0">
						setup: <span className="tabular-nums text-foreground">{open.length}</span> item
						{open.length === 1 ? '' : 's'} left
					</span>
					{sum.next && (
						<span className="hidden min-w-0 truncate sm:inline">· next: {sum.next.label}</span>
					)}
				</button>
				<button
					type="button"
					onClick={hide}
					aria-label="hide the setup checklist"
					className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground sm:h-8 sm:w-8"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			</div>
		)
	}

	const required = data.items.filter((i) => i.required)
	const optional = data.items.filter((i) => !i.required)
	return (
		<section
			aria-labelledby="setup-title"
			className="overflow-hidden rounded-lg border border-border bg-card shadow-card"
		>
			<header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 sm:px-5">
				<div className="min-w-0 flex-1">
					<h2 id="setup-title" className="text-sm font-semibold tracking-tight">
						{folded ? 'setup' : 'set up powder'}
					</h2>
					<p className="mt-0.5 text-xs text-muted-foreground">
						{folded
							? `${open.length} item${open.length === 1 ? '' : 's'} left`
							: `${sum.requiredDone} of ${sum.requiredTotal} steps before your first deploy`}
					</p>
				</div>
				{!folded && <Progress done={sum.requiredDone} total={sum.requiredTotal} />}
				{folded && (
					<Button variant="ghost" size="xs" onClick={() => setExpanded(false)}>
						collapse
					</Button>
				)}
			</header>
			{folded ? (
				<ul className="divide-y divide-border">
					{open.map((i) => (
						<Row
							key={i.id}
							item={i}
							next={sum.next?.id === i.id}
							running={running}
							onRun={runChecks}
						/>
					))}
				</ul>
			) : (
				<>
					<ul className="divide-y divide-border">
						{required.map((i) => (
							<Row
								key={i.id}
								item={i}
								next={sum.next?.id === i.id}
								running={running}
								onRun={runChecks}
							/>
						))}
					</ul>
					<Optional items={optional} sum={sum} running={running} onRun={runChecks} />
				</>
			)}
		</section>
	)
}

function Progress({ done, total }: { done: number; total: number }) {
	return (
		<div className="flex items-center gap-1" aria-hidden="true">
			{Array.from({ length: total }, (_, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length progress segments
					key={i}
					className={cn('h-1.5 w-6 rounded-full', i < done ? 'bg-foreground' : 'bg-border')}
				/>
			))}
		</div>
	)
}

function Optional({
	items,
	sum,
	running,
	onRun,
}: {
	items: ChecklistItem[]
	sum: ChecklistSummary
	running: boolean
	onRun: () => void
}) {
	const [open, setOpen] = useState(false)
	if (items.length === 0) return null
	return (
		<div className="border-t border-border">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground sm:px-5"
			>
				<ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !open && '-rotate-90')} />
				optional · {sum.optionalLeft} left
			</button>
			{open && (
				<ul className="divide-y divide-border border-t border-border">
					{items.map((i) => (
						<Row key={i.id} item={i} next={false} running={running} onRun={onRun} />
					))}
				</ul>
			)}
		</div>
	)
}

function Row({
	item,
	next,
	running,
	onRun,
}: {
	item: ChecklistItem
	next: boolean
	running: boolean
	onRun: () => void
}) {
	const done = item.state === 'done'
	const Icon = done ? Check : item.state === 'unknown' ? CircleDashed : Circle
	return (
		<li
			className={cn(
				'flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5',
				next && 'bg-accent/30',
			)}
		>
			<div className="flex min-w-0 flex-1 gap-3">
				<span
					className={cn(
						'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center',
						done ? 'text-success' : 'text-muted-foreground',
					)}
				>
					<Icon className={cn(done ? 'h-3.5 w-3.5' : 'h-4 w-4')} aria-hidden="true" />
				</span>
				<div className="min-w-0 flex-1">
					<p
						className={cn(
							'text-sm',
							done ? 'text-muted-foreground' : 'font-medium text-foreground',
						)}
					>
						{item.label}
						<span className="sr-only">{done ? ' (done)' : ' (to do)'}</span>
					</p>
					<p className="ph-no-capture mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
						{item.detail}
					</p>
				</div>
			</div>
			{!done && (
				<div className={cn('shrink-0 pl-7 sm:pl-0', !next && '-ml-3 sm:ml-0')}>
					{item.runsCheck ? (
						<Button
							variant={next ? 'outline' : 'ghost'}
							size="sm"
							onClick={onRun}
							loading={running}
						>
							{item.action}
						</Button>
					) : (
						<Link
							href={item.href}
							className={buttonVariants({ variant: next ? 'outline' : 'ghost', size: 'sm' })}
						>
							{item.action}
						</Link>
					)}
				</div>
			)}
		</li>
	)
}
