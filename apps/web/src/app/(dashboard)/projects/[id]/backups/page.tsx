'use client'

import { SkeletonList } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { buttonVariants } from '@/components/ui/button-variants'
import Link from 'next/link'
// Backups tab: consumes /api/projects/[id]/backups GET (list) + POST (trigger).
// The list shows when each backup ran, its size, and any errors. The trigger
// button fires a backup row immediately; the actual dump happens detached on
// the app server and the row finalizes on the next backup tick (≤1h).
// Per successful backup (admin): download, restore into a NEW database, verify
// (restore-ui.tsx).

import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, HardDrive, Play, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { type BackupDatabase, BackupDatabaseCard } from './database-form'
import { timeAgo, useProject } from '../_lib/project-context'
import {
	type DownloadInfo,
	DownloadPanel,
	type RestoreRow,
	RestoreList,
	RowAction,
	fmtBytes,
} from './restore-ui'

interface BackupRow {
	id: string
	serverId: string
	containerName: string
	s3Key: string
	sizeBytes: number | null
	startedAt: string
	finishedAt: string | null
	status: 'running' | 'success' | 'failed'
	error: string | null
}

interface BackupsResponse {
	configured: boolean
	hasPostgres: boolean
	// False for host-postgres apps: restore needs the db in a container.
	restorable: boolean
	database: BackupDatabase
	backups: BackupRow[]
	restores: RestoreRow[]
}

export default function BackupsPage() {
	const { id } = useProject()
	const [data, setData] = useState<BackupsResponse | null>(null)
	const [triggering, setTriggering] = useState(false)
	const [refreshing, setRefreshing] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const dataRef = useRef<BackupsResponse | null>(null)
	dataRef.current = data
	const [download, setDownload] = useState<DownloadInfo | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [confirm, setConfirm] = useState<{ backup: BackupRow; mode: 'restore' | 'verify' } | null>(
		null,
	)
	const [openRestore, setOpenRestore] = useState<string | null>(null)

	const load = useCallback(async () => {
		try {
			const res = await fetch(`/api/projects/${id}/backups`)
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { error?: string }
				setError(err.error ?? `failed to load backups (${res.status})`)
				return
			}
			const json = (await res.json()) as BackupsResponse
			setError(null)
			setData(json)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'failed to load backups')
		}
	}, [id])

	useEffect(() => {
		load()
		// Poll every 10s while a backup is running.
		const t = setInterval(() => {
			if (dataRef.current?.backups.some((b) => b.status === 'running')) load()
		}, 10_000)
		return () => clearInterval(t)
	}, [load])

	const trigger = async () => {
		setTriggering(true)
		setError(null)
		try {
			const res = await fetch(`/api/projects/${id}/backups`, { method: 'POST' })
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { error?: string }
				setError(`backup failed: ${err.error ?? res.status}`)
			} else {
				setTimeout(load, 500)
			}
		} finally {
			setTriggering(false)
		}
	}

	const act = async (backup: BackupRow, action: 'download' | 'restore' | 'verify') => {
		setBusy(`${backup.id}:${action}`)
		setError(null)
		try {
			const res = await fetch(`/api/projects/${id}/backups/${backup.id}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action }),
			})
			const json = (await res.json().catch(() => ({}))) as Partial<DownloadInfo> & {
				error?: string
				restore?: RestoreRow
			}
			if (!res.ok) {
				setError(`${action} failed: ${json.error ?? res.status}`)
				return
			}
			if (action === 'download') {
				setDownload({
					url: json.url ?? '',
					expiresAt: json.expiresAt ?? '',
					sha256: json.sha256 ?? null,
					commands: json.commands ?? '',
				})
			} else if (json.restore) {
				setOpenRestore(json.restore.id)
			}
			await load()
		} finally {
			setBusy(null)
			setConfirm(null)
		}
	}

	if (!data) {
		return error ? <p className="text-sm text-destructive">{error}</p> : <SkeletonList />
	}

	const databaseCard = (
		<BackupDatabaseCard
			key={JSON.stringify(data.database)}
			projectId={id}
			database={data.database}
			turnOn={!data.hasPostgres}
			onSaved={load}
		/>
	)

	if (!data.hasPostgres) {
		return (
			<div className="space-y-4">
				<div className="rounded-md border border-border bg-card p-6 text-sm">
					<div className="flex items-start gap-2 text-muted-foreground">
						<HardDrive className="h-4 w-4 mt-0.5 shrink-0" />
						<div>
							<div className="font-medium text-foreground">no postgres on this app</div>
							<div className="mt-1">
								backups run for apps with a postgres database. an app created with a database dumps
								its own container; for a shared or host postgres, set it below.
							</div>
						</div>
					</div>
				</div>
				{databaseCard}
			</div>
		)
	}

	if (!data.configured) {
		return (
			<div className="space-y-4">
				<EmptyState
					icon={HardDrive}
					title="backups are not set up on this powder"
					action={
						<Link
							href="/docs/backups#configure-the-target"
							className={buttonVariants({ size: 'sm', variant: 'outline' })}
						>
							how to set up backups
						</Link>
					}
				>
					powder dumps this app's Postgres once a day, encrypts it and uploads it to S3-compatible
					storage once <code className="font-mono text-foreground">BACKUP_S3_*</code> and{' '}
					<code className="font-mono text-foreground">POWDER_BACKUP_KEY</code> are set in
					powder.env.
				</EmptyState>
				{databaseCard}
			</div>
		)
	}

	const lastSuccess = data.backups.find((b) => b.status === 'success')
	const restores = data.restores ?? []
	const restoreRunning = restores.some((r) => r.status === 'running')
	const lastVerify = restores.find((r) => r.kind === 'verify' && r.status !== 'running')

	return (
		<div className="space-y-4">
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex items-center gap-3">
				<div className="flex-1 text-sm text-muted-foreground">
					{lastSuccess ? (
						<>
							last backup <span className="text-foreground">{timeAgo(lastSuccess.startedAt)}</span>{' '}
							· {fmtBytes(lastSuccess.sizeBytes)}
						</>
					) : (
						'no successful backups yet'
					)}
					{lastVerify && (
						<>
							{' '}
							· last verify{' '}
							<span
								className={lastVerify.status === 'success' ? 'text-success' : 'text-destructive'}
							>
								{lastVerify.status === 'success'
									? `ok, ${lastVerify.tableCount ?? '?'} tables`
									: 'failed'}
							</span>{' '}
							{timeAgo(lastVerify.startedAt)}
						</>
					)}
				</div>
				<button
					type="button"
					onClick={() => {
						setRefreshing(true)
						void load()
							.finally(() => setRefreshing(false))
							.catch(() => {})
					}}
					className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs hover:bg-accent/30"
				>
					<RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
					refresh
				</button>
				<button
					type="button"
					onClick={trigger}
					disabled={triggering || data.backups.some((b) => b.status === 'running')}
					className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-foreground/5 px-3 text-xs font-medium hover:bg-accent/30 disabled:opacity-50"
				>
					<Play className={`h-3 w-3 ${triggering ? 'animate-pulse' : ''}`} />
					{triggering
						? 'triggering…'
						: data.backups.some((b) => b.status === 'running')
							? 'running…'
							: 'back up now'}
				</button>
			</div>

			{data.backups.length === 0 ? (
				<div className="rounded-md border border-dashed border-border bg-card/50 p-6 text-center text-sm">
					<div className="font-medium">no backups yet</div>
					<div className="mt-1 text-muted-foreground">
						they fire automatically every 24h, or click "back up now"
					</div>
				</div>
			) : (
				<div className="overflow-hidden rounded-md border border-border bg-card">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
								<th className="px-4 py-2 font-medium">when</th>
								<th className="px-4 py-2 font-medium">status</th>
								<th className="px-4 py-2 font-medium">size</th>
								<th className="px-4 py-2 font-medium">key</th>
								<th className="px-4 py-2 text-right font-medium">get it back</th>
							</tr>
						</thead>
						<tbody>
							{data.backups.map((b) => {
								const dotCls =
									b.status === 'success'
										? 'bg-success'
										: b.status === 'failed'
											? 'bg-destructive'
											: 'bg-warning animate-pulse'
								return (
									<tr key={b.id} className="border-b border-border last:border-0">
										<td className="px-4 py-2 text-muted-foreground">{timeAgo(b.startedAt)}</td>
										<td className="px-4 py-2">
											<div className="flex items-center gap-1.5">
												<span
													className={`inline-block h-1.5 w-1.5 rounded-full ${dotCls}`}
													aria-hidden
												/>
												<span className="font-mono text-xs">{b.status}</span>
											</div>
											{b.error && (
												<div
													className="mt-0.5 truncate text-xs text-destructive/80 max-w-md"
													title={b.error}
												>
													{b.error}
												</div>
											)}
										</td>
										<td className="px-4 py-2 font-mono text-xs">{fmtBytes(b.sizeBytes)}</td>
										<td
											className="px-4 py-2 font-mono text-xs text-muted-foreground truncate max-w-xs"
											title={b.s3Key}
										>
											{b.s3Key}
										</td>
										<td className="px-4 py-2 text-right">
											{b.status === 'success' && (
												<div className="inline-flex gap-1">
													<RowAction
														label="download"
														title="short-lived download link + the decrypt/psql commands"
														icon={Download}
														busy={busy === `${b.id}:download`}
														onClick={() => act(b, 'download')}
													/>
													{data.restorable && (
														<>
															<RowAction
																label="restore"
																title="restore into a NEW database next to the live one"
																icon={RotateCcw}
																busy={busy === `${b.id}:restore`}
																disabled={restoreRunning}
																onClick={() => setConfirm({ backup: b, mode: 'restore' })}
															/>
															<RowAction
																label="verify"
																title="restore into a throwaway database, count tables, drop it"
																icon={ShieldCheck}
																busy={busy === `${b.id}:verify`}
																disabled={restoreRunning}
																onClick={() => setConfirm({ backup: b, mode: 'verify' })}
															/>
														</>
													)}
												</div>
											)}
										</td>
									</tr>
								)
							})}
						</tbody>
					</table>
				</div>
			)}

			{download && <DownloadPanel info={download} onClose={() => setDownload(null)} />}

			{restores.length > 0 && (
				<RestoreList
					projectId={id}
					rows={restores}
					openId={openRestore}
					setOpenId={setOpenRestore}
					onChange={load}
				/>
			)}

			{databaseCard}

			<ConfirmDialog
				open={confirm !== null}
				title={confirm?.mode === 'verify' ? 'verify this backup?' : 'restore into a new database?'}
				description={
					confirm?.mode === 'verify'
						? 'restores this backup into a throwaway database next to the live one, counts its tables, then drops it. the live database is not touched. big backups take a while and load the db container.'
						: "creates a NEW database <db>_restore_<yyyymmdd_hhmm> in the app's db container and loads this backup into it. the live database is not touched; the app keeps using it until you change DATABASE_URL yourself."
				}
				confirmLabel={confirm?.mode === 'verify' ? 'verify' : 'restore'}
				loading={busy !== null}
				onConfirm={() => {
					if (confirm) void act(confirm.backup, confirm.mode)
				}}
				onClose={() => setConfirm(null)}
			/>
		</div>
	)
}
