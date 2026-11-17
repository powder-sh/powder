'use client'

// Cmd+K palette. Global listener; debounced query → /api/cmd/search.
// Categories: Projects, Recent deploys, Actions. Arrow-key navigation +
// enter to jump. Vercel's `cmdk` lib gives us the keyboard primitives.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Command } from 'cmdk'
import { Box, ChevronRight, History, Rocket, Sparkles } from 'lucide-react'
import { deployStatus } from '@/lib/deploy-status'
import {
	type PaletteAnswer,
	createEnterPending,
	createPaletteSearch,
	firstPaletteValue,
	paletteAnswersQuery,
	paletteValue,
} from '@/lib/palette'
import type { StatusTone } from '@/components/ui/status'
import { useModalFocus } from '@/components/ui/use-modal-focus'

const DEPLOY_TEXT: Record<StatusTone, string> = {
	success: 'text-success',
	warning: 'text-warning',
	destructive: 'text-destructive',
	info: 'text-info',
	neutral: 'text-muted-foreground',
}

interface CmdProject {
	id: string
	containerName: string
	serverId: string
	repoUrl: string
}

interface CmdDeploy {
	id: string
	containerName: string
	serverId: string
	appRepoId: string | null
	status: string
	kind: string
	startedAt: string
	gitSha: string | null
}

interface CmdAction {
	id: string
	label: string
	subtitle?: string
	hint?: string
	href: string
}

interface SearchResponse {
	projects: CmdProject[]
	deploys: CmdDeploy[]
	actions: CmdAction[]
}

export const OPEN_PALETTE_EVENT = 'powder:open-palette'

const NO_RESULTS: SearchResponse = { projects: [], deploys: [], actions: [] }

async function fetchResults(q: string, signal: AbortSignal): Promise<SearchResponse> {
	const res = await fetch(`/api/cmd/search?q=${encodeURIComponent(q)}`, { signal })
	if (!res.ok) throw new Error(`search failed (${res.status})`)
	return (await res.json()) as SearchResponse
}

export function CommandPalette() {
	const router = useRouter()
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	// The results on screen and the query they answer (lib/palette.ts).
	const [answer, setAnswer] = useState<PaletteAnswer<SearchResponse> | null>(null)
	const data = answer?.data ?? NO_RESULTS
	const search = useMemo(() => createPaletteSearch(fetchResults), [])
	// Enter pressed before the answer to the current query landed: open its first
	// item when it does (lib/palette.ts).
	const enter = useMemo(() => createEnterPending(), [])
	const panelRef = useRef<HTMLDivElement>(null)
	useModalFocus(open, panelRef)

	// Global keybinding. ⌘K on mac, Ctrl+K elsewhere.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
				e.preventDefault()
				setOpen((v) => !v)
			}
		}
		// The sidebar's search button opens the palette through this event.
		const onOpen = () => setOpen(true)
		window.addEventListener('keydown', onKey)
		window.addEventListener(OPEN_PALETTE_EVENT, onOpen)
		return () => {
			window.removeEventListener('keydown', onKey)
			window.removeEventListener(OPEN_PALETTE_EVENT, onOpen)
		}
	}, [])

	// Debounced fetch on query change. 150ms so the network doesn't fire on
	// every keystroke while still feeling instant. A newer query aborts the older
	// request and an older answer never replaces a newer one (createPaletteSearch).
	useEffect(() => {
		if (!open) return
		const t = setTimeout(async () => {
			const a = await search.run(query)
			if (a) setAnswer(a)
			else enter.failed(query)
		}, 150)
		return () => clearTimeout(t)
	}, [open, query, search, enter])

	// cmdk does not pick an item when results arrive asynchronously: select the
	// first one whenever the result set changes, so Enter opens it.
	const [selected, setSelected] = useState('')
	useEffect(() => {
		setSelected(firstPaletteValue(data))
	}, [data])

	// Closing forgets the query, the results and a request in flight, so a reopen
	// never shows (or opens) the previous list.
	useEffect(() => {
		if (open) return
		search.cancel()
		enter.clear()
		setQuery('')
		setAnswer(null)
	}, [open, search, enter])

	const jump = useCallback(
		(href: string) => {
			setOpen(false)
			router.push(href)
		},
		[router],
	)

	const hrefFor = useCallback((value: string, r: SearchResponse): string | null => {
		const p = r.projects.find((x) => paletteValue.project(x.id) === value)
		if (p) return `/projects/${p.id}`
		const d = r.deploys.find((x) => paletteValue.deploy(x.id) === value)
		if (d) return d.appRepoId ? `/projects/${d.appRepoId}/deployments#${d.id}` : `/servers/${d.serverId}/${d.containerName}`
		const a = r.actions.find((x) => paletteValue.action(x.id) === value)
		return a ? a.href : null
	}, [])

	// The answer to the current query landed after Enter: open its first item.
	useEffect(() => {
		if (!answer || !enter.take(query, answer)) return
		const href = hrefFor(firstPaletteValue(answer.data), answer.data)
		if (href) jump(href)
	}, [answer, query, hrefFor, jump, enter])

	if (!open) return null

	return (
		<>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop; Esc closes via the Command keydown */}
			<div
				className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm"
				onClick={() => setOpen(false)}
			/>
			<div ref={panelRef} className="fixed left-1/2 top-[12vh] z-50 w-full max-w-xl -translate-x-1/2 px-4">
				<Command
					className="animate-enter overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-popover"
					shouldFilter={false}
					value={selected}
					onValueChange={setSelected}
					onKeyDown={(e) => {
						if (e.key === 'Escape') setOpen(false)
						else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
							if (paletteAnswersQuery(query, answer)) {
								enter.clear()
								return // cmdk opens the selected item
							}
							// The list on screen answers an older query: wait for this one.
							e.preventDefault()
							enter.press(query)
						}
					}}
				>
					<Command.Input
						value={query}
						onValueChange={(v) => {
							enter.queryChanged(v)
							setQuery(v)
						}}
						placeholder="search apps, deploys, actions…"
						aria-label="search apps, deploys, actions"
						className="h-12 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
						data-autofocus
					/>
					<Command.List className="max-h-[60vh] overflow-y-auto p-1">
						<Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
							no matches.
						</Command.Empty>

						{data.projects.length > 0 && (
							<Command.Group
								heading="apps"
								className="px-1 pt-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
							>
								{data.projects.map((p) => (
									<Command.Item
										key={p.id}
										value={paletteValue.project(p.id)}
										onSelect={() => jump(`/projects/${p.id}`)}
										className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm aria-selected:bg-accent data-[selected=true]:bg-accent"
									>
										<Box className="h-3.5 w-3.5 text-muted-foreground" />
										<span className="font-mono">{p.containerName}</span>
										<span className="ml-auto text-xs text-muted-foreground truncate max-w-[40%]">
											{repoSlug(p.repoUrl) ?? p.serverId}
										</span>
										<ChevronRight className="h-3 w-3 text-muted-foreground" />
									</Command.Item>
								))}
							</Command.Group>
						)}

						{data.deploys.length > 0 && (
							<Command.Group
								heading="recent deploys"
								className="px-1 pt-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
							>
								{data.deploys.map((d) => (
									<Command.Item
										key={d.id}
										value={paletteValue.deploy(d.id)}
										onSelect={() => {
											const href = hrefFor(paletteValue.deploy(d.id), data)
											if (href) jump(href)
										}}
										className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm aria-selected:bg-accent data-[selected=true]:bg-accent"
									>
										<Rocket className="h-3.5 w-3.5 text-muted-foreground" />
										<span className="font-mono text-xs">{d.containerName}</span>
										<span className={`text-xs ${DEPLOY_TEXT[deployStatus(d.status).tone]}`}>
											{deployStatus(d.status).label}
										</span>
										{d.gitSha && (
											<span className="font-mono text-2xs text-muted-foreground">
												{d.gitSha.slice(0, 7)}
											</span>
										)}
										<span className="ml-auto text-xs text-muted-foreground">
											{timeAgo(d.startedAt)}
										</span>
									</Command.Item>
								))}
							</Command.Group>
						)}

						{data.actions.length > 0 && (
							<Command.Group
								heading="actions"
								className="px-1 pt-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
							>
								{data.actions.map((a) => (
									<Command.Item
										key={a.id}
										value={paletteValue.action(a.id)}
										onSelect={() => jump(a.href)}
										className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm aria-selected:bg-accent data-[selected=true]:bg-accent"
									>
										<Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
										<span>{a.label}</span>
										{a.hint && <span className="text-xs text-muted-foreground">{a.hint}</span>}
										<ChevronRight className="ml-auto h-3 w-3 text-muted-foreground" />
									</Command.Item>
								))}
							</Command.Group>
						)}
					</Command.List>
					<div className="flex items-center justify-between border-t border-border px-3 py-2 text-2xs text-muted-foreground">
						<span>
							<kbd className="font-mono">↑↓</kbd> navigate · <kbd className="font-mono">↵</kbd> jump
							· <kbd className="font-mono">esc</kbd> close
						</span>
						<span className="flex items-center gap-1">
							<History className="h-3 w-3" />
							<span>cmd-k anywhere</span>
						</span>
					</div>
				</Command>
			</div>
		</>
	)
}

function repoSlug(url: string): string | null {
	const ssh = url.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/)
	if (ssh) return `${ssh[1]}/${ssh[2]}`
	const https = url.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$/)
	if (https) return `${https[1]}/${https[2]}`
	return null
}

function timeAgo(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h`
	const d = Math.floor(h / 24)
	return `${d}d`
}
