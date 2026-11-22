'use client'

import { ServerUnreachable } from '@/components/server-unreachable'
// Crons for one app: powder-managed jobs (create / edit / pause / delete / run
// now, recent runs with output tail) plus the host crontab lines that look like
// they belong to this container, read-only, each with an "import" action.

import { useCallback, useEffect, useId, useState } from 'react'
import {
	ChevronDown,
	ChevronRight,
	Clock,
	Pencil,
	Play,
	Plus,
	Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CopyButton } from '@/components/ui/copy-button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FieldRow, Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot as UiStatusDot } from '@/components/ui/status'
import { cronRunLabel, cronRunTone } from '@/lib/cron-status'
import { describeSchedule, maskSecrets } from '@/lib/crons'
import { argvToDisplay, DEFAULT_TIMEOUT_SECONDS, splitArgv } from '@/lib/managed-crons'

interface HostJob {
	schedule: string
	command: string
	comment: string | null
	source: 'host'
	matchedBy: ('port' | 'name-path' | 'docker-exec' | 'subdomain' | 'comment')[]
}

interface Run {
	id: string
	trigger: string
	status: string
	startedAt: string
	finishedAt: string | null
	durationMs: number | null
	httpStatus: number | null
	exitCode: number | null
	error: string | null
	output: string | null
}

interface ManagedJob {
	id: string
	schedule: string
	timezone: string
	kind: 'http' | 'exec'
	httpMethod: 'GET' | 'POST'
	urlPath: string | null
	bearerEnvVar: string | null
	execCommand: string | null
	execArgv: string[] | null
	timeoutSeconds: number
	description: string | null
	importedFrom: string | null
	enabled: boolean
	running: boolean
	nextRunAt: string | null
	lastRunAt: string | null
	lastRunStatus: 'success' | 'failed' | 'timeout' | null
	lastRunError: string | null
	lastRunHttpStatus: number | null
	runs: Run[]
}

// The managed jobs come from the DB and load at once; the host crontab needs SSH
// and loads on its own, so a slow server never hides the managed list.
interface Resp {
	managedJobs: ManagedJob[]
	/** whether the app has a cron token (never the token itself) */
	cronTokenSet?: boolean
	error?: string
}

interface HostResp {
	hostJobs: HostJob[]
	hostError?: string | null
	totalLinesInCrontab: number
}

// What the form edits. `command` is the exec command line, split into argv on save.
interface FormValues {
	schedule: string
	timezone: string
	kind: 'http' | 'exec'
	httpMethod: 'GET' | 'POST'
	urlPath: string
	bearerEnvVar: string
	command: string
	timeoutSeconds: number
	description: string
	enabled: boolean
	importedFrom: string | null
}

const EMPTY_FORM: FormValues = {
	schedule: '0 6 * * *',
	timezone: 'UTC',
	kind: 'http',
	httpMethod: 'POST',
	urlPath: '/api/cron/',
	bearerEnvVar: '',
	command: '',
	timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
	description: '',
	enabled: true,
	importedFrom: null,
}

function jobToForm(j: ManagedJob): FormValues {
	return {
		schedule: j.schedule,
		timezone: j.timezone,
		kind: j.kind,
		httpMethod: j.httpMethod,
		urlPath: j.urlPath ?? '',
		bearerEnvVar: j.bearerEnvVar ?? '',
		// A row with an sh -c string (execCommand): an edit keeps that meaning explicitly.
		command: j.execArgv?.length
			? argvToDisplay(j.execArgv)
			: j.execCommand
				? argvToDisplay(['sh', '-c', j.execCommand])
				: '',
		timeoutSeconds: j.timeoutSeconds,
		description: j.description ?? '',
		enabled: j.enabled,
		importedFrom: j.importedFrom,
	}
}

type FormMode =
	| { kind: 'create'; initial: FormValues; warnings?: string[] }
	| { kind: 'edit'; id: string; initial: FormValues; warnings?: string[] }

// An SSH connection failure, as opposed to a crontab that could not be parsed.
const SSH_FAILED = /ssh|handshake|timed? ?out|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|authentication/i

export function CronsCard({
	serverId,
	containerName,
	serverName,
}: { serverId: string; containerName: string; serverName?: string }) {
	const [data, setData] = useState<Resp | null>(null)
	const [host, setHost] = useState<HostResp | null>(null)
	const [form, setForm] = useState<FormMode | null>(null)
	const [token, setToken] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const base = `/api/servers/${serverId}/containers/${containerName}/crons`

	const load = useCallback(async () => {
		const res = await fetch(`${base}?part=managed`).catch(() => null)
		setData(
			res?.ok ? await res.json() : { managedJobs: [], error: `${res?.status ?? 'network error'}` },
		)
	}, [base])

	// The crontab is read over SSH: give up after 20s and treat that, like a
	// 5xx, as the server not answering.
	const [hostUnreachable, setHostUnreachable] = useState<string | null>(null)
	const loadHost = useCallback(async () => {
		setHost(null)
		setHostUnreachable(null)
		const res = await fetch(`${base}?part=host`, { signal: AbortSignal.timeout(20_000) }).catch(
			(e: unknown) => (e instanceof DOMException && e.name === 'TimeoutError' ? 'timeout' : null),
		)
		if (res === 'timeout' || (res && res.status >= 500)) {
			const body =
				res === 'timeout'
					? null
					: ((await res.json().catch(() => null)) as { error?: string } | null)
			setHostUnreachable(
				body?.error ?? (res === 'timeout' ? 'no answer over SSH in 20s' : null) ?? '',
			)
			setHost({ hostJobs: [], totalLinesInCrontab: 0 })
			return
		}
		if (res?.ok) {
			const body = (await res.json()) as typeof host & { hostError?: string | null }
			// The route answers 200 with hostError when SSH itself failed.
			if (body?.hostError && SSH_FAILED.test(body.hostError)) {
				setHostUnreachable(body.hostError)
				setHost({ hostJobs: [], totalLinesInCrontab: 0 })
				return
			}
			setHost(body)
			return
		}
		setHost(
			res
				? {
						hostJobs: [],
						totalLinesInCrontab: 0,
						hostError: `request failed (${res.status})`,
					}
				: { hostJobs: [], totalLinesInCrontab: 0, hostError: 'network error' },
		)
	}, [base])

	useEffect(() => {
		load()
		loadHost()
	}, [load, loadHost])

	const [pendingRemove, setPendingRemove] = useState<string | null>(null)
	const [removing, setRemoving] = useState(false)
	const [rotateOpen, setRotateOpen] = useState(false)
	const [rotating, setRotating] = useState(false)

	// a new cron token, shown once (admin browser session only).
	async function rotateToken() {
		setRotating(true)
		setNotice(null)
		try {
			const res = await fetch(`${base}/token/rotate`, { method: 'POST' })
			const body = (await res.json().catch(() => ({}))) as { cronToken?: string; error?: string }
			if (!res.ok || !body.cronToken) {
				setNotice(body.error ?? `rotate failed (${res.status})`)
				return
			}
			setToken(body.cronToken)
			await load()
		} finally {
			setRotating(false)
			setRotateOpen(false)
		}
	}

	async function remove(cronId: string) {
		setRemoving(true)
		try {
			await fetch(`${base}/${cronId}`, { method: 'DELETE' })
			await load()
		} finally {
			setRemoving(false)
			setPendingRemove(null)
		}
	}

	async function toggle(cronId: string, enabled: boolean) {
		await fetch(`${base}/${cronId}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ enabled }),
		})
		await load()
	}

	async function runNow(cronId: string) {
		setNotice(null)
		const res = await fetch(`${base}/${cronId}/run`, { method: 'POST' })
		if (!res.ok) {
			const body = await res.json().catch(() => ({}))
			setNotice(body.error ?? `run failed to start (${res.status})`)
			return
		}
		// The run happens after the response; poll briefly for its result.
		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, i < 5 ? 1000 : 3000))
			const r = await fetch(`${base}?part=managed`)
			if (!r.ok) break
			const next = (await r.json()) as Resp
			setData(next)
			const job = next.managedJobs.find((j) => j.id === cronId)
			if (
				job &&
				!job.running &&
				job.runs[0]?.trigger === 'manual' &&
				job.runs[0].status !== 'running'
			) {
				break
			}
		}
	}

	// the server imports the RAW crontab line (this list only has the
	// masked text) and stores it paused; then the form opens on the new job.
	async function startImport(h: HostJob, index: number) {
		setNotice(null)
		const res = await fetch(`${base}/import`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ index, command: h.command }),
		})
		const body = (await res.json().catch(() => ({}))) as {
			id?: string
			cronToken?: string | null
			warnings?: string[]
			error?: string
		}
		if (!res.ok || !body.id) {
			setNotice(body.error ?? `import failed (${res.status})`)
			return
		}
		if (body.cronToken) setToken(body.cronToken)
		const r = await fetch(`${base}?part=managed`)
		const next = r.ok ? ((await r.json()) as Resp) : null
		if (next) setData(next)
		setNotice(
			'imported as a paused job. use "run now" to verify it, then remove the line from the host crontab yourself (powder does not edit it), then enable the job.',
		)
		const job = next?.managedJobs.find((j) => j.id === body.id)
		if (job) setForm({ kind: 'edit', id: job.id, initial: jobToForm(job), warnings: body.warnings })
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-3">
					<CardTitle>scheduled jobs</CardTitle>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setForm(form ? null : { kind: 'create', initial: EMPTY_FORM })}
					>
						<Plus className="h-3 w-3" />
						schedule a job
					</Button>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				{form && (
					<JobForm
						key={form.kind === 'edit' ? form.id : (form.initial.importedFrom ?? 'new')}
						mode={form}
						base={base}
						onCancel={() => setForm(null)}
						onSaved={async (newToken) => {
							const wasImport = form.kind === 'create' && form.initial.importedFrom
							setForm(null)
							if (newToken) setToken(newToken)
							if (wasImport) {
								setNotice(
									'imported as a paused job. use "run now" to verify it, then remove the line from the host crontab yourself (powder does not edit it), then enable the job.',
								)
							}
							await load()
						}}
					/>
				)}

				{token && <CronTokenBanner token={token} onDismiss={() => setToken(null)} />}
				{!token && data?.cronTokenSet && (
					<div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs">
						<span>
							<span className="font-mono">POWDER_CRON_TOKEN</span> is set. it is shown only once;
							rotate it to get a new one.
						</span>
						<Button variant="outline" size="sm" onClick={() => setRotateOpen(true)}>
							rotate token
						</Button>
					</div>
				)}
				{notice && (
					<div className="flex items-start justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
						<span>{notice}</span>
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground"
							onClick={() => setNotice(null)}
						>
							dismiss
						</button>
					</div>
				)}

				<ManagedSection
					jobs={data?.managedJobs ?? []}
					loading={!data}
					onToggle={toggle}
					onRemove={(id) => setPendingRemove(id)}
					onEdit={(j) => setForm({ kind: 'edit', id: j.id, initial: jobToForm(j) })}
					onRunNow={runNow}
				/>

				{hostUnreachable !== null ? (
					<div>
						<SectionTitle>host crontab</SectionTitle>
						<ServerUnreachable
							className="mt-2"
							serverId={serverId}
							serverName={serverName ?? 'the server'}
							error={hostUnreachable || null}
							what="its crontab"
							onRetry={loadHost}
						/>
					</div>
				) : (
					<HostSection
						jobs={host?.hostJobs ?? []}
						total={host?.totalLinesInCrontab ?? 0}
						error={host?.hostError ?? null}
						loading={!host}
						onImport={startImport}
					/>
				)}
			</CardContent>
			<ConfirmDialog
				open={pendingRemove !== null}
				title="delete this scheduled job?"
				description="it stops firing immediately and its run history is deleted. this can't be undone."
				confirmLabel="delete"
				danger
				loading={removing}
				onConfirm={() => {
					if (pendingRemove) remove(pendingRemove)
				}}
				onClose={() => !removing && setPendingRemove(null)}
			/>
			<ConfirmDialog
				open={rotateOpen}
				title="rotate the cron token?"
				description="powder makes a new POWDER_CRON_TOKEN and shows it once. http crons send the new token from now on, so your app rejects them until you put the new value in its env and redeploy."
				confirmLabel="rotate"
				danger
				loading={rotating}
				onConfirm={rotateToken}
				onClose={() => !rotating && setRotateOpen(false)}
			/>
		</Card>
	)
}

function ManagedSection({
	jobs,
	loading,
	onToggle,
	onRemove,
	onEdit,
	onRunNow,
}: {
	jobs: ManagedJob[]
	loading: boolean
	onToggle: (id: string, enabled: boolean) => void
	onRemove: (id: string) => void
	onEdit: (job: ManagedJob) => void
	onRunNow: (id: string) => Promise<void>
}) {
	if (loading) {
		return (
			<div>
				<SectionTitle>managed by powder</SectionTitle>
				<div className="mt-2 space-y-2" aria-busy="true">
					<Skeleton className="h-12 w-full" />
					<Skeleton className="h-12 w-full" />
					<span className="sr-only">loading scheduled jobs</span>
				</div>
			</div>
		)
	}
	if (jobs.length === 0) {
		return (
			<div>
				<SectionTitle>managed by powder</SectionTitle>
				<p className="mt-1 text-xs text-muted-foreground">
					none yet. use <span className="font-medium text-foreground">schedule a job</span>, or
					import a host cron below.
				</p>
			</div>
		)
	}
	return (
		<div>
			<SectionTitle>managed by powder</SectionTitle>
			<div className="mt-2 divide-y divide-border rounded-md border border-border">
				{jobs.map((j) => (
					<ManagedRow
						key={j.id}
						job={j}
						onToggle={onToggle}
						onRemove={onRemove}
						onEdit={onEdit}
						onRunNow={onRunNow}
					/>
				))}
			</div>
		</div>
	)
}

function jobTarget(job: ManagedJob): string {
	if (job.kind === 'http') return `${job.httpMethod} ${job.urlPath ?? ''}`
	if (job.execArgv?.length) return maskSecrets(argvToDisplay(job.execArgv))
	return maskSecrets(`sh -c ${job.execCommand ?? ''}`)
}

function ManagedRow({
	job,
	onToggle,
	onRemove,
	onEdit,
	onRunNow,
}: {
	job: ManagedJob
	onToggle: (id: string, enabled: boolean) => void
	onRemove: (id: string) => void
	onEdit: (job: ManagedJob) => void
	onRunNow: (id: string) => Promise<void>
}) {
	const [open, setOpen] = useState(false)
	const [starting, setStarting] = useState(false)
	return (
		<div className="text-xs">
			<div className="grid grid-cols-1 gap-2 px-3 py-2.5 sm:grid-cols-12 sm:gap-3">
				<div className="sm:col-span-3">
					<div className="flex items-center gap-1.5 font-mono">
						<button
							type="button"
							onClick={() => setOpen((v) => !v)}
							aria-expanded={open}
							aria-label={open ? 'hide runs' : 'show runs'}
							className="-m-3 inline-flex h-10 w-10 shrink-0 items-center justify-center text-muted-foreground/60 hover:text-foreground sm:m-0 sm:h-auto sm:w-auto"
						>
							{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
						</button>
						<UiStatusDot
							tone={job.running ? 'warning' : cronRunTone(job.enabled, job.lastRunStatus)}
							pulse={job.running}
						/>
						<span className="sr-only">{cronRunLabel(job.enabled, job.lastRunStatus)}</span>
						{job.schedule}
					</div>
					<div className="mt-0.5 text-2xs text-muted-foreground">
						{scheduleHint(job.schedule, job.timezone)}
					</div>
				</div>
				<div className="min-w-0 sm:col-span-6">
					<div className="truncate font-mono" title={jobTarget(job)}>
						<span className="mr-1 text-muted-foreground">{job.kind}</span>
						{jobTarget(job)}
					</div>
					{job.description && (
						<div className="mt-0.5 truncate text-2xs text-muted-foreground">{job.description}</div>
					)}
					<div className="mt-1 text-2xs text-muted-foreground">
						{job.running ? (
							<span>running now</span>
						) : job.lastRunAt ? (
							<>
								last: <StatusDot status={job.lastRunStatus} />
								{job.lastRunStatus}
								{job.lastRunHttpStatus &&
								!(job.lastRunError ?? '').includes(String(job.lastRunHttpStatus))
									? ` (${job.lastRunHttpStatus})`
									: ''}
								{' · '}
								{relTime(job.lastRunAt)}
								{job.lastRunError && (
									<span className="ph-no-capture ml-1 text-destructive">· {job.lastRunError}</span>
								)}
							</>
						) : (
							'not run yet'
						)}
						{job.enabled && job.nextRunAt && (
							<span className="ml-2">· next {relTime(job.nextRunAt)}</span>
						)}
						{!job.enabled && <span className="ml-2">· paused</span>}
					</div>
				</div>
				<div className="flex items-center gap-2 sm:col-span-3 sm:justify-end">
					<label className="flex items-center gap-1 text-2xs text-muted-foreground">
						<input
							type="checkbox"
							checked={job.enabled}
							onChange={(e) => onToggle(job.id, e.target.checked)}
						/>
						enabled
					</label>
					<button
						type="button"
						disabled={starting || job.running}
						onClick={async () => {
							setStarting(true)
							setOpen(true)
							try {
								await onRunNow(job.id)
							} finally {
								setStarting(false)
							}
						}}
						className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
						title="run now"
						aria-label="run now"
					>
						<Play className="h-3 w-3" />
					</button>
					<button
						type="button"
						onClick={() => onEdit(job)}
						className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
						title="edit"
						aria-label="edit scheduled job"
					>
						<Pencil className="h-3 w-3" />
					</button>
					<button
						type="button"
						onClick={() => onRemove(job.id)}
						className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
						title="delete"
						aria-label="delete scheduled job"
					>
						<Trash2 className="h-3 w-3" />
					</button>
				</div>
			</div>
			{open && <RunsList runs={job.runs} />}
		</div>
	)
}

function RunsList({ runs }: { runs: Run[] }) {
	const [expanded, setExpanded] = useState<string | null>(null)
	if (runs.length === 0) {
		return (
			<div className="border-t border-border px-3 py-2 text-2xs text-muted-foreground">
				no runs yet.
			</div>
		)
	}
	return (
		<div className="border-t border-border bg-muted/10 px-3 py-2">
			<div className="mb-1 text-2xs font-medium text-muted-foreground">recent runs</div>
			<div className="space-y-1">
				{runs.map((r) => (
					<div key={r.id}>
						<button
							type="button"
							onClick={() => setExpanded(expanded === r.id ? null : r.id)}
							className="grid w-full grid-cols-12 gap-2 text-left text-2xs hover:text-foreground"
						>
							<span className="col-span-3 flex items-center">
								<StatusDot status={r.status} />
								{r.status}
								{r.httpStatus != null &&
									!(r.error ?? '').includes(String(r.httpStatus)) &&
									` (${r.httpStatus})`}
								{r.exitCode != null && r.exitCode !== 0 && ` (exit ${r.exitCode})`}
							</span>
							<span className="col-span-3 text-muted-foreground">{relTime(r.startedAt)}</span>
							<span className="col-span-2 text-muted-foreground">
								{formatDuration(r.durationMs)}
							</span>
							<span className="col-span-1 text-muted-foreground">
								{r.trigger === 'manual' ? 'manual' : ''}
							</span>
							<span className="col-span-3 truncate text-destructive" title={r.error ?? undefined}>
								{r.error}
							</span>
						</button>
						{expanded === r.id && (
							<div className="relative mt-1">
								<pre
									id={`cron-run-${r.id}`}
									className="ph-no-capture max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background/60 p-2 pr-10 font-mono text-2xs"
								>
									{r.output ? tail(r.output) : '(no output)'}
								</pre>
								{(r.error || r.output) && (
									<CopyButton
										value={() => [r.error, r.output ? tail(r.output) : null].filter(Boolean).join('\n\n')}
										label={r.error ? 'copy the error and output' : 'copy the output'}
										targetId={`cron-run-${r.id}`}
										className="absolute right-1 top-1"
									/>
								)}
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	)
}

function HostSection({
	jobs,
	total,
	error,
	loading,
	onImport,
}: {
	jobs: HostJob[]
	total: number
	error: string | null
	loading: boolean
	onImport: (job: HostJob, index: number) => void
}) {
	return (
		<div>
			<SectionTitle>host crontab</SectionTitle>
			<p className="mt-1 text-2xs text-muted-foreground">
				lines from the server's root crontab that reference this app. read-only: import one to let
				powder run, log and alert on it, then remove the line from the crontab yourself.
			</p>
			{loading ? (
				<p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
					<Spinner className="h-3 w-3" />
					reading the server's crontab over SSH…
				</p>
			) : error ? (
				<div className="mt-1 flex items-start gap-1">
					<p className="ph-no-capture min-w-0 text-xs text-destructive [overflow-wrap:anywhere]">
						couldn't read the crontab: {error}
					</p>
					<CopyButton value={error} label="copy the error" className="-mt-0.5" />
				</div>
			) : jobs.length === 0 ? (
				<p className="mt-1 text-xs text-muted-foreground">
					no host crons match this container.
					{total > 0 && <> ({total} other lines exist; none reference this container.)</>}
				</p>
			) : (
				<div className="mt-2 divide-y divide-border rounded-md border border-border">
					{jobs.map((j, i) => (
						<HostRow key={`${j.schedule} ${j.command}`} job={j} onImport={() => onImport(j, i)} />
					))}
				</div>
			)}
		</div>
	)
}

function HostRow({ job, onImport }: { job: HostJob; onImport: () => void }) {
	return (
		<div className="grid grid-cols-1 gap-2 px-3 py-2.5 sm:grid-cols-12 sm:gap-3">
			<div className="min-w-0 sm:col-span-3">
				<div className="flex items-center gap-1.5 font-mono text-xs">
					<Clock className="h-3 w-3 text-muted-foreground" />
					{job.schedule}
				</div>
				<div className="mt-0.5 truncate text-2xs text-muted-foreground">
					{describeSchedule(job.schedule)} (host timezone)
				</div>
			</div>
			<div className="min-w-0 sm:col-span-7">
				<div className="break-all font-mono text-2xs">{maskSecrets(job.command)}</div>
				{job.comment && <div className="mt-0.5 text-2xs text-muted-foreground">{job.comment}</div>}
				<div className="mt-1 flex flex-wrap gap-1">
					{job.matchedBy.map((m) => (
						<span
							key={m}
							className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground"
						>
							{m}
						</span>
					))}
				</div>
			</div>
			<div className="flex items-start sm:col-span-2 sm:justify-end">
				<Button variant="outline" size="sm" onClick={onImport}>
					import
				</Button>
			</div>
		</div>
	)
}

function JobForm({
	mode,
	base,
	onCancel,
	onSaved,
}: {
	mode: FormMode
	base: string
	onCancel: () => void
	onSaved: (newToken: string | null) => void
}) {
	const [v, setV] = useState<FormValues>(mode.initial)
	const fid = useId()
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const set = <K extends keyof FormValues>(k: K, val: FormValues[K]) =>
		setV((p) => ({ ...p, [k]: val }))

	async function submit() {
		setError(null)
		let execArgv: string[] | null = null
		if (v.kind === 'exec') {
			const split = splitArgv(v.command.trim())
			if (!split.ok) {
				setError(split.error)
				return
			}
			if (split.shellSyntax) {
				setError(
					"the command uses shell syntax (| & ; < > $ `). powder does not run a shell: write it as sh -c '...' if the container has one.",
				)
				return
			}
			execArgv = split.argv
		}
		setSubmitting(true)
		try {
			const payload = {
				schedule: v.schedule.trim(),
				timezone: v.timezone.trim() || 'UTC',
				kind: v.kind,
				httpMethod: v.httpMethod,
				urlPath: v.kind === 'http' ? v.urlPath.trim() : null,
				bearerEnvVar: v.kind === 'http' ? v.bearerEnvVar.trim() || null : null,
				execArgv,
				timeoutSeconds: Number(v.timeoutSeconds),
				description: v.description.trim() || null,
				enabled: v.enabled,
				importedFrom: v.importedFrom,
			}
			const res = await fetch(mode.kind === 'edit' ? `${base}/${mode.id}` : base, {
				method: mode.kind === 'edit' ? 'PATCH' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			})
			if (!res.ok) {
				const data = await res.json().catch(() => ({}))
				setError(data.error ?? `failed (${res.status})`)
				return
			}
			const data = await res.json().catch(() => ({}))
			onSaved(data.cronToken ?? null)
		} catch {
			setError('failed: network error')
		} finally {
			setSubmitting(false)
		}
	}

	const warnings = mode.warnings ?? []

	return (
		<div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
			{mode.initial.importedFrom && (
				<div className="text-2xs text-muted-foreground">
					importing <span className="font-mono">{maskSecrets(mode.initial.importedFrom)}</span>. the
					job is created paused; the host line keeps running until you remove it.
				</div>
			)}
			{warnings.length > 0 && (
				<ul className="list-disc space-y-0.5 pl-4 text-2xs text-warning">
					{warnings.map((w) => (
						<li key={w}>{w}</li>
					))}
				</ul>
			)}
			<FieldRow columns="minmax(0, 3fr) minmax(0, 3fr) minmax(0, 2fr) minmax(0, 2fr) minmax(0, 2fr)">
				<Input
					id={`${fid}-schedule`}
					label="schedule"
					value={v.schedule}
					onChange={(e) => set('schedule', e.target.value)}
					className="font-mono"
					placeholder="0 6 * * *"
				/>
				<Input
					id={`${fid}-tz`}
					label="timezone"
					value={v.timezone}
					onChange={(e) => set('timezone', e.target.value)}
					className="font-mono"
					placeholder="Europe/Berlin"
				/>
				<Field id={`${fid}-kind`} label="kind">
					<Select
						id={`${fid}-kind`}
						value={v.kind}
						onChange={(e) => set('kind', e.target.value === 'exec' ? 'exec' : 'http')}
						className="w-full"
					>
						<option value="http">http</option>
						<option value="exec">exec</option>
					</Select>
				</Field>
				<Input
					id={`${fid}-timeout`}
					label="timeout (seconds)"
					type="number"
					min={1}
					max={3600}
					value={v.timeoutSeconds}
					onChange={(e) => set('timeoutSeconds', Number(e.target.value))}
				/>
				<Field id={`${fid}-enabled`} label="enabled">
					<label className="flex h-10 items-center gap-1.5 text-xs sm:h-9">
						<input
							id={`${fid}-enabled`}
							type="checkbox"
							checked={v.enabled}
							onChange={(e) => set('enabled', e.target.checked)}
						/>
						{v.enabled ? 'on' : 'paused'}
					</label>
				</Field>
			</FieldRow>
			{v.kind === 'http' ? (
				<FieldRow columns="minmax(0, 2fr) minmax(0, 6fr) minmax(0, 4fr)">
					<Field id={`${fid}-method`} label="method">
						<Select
							id={`${fid}-method`}
							value={v.httpMethod}
							onChange={(e) => set('httpMethod', e.target.value === 'GET' ? 'GET' : 'POST')}
							className="w-full"
						>
							<option value="POST">POST</option>
							<option value="GET">GET</option>
						</Select>
					</Field>
					<Input
						id={`${fid}-path`}
						label="path on your app"
						value={v.urlPath}
						onChange={(e) => set('urlPath', e.target.value)}
						className="font-mono"
						placeholder="/api/cron/digest"
					/>
					<Input
						id={`${fid}-bearer`}
						label="bearer from env var (optional)"
						value={v.bearerEnvVar}
						onChange={(e) => set('bearerEnvVar', e.target.value)}
						className="font-mono"
						placeholder="POWDER_CRON_TOKEN"
					/>
				</FieldRow>
			) : (
				<Input
					id={`${fid}-command`}
					label="command (run with docker exec in this app's container, no shell)"
					value={v.command}
					onChange={(e) => set('command', e.target.value)}
					className="font-mono"
					placeholder="node scripts/digest.js --send"
				/>
			)}
			<Input
				id={`${fid}-description`}
				label="description (optional)"
				value={v.description}
				onChange={(e) => set('description', e.target.value)}
				placeholder="daily digest"
			/>
			{error && <p className="text-xs text-destructive">{error}</p>}
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-2xs text-muted-foreground">
				<span>
					{v.kind === 'http' ? (
						<>
							powder calls the app's live custom domain (else its default host) with{' '}
							<span className="font-mono">
								Authorization: Bearer ${v.bearerEnvVar.trim() || 'POWDER_CRON_TOKEN'}
							</span>
						</>
					) : (
						<>each word is passed to the program as-is; nothing is expanded.</>
					)}
				</span>
				<div className="ml-auto flex gap-2">
					<Button variant="ghost" size="sm" onClick={onCancel}>
						cancel
					</Button>
					<Button size="sm" onClick={submit} disabled={submitting}>
						{submitting ? 'saving…' : mode.kind === 'edit' ? 'save' : 'add'}
					</Button>
				</div>
			</div>
		</div>
	)
}

function CronTokenBanner({ token, onDismiss }: { token: string; onDismiss: () => void }) {
	return (
		<div className="space-y-2 rounded-md border border-powder/40 bg-powder/5 p-3 text-xs">
			<div className="font-medium">your app needs this token to verify powder's cron pings:</div>
			<div className="flex items-center gap-2">
				<pre
					id="cron-token"
					className="ph-no-capture flex-1 overflow-auto rounded-md bg-background px-2 py-1.5 font-mono text-2xs"
				>
					POWDER_CRON_TOKEN={token}
				</pre>
				<CopyButton value={token} label="copy the token" targetId="cron-token" size="sm" />
			</div>
			<div className="text-2xs text-muted-foreground">
				paste into your app's env vars, then redeploy. your endpoint should reject requests whose{' '}
				<span className="font-mono">Authorization</span> header doesn't match.
			</div>
			<Button variant="ghost" size="sm" onClick={onDismiss}>
				got it
			</Button>
		</div>
	)
}

function SectionTitle({ children }: { children: React.ReactNode }) {
	return <div className="text-xs font-medium text-muted-foreground">{children}</div>
}

function StatusDot({ status }: { status: string | null }) {
	if (status === 'success')
		return <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-success" />
	if (status === 'failed' || status === 'timeout')
		return <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-destructive" />
	return <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground" />
}

function scheduleHint(expr: string, tz: string): string {
	const d = describeSchedule(expr)
	return d === expr ? tz : `${d} ${tz}`
}

function formatDuration(ms: number | null): string {
	if (ms == null) return '-'
	if (ms < 1000) return `${ms}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	return `${Math.round(ms / 60_000)}m`
}

// Show the end of the output: that is where the error usually is.
function tail(s: string, max = 4000): string {
	return s.length > max ? `…${s.slice(-max)}` : s
}

function relTime(iso: string): string {
	const t = new Date(iso).getTime()
	const diff = t - Date.now()
	const abs = Math.abs(diff)
	const min = 60_000
	const hr = 60 * min
	const day = 24 * hr
	const fmt = (n: number, unit: string) => `${Math.round(n)}${unit}`
	const text =
		abs < min
			? '<1m'
			: abs < hr
				? fmt(abs / min, 'm')
				: abs < day
					? fmt(abs / hr, 'h')
					: fmt(abs / day, 'd')
	return diff < 0 ? `${text} ago` : `in ${text}`
}
