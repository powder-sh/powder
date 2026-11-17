'use client'

import { SkeletonList } from '@/components/ui/skeleton'
import { Alert } from '@/components/ui/alert'
import { EmptyState } from '@/components/ui/empty-state'
// Env vars tab: Vercel-style. The plaintext value never leaves the server
// after the first save: the dashboard only shows the value's length, and
// rotation = overwriting with a fresh value. If you forgot what it was, it's
// gone. Same model as Vercel; same protection against accidentally echoing
// secrets into chat, logs, or commits.

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FieldRow, Input, Textarea } from '@/components/ui/input'
import { useToast } from '@/components/ui/toast'
import {
	Clock,
	Eye,
	EyeOff,
	History,
	KeyRound,
	Loader2,
	Plus,
	RotateCcw,
	Trash2,
	Undo2,
	Upload,
} from 'lucide-react'
import { use, useEffect, useId, useState } from 'react'
import { cn } from '@/lib/cn'
import { timeAgoDays } from '@/lib/format'
import { AgentHelp } from '@/components/agent-help'
import { envPrompt } from '@/lib/agent-help-prompts'
import { repoSlug, useProject } from '../_lib/project-context'

type Scope = 'production' | 'preview' | 'development'

interface EnvVar {
	id: string
	key: string
	scope: Scope
	valuePreview: string
	createdAt: string
	updatedAt: string
	lastRotatedAt: string | null
}

const SCOPES: Scope[] = ['production', 'preview', 'development']

interface AuditEntry {
	id: string
	createdAt: string
	actorUserId: string | null
	actorKind: 'human_session' | 'api_token' | 'system'
	actorIp: string | null
	action: 'create' | 'update' | 'delete' | 'rollback'
	key: string
	scope: Scope
	oldValuePreview: string | null
	newValuePreview: string | null
}

interface VersionEntry {
	id: string
	createdAt: string
	valuePreview: string
	setByUserId: string | null
}

export default function EnvVarsPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = use(params)
	const { project } = useProject()
	const [vars, setVars] = useState<EnvVar[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [tab, setTab] = useState<Scope>('production')
	const [showAddForm, setShowAddForm] = useState(false)
	const [showImport, setShowImport] = useState(false)
	const [showAudit, setShowAudit] = useState(false)
	const [audit, setAudit] = useState<AuditEntry[]>([])
	const [busy, setBusy] = useState(false)
	const [actionError, setActionError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [confirmBackfill, setConfirmBackfill] = useState(false)
	const [confirmDelete, setConfirmDelete] = useState<{ key: string; scope: Scope } | null>(null)

	async function load() {
		try {
			const res = await fetch(`/api/projects/${id}/env`)
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				setError(body.error ?? `HTTP ${res.status}`)
				return
			}
			const data = (await res.json()) as { vars: EnvVar[] }
			setVars(data.vars)
			setError(null)
		} catch (e) {
			setError(e instanceof Error ? e.message : 'fetch failed')
		}
	}

	async function loadAudit() {
		try {
			const res = await fetch(`/api/projects/${id}/env/audit`)
			if (!res.ok) return
			const data = (await res.json()) as { entries: AuditEntry[] }
			setAudit(data.entries)
		} catch {
			// silent: audit panel just stays empty
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the project id changes; load is recreated every render and reads id itself
	useEffect(() => {
		load()
	}, [id])

	const visible = (vars ?? []).filter((v) => v.scope === tab)

	// Returns an error message on failure, null on success.
	async function saveVar(key: string, value: string, scope: Scope): Promise<string | null> {
		setBusy(true)
		setActionError(null)
		try {
			const res = await fetch(`/api/projects/${id}/env`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key, value, scope }),
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				const msg = `save failed: ${body.error ?? res.status}`
				setActionError(msg)
				return msg
			}
			await load()
			setShowAddForm(false)
			return null
		} catch (e) {
			const msg = `save failed: ${e instanceof Error ? e.message : 'network error'}`
			setActionError(msg)
			return msg
		} finally {
			setBusy(false)
		}
	}

	async function deleteVar(key: string, scope: Scope) {
		setConfirmDelete(null)
		setBusy(true)
		setActionError(null)
		try {
			const res = await fetch(`/api/projects/${id}/env/${encodeURIComponent(key)}?scope=${scope}`, {
				method: 'DELETE',
			})
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				setActionError(`delete failed: ${body.error ?? res.status}`)
				return
			}
			await load()
		} catch (e) {
			setActionError(`delete failed: ${e instanceof Error ? e.message : 'network error'}`)
		} finally {
			setBusy(false)
		}
	}

	async function backfillFromFile() {
		setConfirmBackfill(false)
		setBusy(true)
		setActionError(null)
		setNotice(null)
		try {
			const res = await fetch(`/api/projects/${id}/env/backfill`, { method: 'POST' })
			const body = (await res.json().catch(() => ({}))) as {
				ok?: boolean
				path?: string
				imported?: number
				skipped?: number
				existing?: number
				deniedKeys?: string[]
				note?: string
				error?: string
			}
			if (!res.ok || !body.ok) {
				setActionError(`import failed: ${body.error ?? res.status}`)
				return
			}
			setNotice(
				body.note
					? body.note
					: `imported ${body.imported} from ${body.path}, kept ${body.existing ?? 0} existing, skipped ${body.skipped} (malformed lines${deniedNote(body.deniedKeys)})`,
			)
			await load()
		} finally {
			setBusy(false)
		}
	}

	if (error)
		return (
			<Alert tone="destructive" title="could not load">
				{error}
			</Alert>
		)
	if (!vars) return <SkeletonList />

	return (
		<div className="space-y-6">
			<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
				<div className="min-w-0 max-w-xl">
					<h2 className="text-base font-semibold tracking-tight">env vars</h2>
					<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
						stored encrypted and written to the app's env file on every deploy. a saved value cannot
						be read back: change it or delete it.
					</p>
				</div>
				<div className="flex flex-wrap gap-2 lg:shrink-0 lg:justify-end">
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							setShowAudit((v) => {
								const next = !v
								if (next) loadAudit()
								return next
							})
						}}
					>
						<History className="h-3 w-3" />
						{showAudit ? 'hide audit' : 'audit'}
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setShowImport((v) => !v)}>
						<Upload className="h-3 w-3" />
						paste .env
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => setConfirmBackfill(true)}
						disabled={busy}
					>
						<RotateCcw className="h-3 w-3" />
						import from server
					</Button>
					<Button size="sm" onClick={() => setShowAddForm((v) => !v)}>
						<Plus className="h-3 w-3" />
						add variable
					</Button>
				</div>
			</div>

			{project && (
				<AgentHelp
					title={project.hasPostgres ? 'audit env vars and Postgres wiring' : 'audit env vars'}
					description="run it in a checkout of this app's repo. it lists what the code reads and what is missing here."
					prompt={envPrompt({
						app: project.containerName,
						repo: repoSlug(project.repoUrl),
						branch: project.branch,
						keys: vars.map((v) => ({ scope: v.scope, key: v.key })),
						hasPostgres: project.hasPostgres,
						hasKv: project.hasKv,
					})}
					note="includes variable names only, never their values."
				/>
			)}

			{actionError && <Alert tone="destructive">{actionError}</Alert>}
			{notice && <Alert tone="success">{notice}</Alert>}

			{showAudit && <AuditPanel entries={audit} onRefresh={loadAudit} />}

			<div
				role="tablist"
				aria-label="env scope"
				className="flex gap-0.5 overflow-x-auto border-b border-border"
			>
				{SCOPES.map((s) => {
					const count = vars.filter((v) => v.scope === s).length
					const active = tab === s
					return (
						<button
							key={s}
							type="button"
							role="tab"
							aria-selected={active}
							onClick={() => setTab(s)}
							className={`-mb-px inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm transition-colors ${
								active
									? 'border-foreground font-medium text-foreground'
									: 'border-transparent text-muted-foreground hover:text-foreground'
							}`}
						>
							{s}
							<Badge variant="outline" className="text-2xs">
								{count}
							</Badge>
						</button>
					)
				})}
			</div>

			{showAddForm && (
				<AddVarForm
					scope={tab}
					onSave={(k, v, sc) => {
						void saveVar(k, v, sc)
					}}
					onCancel={() => setShowAddForm(false)}
					busy={busy}
				/>
			)}

			{showImport && (
				<PasteImportForm
					projectId={id}
					scope={tab}
					onDone={() => {
						setShowImport(false)
						load()
					}}
				/>
			)}

			{visible.length === 0 ? (
				<EmptyState icon={KeyRound} title={`no ${tab} env vars yet`}>
					add a variable, paste a .env, or import the env file from the server.
				</EmptyState>
			) : (
				<div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
					<div className="hidden grid-cols-12 gap-2 border-b border-border bg-muted/40 px-4 py-2.5 text-xs font-medium text-muted-foreground sm:grid">
						<div className="col-span-3">key</div>
						<div className="col-span-2">value</div>
						<div className="col-span-2">last rotated</div>
						<div className="col-span-2">added</div>
						<div className="col-span-3 text-right">
							<span className="sr-only">actions</span>
						</div>
					</div>
					{visible.map((v) => (
						<VarRow
							key={v.id}
							v={v}
							projectId={id}
							onDelete={() => setConfirmDelete({ key: v.key, scope: v.scope })}
							onRotate={(value) => saveVar(v.key, value, v.scope)}
							onAfterRollback={() => {
								load()
								if (showAudit) loadAudit()
							}}
							busy={busy}
						/>
					))}
				</div>
			)}
			<ConfirmDialog
				open={confirmBackfill}
				title="import the env file from the server?"
				description="reads the env file on the server once and stores each KEY=value encrypted in powder. variables already in powder are kept; only missing keys are added. safe to run again."
				confirmLabel="import"
				loading={busy}
				onConfirm={() => void backfillFromFile()}
				onClose={() => setConfirmBackfill(false)}
			/>
			<ConfirmDialog
				open={confirmDelete !== null}
				title={`delete ${confirmDelete?.key ?? ''} (${confirmDelete?.scope ?? ''})?`}
				confirmLabel="delete"
				danger
				loading={busy}
				onConfirm={() => {
					if (confirmDelete) void deleteVar(confirmDelete.key, confirmDelete.scope)
				}}
				onClose={() => setConfirmDelete(null)}
			/>
		</div>
	)
}

function AddVarForm({
	scope,
	onSave,
	onCancel,
	busy,
}: {
	scope: Scope
	onSave: (key: string, value: string, scope: Scope) => void
	onCancel: () => void
	busy: boolean
}) {
	const [key, setKey] = useState('')
	const [value, setValue] = useState('')
	const [reveal, setReveal] = useState(false)
	const formId = useId()
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				if (!key.trim() || !value) return
				onSave(key.trim(), value, scope)
			}}
			className="rounded-md border border-border bg-card p-4 space-y-3"
		>
			<div className="text-xs text-muted-foreground">
				adding to <span className="font-mono">{scope}</span> scope
			</div>
			<FieldRow>
				<Input
					id={`${formId}-key`}
					label="key"
					value={key}
					onChange={(e) => setKey(e.target.value)}
					placeholder="DATABASE_URL"
					className="font-mono"
					autoCapitalize="none"
					autoCorrect="off"
					spellCheck={false}
				/>
				<Field id={`${formId}-value`} label="value">
					<div className="flex gap-1">
						<Input
							id={`${formId}-value`}
							type={reveal ? 'text' : 'password'}
							value={value}
							onChange={(e) => setValue(e.target.value)}
							className="ph-no-capture min-w-0 flex-1 font-mono"
						/>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							onClick={() => setReveal((v) => !v)}
							aria-label={reveal ? 'hide value' : 'show value'}
							aria-pressed={reveal}
						>
							{reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
						</Button>
					</div>
				</Field>
			</FieldRow>
			<div className="flex justify-end gap-2">
				<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
					cancel
				</Button>
				<Button type="submit" size="sm" disabled={busy || !key.trim() || !value}>
					{busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
					save
				</Button>
			</div>
		</form>
	)
}

function PasteImportForm({
	projectId,
	scope,
	onDone,
}: {
	projectId: string
	scope: Scope
	onDone: () => void
}) {
	const [text, setText] = useState('')
	const [overwrite, setOverwrite] = useState(true)
	const [busy, setBusy] = useState(false)
	const toast = useToast()

	async function submit() {
		setBusy(true)
		try {
			const res = await fetch(`/api/projects/${projectId}/env`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text, scope, overwrite }),
			})
			const body = (await res.json()) as {
				imported?: number
				skipped?: number
				existing?: number
				deniedKeys?: string[]
				error?: string
			}
			if (!res.ok) {
				toast.error(`import failed: ${body.error ?? res.status}`)
				return
			}
			toast.success(
				`imported ${body.imported}, skipped ${body.skipped} malformed${deniedNote(body.deniedKeys)}${
					!overwrite && body.existing ? `, ${body.existing} already existed` : ''
				}`,
			)
			onDone()
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="rounded-md border border-border bg-card p-4 space-y-3">
			<div className="text-xs text-muted-foreground">
				paste a .env-style block. lines starting with <span className="font-mono">#</span> and
				blanks are ignored. importing to <span className="font-mono">{scope}</span>.
			</div>
			<Textarea
				aria-label="env block to import"
				value={text}
				onChange={(e) => setText(e.target.value)}
				rows={10}
				placeholder={'DATABASE_URL=postgres://...\nAPI_KEY=sk_live_...\nNODE_ENV=production'}
				textareaSize="sm"
				className="font-mono"
			/>
			<label className="flex items-center gap-2 text-xs text-muted-foreground">
				<input
					type="checkbox"
					checked={overwrite}
					onChange={(e) => setOverwrite(e.target.checked)}
				/>
				overwrite existing keys
			</label>
			<div className="flex justify-end gap-2">
				<Button type="button" size="sm" variant="ghost" onClick={onDone}>
					cancel
				</Button>
				<Button type="button" size="sm" onClick={submit} disabled={busy || !text.trim()}>
					{busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
					import
				</Button>
			</div>
		</div>
	)
}

function VarRow({
	v,
	projectId,
	onDelete,
	onRotate,
	onAfterRollback,
	busy,
}: {
	v: EnvVar
	projectId: string
	onDelete: () => void
	onRotate: (newValue: string) => Promise<string | null>
	onAfterRollback: () => void
	busy: boolean
}) {
	const [rotating, setRotating] = useState(false)
	const [newValue, setNewValue] = useState('')
	const [rotateError, setRotateError] = useState<string | null>(null)
	const [showHistory, setShowHistory] = useState(false)
	const [versions, setVersions] = useState<VersionEntry[] | null>(null)
	const [rollingBack, setRollingBack] = useState<string | null>(null)
	const [confirmRollback, setConfirmRollback] = useState<string | null>(null)
	const toast = useToast()

	async function toggleHistory() {
		const next = !showHistory
		setShowHistory(next)
		if (next && versions === null) {
			const res = await fetch(
				`/api/projects/${projectId}/env/${encodeURIComponent(v.key)}/history?scope=${v.scope}`,
			)
			if (!res.ok) {
				setVersions([])
				return
			}
			const data = (await res.json()) as { versions: VersionEntry[] }
			setVersions(data.versions)
		}
	}

	async function rollback(versionId: string) {
		setConfirmRollback(null)
		setRollingBack(versionId)
		try {
			const res = await fetch(
				`/api/projects/${projectId}/env/${encodeURIComponent(v.key)}/rollback`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ versionId }),
				},
			)
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string }
				toast.error(`rollback failed: ${body.error ?? res.status}`)
				return
			}
			// Refresh history (current value just got snapshotted, restored value is now current).
			const histRes = await fetch(
				`/api/projects/${projectId}/env/${encodeURIComponent(v.key)}/history?scope=${v.scope}`,
			)
			if (histRes.ok) {
				const data = (await histRes.json()) as { versions: VersionEntry[] }
				setVersions(data.versions)
			}
			onAfterRollback()
		} finally {
			setRollingBack(null)
		}
	}

	return (
		<>
			<div className="grid grid-cols-2 items-center gap-x-2 gap-y-1.5 border-b border-border px-4 py-3 text-sm last:border-b-0 sm:grid-cols-12 sm:gap-2">
				<div className="col-span-2 truncate font-mono text-xs font-medium sm:col-span-3">
					{v.key}
				</div>
				<div
					className="col-span-2 truncate font-mono text-xs text-muted-foreground"
					title={v.valuePreview || undefined}
				>
					{v.valuePreview ? `${v.valuePreview}` : '***'}
				</div>
				<div className="hidden text-xs text-muted-foreground sm:col-span-2 sm:block">
					{v.lastRotatedAt ? timeAgoDays(v.lastRotatedAt) : '-'}
				</div>
				<div className="hidden text-xs text-muted-foreground sm:col-span-2 sm:block">
					{timeAgoDays(v.createdAt)}
				</div>
				<div
					className={cn(
						'col-span-2 flex flex-wrap justify-start gap-1 sm:col-span-3 sm:ml-0 sm:justify-end',
						// Ghost buttons line their text up with the row; a field lines up its border.
						!rotating && '-ml-2',
					)}
				>
					{rotating ? (
						<>
							<Input
								type="password"
								value={newValue}
								onChange={(e) => setNewValue(e.target.value)}
								placeholder="new value"
								aria-label={`new value for ${v.key}`}
								inputSize="sm"
								className="ph-no-capture min-w-24 flex-1 basis-0 font-mono"
							/>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								disabled={busy || !newValue}
								onClick={async () => {
									setRotateError(null)
									const err = await onRotate(newValue)
									if (err) {
										setRotateError(err)
										return
									}
									setRotating(false)
									setNewValue('')
								}}
							>
								save
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => {
									setRotating(false)
									setNewValue('')
									setRotateError(null)
								}}
							>
								cancel
							</Button>
						</>
					) : (
						<>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={toggleHistory}
								title="the last 5 values, each one click to roll back to"
							>
								<Clock className="h-3 w-3" />
								history
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => setRotating(true)}
								title="replace the value; the old one stays in history"
							>
								<RotateCcw className="h-3 w-3" />
								rotate
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={onDelete}
								title="delete: the container stops seeing it on the next deploy"
								aria-label={`delete ${v.key}`}
								className="w-8 px-0 hover:bg-destructive/10 hover:text-destructive"
							>
								<Trash2 className="h-3.5 w-3.5" />
							</Button>
						</>
					)}
				</div>
			</div>
			{rotating && rotateError && (
				<div className="border-b border-border px-4 py-2 text-xs text-destructive">
					{rotateError}
				</div>
			)}
			{showHistory && (
				<div className="border-b border-border bg-muted/20 px-4 py-3 text-xs">
					<div className="mb-2 text-2xs text-muted-foreground">previous values (last 5)</div>
					{versions === null ? (
						<p className="text-muted-foreground">loading…</p>
					) : versions.length === 0 ? (
						<p className="text-muted-foreground">no prior versions: this is the first value set.</p>
					) : (
						<div className="space-y-1">
							{versions.map((ver) => (
								<div
									key={ver.id}
									className="flex items-center gap-3 rounded border border-border bg-background/50 px-2 py-1"
								>
									<span className="font-mono text-muted-foreground">
										{ver.valuePreview || '***'}
									</span>
									<span className="text-muted-foreground">{timeAgoDays(ver.createdAt)}</span>
									<Button
										type="button"
										size="sm"
										variant="outline"
										className="ml-auto"
										disabled={!!rollingBack}
										onClick={() => setConfirmRollback(ver.id)}
									>
										{rollingBack === ver.id ? (
											<Loader2 className="mr-1 h-3 w-3 animate-spin" />
										) : (
											<Undo2 className="h-3 w-3" />
										)}
										restore
									</Button>
								</div>
							))}
						</div>
					)}
				</div>
			)}
			<ConfirmDialog
				open={confirmRollback !== null}
				title={`restore the previous value of ${v.key}?`}
				confirmLabel="restore"
				loading={rollingBack !== null}
				onConfirm={() => {
					if (confirmRollback) void rollback(confirmRollback)
				}}
				onClose={() => setConfirmRollback(null)}
			/>
		</>
	)
}

function AuditPanel({
	entries,
	onRefresh,
}: {
	entries: AuditEntry[]
	onRefresh: () => void
}) {
	if (entries.length === 0) {
		return (
			<div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs">
				<div className="flex items-center justify-between">
					<span className="text-muted-foreground">no audit entries yet.</span>
					<Button type="button" size="sm" variant="ghost" onClick={onRefresh}>
						refresh
					</Button>
				</div>
			</div>
		)
	}
	return (
		<div className="rounded-md border border-border bg-muted/10 p-4 space-y-2 text-xs">
			<div className="flex items-center justify-between">
				<div className="text-2xs text-muted-foreground">recent changes ({entries.length})</div>
				<Button type="button" size="sm" variant="ghost" onClick={onRefresh}>
					refresh
				</Button>
			</div>
			<div className="max-h-72 overflow-auto rounded border border-border bg-background/50">
				<table className="w-full">
					<thead className="bg-muted/30 text-2xs text-muted-foreground">
						<tr>
							<th className="px-2 py-1 text-left">when</th>
							<th className="px-2 py-1 text-left">action</th>
							<th className="px-2 py-1 text-left">key</th>
							<th className="px-2 py-1 text-left">scope</th>
							<th className="px-2 py-1 text-left">old → new</th>
							<th className="px-2 py-1 text-left">actor</th>
						</tr>
					</thead>
					<tbody>
						{entries.map((e) => (
							<tr key={e.id} className="border-t border-border/50">
								<td className="px-2 py-1 tabular-nums text-muted-foreground">
									{timeAgoDays(e.createdAt)}
								</td>
								<td className="px-2 py-1">
									<span className={actionColor(e.action)}>{e.action}</span>
								</td>
								<td className="px-2 py-1 font-mono">{e.key}</td>
								<td className="px-2 py-1 font-mono text-muted-foreground">{e.scope}</td>
								<td className="px-2 py-1 font-mono text-muted-foreground">
									{e.oldValuePreview ?? '∅'} → {e.newValuePreview ?? '∅'}
								</td>
								<td className="px-2 py-1 font-mono text-2xs text-muted-foreground">
									{e.actorKind === 'system' ? 'system' : (e.actorIp ?? e.actorUserId ?? '?')}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	)
}

/** name the keys an import skipped because this caller may not set them. */
function deniedNote(keys: string[] | undefined): string {
	return keys?.length
		? `; not imported, an admin sets them from the dashboard: ${keys.join(', ')}`
		: ''
}

function actionColor(a: AuditEntry['action']): string {
	if (a === 'create') return 'text-success'
	if (a === 'delete') return 'text-destructive'
	if (a === 'rollback') return 'text-warning'
	return 'text-muted-foreground'
}
