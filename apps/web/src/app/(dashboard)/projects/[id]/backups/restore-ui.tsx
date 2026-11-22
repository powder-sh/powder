'use client'

// Backups tab, "get it back" half: the download panel (presigned link + the
// exact decrypt/psql commands) and the list of downloads / restores / verifies
// with a live log for a running restore, like the deploy log. API:
// /api/projects/[id]/backups/[backupId] and .../backups/restores/[restoreId].

import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { CopyButton } from '@/components/ui/copy-button'
import { Download, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { timeAgo } from '../_lib/project-context'
import { formatTime } from '@/lib/format'

export interface RestoreRow {
	id: string
	kind: 'download' | 'restore' | 'verify' | 'drop'
	backupId: string | null
	targetDb: string | null
	status: 'running' | 'success' | 'failed'
	tableCount: number | null
	sizeBytes: number | null
	error: string | null
	output: string | null
	requestedBy: string | null
	startedAt: string
	finishedAt: string | null
	droppedAt: string | null
	// Restore db's DATABASE_URL (password masked), while it exists.
	databaseUrl: string | null
}

export interface DownloadInfo {
	url: string
	expiresAt: string
	sha256: string | null
	commands: string
}

export function fmtBytes(n: number | null): string {
	if (n == null) return '-'
	if (n < 1024) return `${n} B`
	const kb = n / 1024
	if (kb < 1024) return `${kb.toFixed(1)} KiB`
	const mb = kb / 1024
	if (mb < 1024) return `${mb.toFixed(1)} MiB`
	return `${(mb / 1024).toFixed(2)} GiB`
}

export function RowAction({
	label,
	title,
	icon: Icon,
	busy,
	disabled,
	onClick,
}: {
	label: string
	title: string
	icon: typeof Download
	busy: boolean
	disabled?: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			title={title}
			onClick={onClick}
			disabled={busy || disabled}
			className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent/30 disabled:opacity-50"
		>
			<Icon className={`h-3 w-3 ${busy ? 'animate-pulse' : ''}`} />
			{label}
		</button>
	)
}

export function DownloadPanel({ info, onClose }: { info: DownloadInfo; onClose: () => void }) {
	return (
		<div className="space-y-3 rounded-md border border-border bg-card p-4 text-sm">
			<div className="flex items-center gap-2">
				<div className="flex-1">
					<div className="font-medium">download link</div>
					<div className="text-xs text-muted-foreground">
						expires {formatTime(info.expiresAt)}. the file is encrypted: you need POWDER_BACKUP_KEY
						to open it. this download is in the activity log.
					</div>
				</div>
				<a
					href={info.url}
					className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-foreground/5 px-2 text-xs font-medium hover:bg-accent/30"
				>
					<Download className="h-3 w-3" />
					download
				</a>
				<button
					type="button"
					onClick={onClose}
					className="inline-flex h-7 items-center rounded-md border border-border px-2 text-xs hover:bg-accent/30"
				>
					close
				</button>
			</div>
			<div className="flex items-center justify-between gap-2">
				<div className="text-xs text-muted-foreground">
					open it on any machine with curl, openssl and psql. it is a plain SQL dump, so psql, not
					pg_restore.
				</div>
				<CopyButton
					value={info.commands}
					label="copy the commands"
					text="copy"
					targetId="backup-download-commands"
					size="sm"
					variant="outline"
				/>
			</div>
			<pre
				id="backup-download-commands"
				className="ph-no-capture max-h-[50vh] overflow-auto rounded-md bg-background p-3 font-mono text-xs leading-relaxed"
			>
				{info.commands}
			</pre>
		</div>
	)
}

const KIND_LABEL: Record<RestoreRow['kind'], string> = {
	download: 'download',
	restore: 'restore',
	verify: 'verify',
	drop: 'drop restore db',
}

export function RestoreList({
	projectId,
	rows,
	openId,
	setOpenId,
	onChange,
}: {
	projectId: string
	rows: RestoreRow[]
	openId: string | null
	setOpenId: (id: string | null) => void
	onChange: () => Promise<void>
}) {
	return (
		<div className="space-y-2">
			<div className="text-sm font-medium">downloads, restores and verifies</div>
			<div className="overflow-hidden rounded-md border border-border bg-card">
				<table className="w-full text-sm">
					<thead>
						<tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
							<th className="px-4 py-2 font-medium">when</th>
							<th className="px-4 py-2 font-medium">what</th>
							<th className="px-4 py-2 font-medium">database</th>
							<th className="px-4 py-2 font-medium">status</th>
							<th className="px-4 py-2 font-medium">by</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => {
							const expandable = r.kind === 'restore' || r.kind === 'verify'
							const open = openId === r.id
							return (
								<RestoreRowView
									key={r.id}
									projectId={projectId}
									row={r}
									open={open}
									onToggle={expandable ? () => setOpenId(open ? null : r.id) : undefined}
									onChange={onChange}
								/>
							)
						})}
					</tbody>
				</table>
			</div>
		</div>
	)
}

function RestoreRowView({
	projectId,
	row: initial,
	open,
	onToggle,
	onChange,
}: {
	projectId: string
	row: RestoreRow
	open: boolean
	onToggle?: () => void
	onChange: () => Promise<void>
}) {
	const [row, setRow] = useState(initial)
	const [log, setLog] = useState<string>(initial.output ?? '')
	const [unreachable, setUnreachable] = useState(false)
	const [dropOpen, setDropOpen] = useState(false)
	const [dropping, setDropping] = useState(false)
	const [dropError, setDropError] = useState<string | null>(null)
	const logRef = useRef<HTMLPreElement>(null)
	const onChangeRef = useRef(onChange)
	onChangeRef.current = onChange

	useEffect(() => setRow(initial), [initial])

	const running = row.status === 'running'
	// Poll the server while the row is open or running, like the deploy log.
	useEffect(() => {
		if (!open && !running) return
		let stop = false
		const tick = async () => {
			const res = await fetch(`/api/projects/${projectId}/backups/restores/${row.id}`).catch(
				() => null,
			)
			if (!res?.ok || stop) return
			const json = (await res.json()) as { restore: RestoreRow; log: string; reachable: boolean }
			setRow(json.restore)
			setLog(json.log)
			setUnreachable(!json.reachable)
			if (running && json.restore.status !== 'running') void onChangeRef.current()
		}
		void tick()
		const t = running ? setInterval(tick, 3000) : null
		return () => {
			stop = true
			if (t) clearInterval(t)
		}
	}, [open, running, row.id, projectId])

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the bottom on every new log chunk
	useEffect(() => {
		if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
	}, [log])

	const drop = async () => {
		setDropping(true)
		setDropError(null)
		try {
			const res = await fetch(`/api/projects/${projectId}/backups/restores/${row.id}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'drop' }),
			})
			const json = (await res.json().catch(() => ({}))) as { error?: string }
			if (!res.ok) setDropError(json.error ?? `drop failed (${res.status})`)
			await onChange()
		} finally {
			setDropping(false)
			setDropOpen(false)
		}
	}

	const dotCls =
		row.status === 'success'
			? 'bg-success'
			: row.status === 'failed'
				? 'bg-destructive'
				: 'bg-warning animate-pulse'
	const canDrop = row.kind === 'restore' && !running && !row.droppedAt && !!row.targetDb
	const urlLine = row.databaseUrl ? `DATABASE_URL=${row.databaseUrl}` : null

	return (
		<>
			<tr className="group border-b border-border last:border-0">
				<td className="px-4 py-2 text-muted-foreground">
					{onToggle ? (
						<button
							type="button"
							onClick={onToggle}
							className="hover:text-foreground hover:underline"
						>
							{timeAgo(row.startedAt)}
						</button>
					) : (
						timeAgo(row.startedAt)
					)}
				</td>
				<td className="px-4 py-2 text-xs">
					{onToggle ? (
						<button type="button" onClick={onToggle} className="hover:underline">
							{KIND_LABEL[row.kind]} {open ? '▾' : '▸'}
						</button>
					) : (
						KIND_LABEL[row.kind]
					)}
				</td>
				<td className="px-4 py-2 font-mono text-xs">
					{row.targetDb ?? '-'}
					{row.droppedAt && row.kind === 'restore' && (
						<span className="ml-1 text-muted-foreground">(dropped)</span>
					)}
				</td>
				<td className="px-4 py-2">
					<div className="flex items-center gap-1.5">
						<span className={`inline-block h-1.5 w-1.5 rounded-full ${dotCls}`} aria-hidden />
						<span className="font-mono text-xs">{row.status}</span>
						{/* beside the short status: a wide error would push it out of a phone-width table */}
						{row.error && (
							<CopyButton value={row.error} label="copy the error" reveal className="-my-1" />
						)}
						{row.status === 'success' && row.tableCount != null && (
							<span className="text-xs text-muted-foreground">
								· {row.tableCount} tables
								{row.sizeBytes != null ? `, ${fmtBytes(row.sizeBytes)}` : ''}
							</span>
						)}
					</div>
					{row.error && (
						<div
							className="ph-no-capture mt-0.5 max-w-md truncate text-xs text-destructive/80"
							title={row.error}
						>
							{row.error}
						</div>
					)}
				</td>
				<td className="max-w-[10rem] truncate px-4 py-2 text-xs text-muted-foreground">
					{row.requestedBy ?? '-'}
				</td>
			</tr>
			{open && (
				<tr className="border-b border-border last:border-0">
					<td colSpan={5} className="space-y-3 px-4 py-3">
						{unreachable && (
							<div className="text-xs text-warning">
								server unreachable, showing the last known state
							</div>
						)}
						<div className="relative">
							<pre
								ref={logRef}
								id={`restore-log-${row.id}`}
								className="ph-no-capture max-h-[50vh] overflow-auto rounded-md bg-background p-3 pr-10 font-mono text-xs leading-relaxed"
							>
								{log || (running ? 'waiting for output…' : '(no output)')}
							</pre>
							{log && (
								<CopyButton
									value={() => log}
									label="copy the output"
									targetId={`restore-log-${row.id}`}
									className="absolute right-1.5 top-1.5"
								/>
							)}
						</div>
						{row.kind === 'restore' &&
							row.status === 'success' &&
							!row.droppedAt &&
							row.targetDb && (
								<div className="space-y-2 text-xs">
									<div className="font-medium text-foreground">
										restored into <code className="font-mono">{row.targetDb}</code>. the app still
										uses the live database.
									</div>
									{urlLine && (
										<div className="flex items-start gap-2">
											<pre className="ph-no-capture flex-1 overflow-auto rounded-md bg-muted/40 px-2 py-1.5 font-mono text-2xs">
												{urlLine}
											</pre>
											<CopyButton
												value={urlLine}
												label="copy the DATABASE_URL line"
												text="copy"
												size="sm"
												variant="outline"
											/>
										</div>
									)}
									<ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
										<li>
											to switch: set this DATABASE_URL (real password in place of ****) on the{' '}
											<a href={`/projects/${projectId}/env`} className="underline">
												env tab
											</a>{' '}
											and redeploy. to go back, roll the env var back there and redeploy.
										</li>
										<li>
											to look inside without switching:{' '}
											<code className="font-mono">
												docker exec -it &lt;db container&gt; psql -U &lt;user&gt; -d {row.targetDb}
											</code>
										</li>
										<li>
											done with it? drop it. postgres refuses while anything is still connected.
										</li>
									</ul>
								</div>
							)}
						{canDrop && (
							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={() => setDropOpen(true)}
									disabled={dropping}
									className="inline-flex h-7 items-center gap-1 rounded-md border border-destructive/40 px-2 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
								>
									<Trash2 className="h-3 w-3" />
									drop restore database
								</button>
								{dropError && <span className="text-xs text-destructive">{dropError}</span>}
							</div>
						)}
						<ConfirmDialog
							open={dropOpen}
							title={`drop ${row.targetDb}?`}
							description="deletes this restore database. only names ending in _restore_<yyyymmdd_hhmm> can be dropped, never the live database and never the one DATABASE_URL points at."
							confirmLabel="drop"
							danger
							loading={dropping}
							onConfirm={drop}
							onClose={() => setDropOpen(false)}
						/>
					</td>
				</tr>
			)}
		</>
	)
}
