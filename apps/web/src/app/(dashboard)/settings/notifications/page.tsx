'use client'

// Notification targets: add, send test, delete, over /api/notification-targets.
// Webhook URLs are shown as origin only (stored encrypted). Email targets need
// POWDER_SMTP_URL + POWDER_MAIL_FROM on the powder container.

import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Field, FieldRow, Input, Select } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonList } from '@/components/ui/skeleton'
import { TableFrame } from '@/components/ui/table'
import { useToast } from '@/components/ui/toast'
import { timeAgo } from '@/lib/format'
import { ENV_WEBHOOK_EVENTS, notifyEventLabel } from '@/lib/notify-routing'
import { Bell } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

interface TargetRow {
	id: string
	kind: 'webhook' | 'email'
	destination: string
	events: string[]
	appRepoId: string | null
	enabled: boolean
	createdAt: string
}

interface AppOption {
	id: string
	containerName: string
	serverId: string
	serverName: string | null
}

interface ListResponse {
	smtpConfigured: boolean
	envWebhook: boolean
	events: string[]
	apps: AppOption[]
	targets: TargetRow[]
}

const DEFAULT_EVENTS = ['deploy_failed', 'app_down']

export default function NotificationsPage() {
	const toast = useToast()
	const [data, setData] = useState<ListResponse | null>(null)
	const [kind, setKind] = useState<'webhook' | 'email'>('webhook')
	const [dest, setDest] = useState('')
	const [events, setEvents] = useState<string[]>(DEFAULT_EVENTS)
	const [appRepoId, setAppRepoId] = useState('')
	const [busy, setBusy] = useState(false)
	const [testing, setTesting] = useState<string | null>(null)
	const [confirmRemove, setConfirmRemove] = useState<TargetRow | null>(null)

	const load = useCallback(() => {
		fetch('/api/notification-targets')
			.then((r) => r.json())
			.then((d: ListResponse) => setData(d))
			.catch(() => setData((p) => p))
	}, [])
	useEffect(() => {
		load()
	}, [load])

	const emailBlocked = kind === 'email' && data !== null && !data.smtpConfigured

	async function create(e: React.FormEvent) {
		e.preventDefault()
		if (emailBlocked) return
		setBusy(true)
		try {
			const body = {
				kind,
				...(kind === 'webhook' ? { url: dest.trim() } : { email: dest.trim() }),
				events,
				appRepoId: appRepoId || null,
			}
			const res = await fetch('/api/notification-targets', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			})
			const d = (await res.json().catch(() => ({}))) as { error?: string }
			if (!res.ok) toast.error(d.error ?? `add failed (${res.status})`)
			else {
				setDest('')
				toast.success('target added')
			}
		} finally {
			setBusy(false)
			load()
		}
	}

	async function sendTest(t: TargetRow) {
		setTesting(t.id)
		try {
			const res = await fetch(`/api/notification-targets/test?id=${encodeURIComponent(t.id)}`, {
				method: 'POST',
			})
			const d = (await res.json().catch(() => ({}))) as { error?: string }
			if (res.ok) toast.success('test sent')
			else toast.error(d.error ?? `test failed (${res.status})`)
		} finally {
			setTesting(null)
		}
	}

	async function remove(t: TargetRow) {
		setConfirmRemove(null)
		const res = await fetch(`/api/notification-targets?id=${encodeURIComponent(t.id)}`, {
			method: 'DELETE',
		})
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as { error?: string }
			toast.error(err.error ?? `delete failed (${res.status})`)
		}
		load()
	}

	const toggleEvent = (ev: string, on: boolean) =>
		setEvents((cur) => (on ? [...new Set([...cur, ev])] : cur.filter((x) => x !== ev)))

	const appName = (id: string | null) =>
		id === null ? 'all apps' : (data?.apps.find((a) => a.id === id)?.containerName ?? id)

	return (
		<div className="space-y-6">
			<title>notifications · powder</title>
			<PageHeader
				back={{ href: '/settings', label: 'settings' }}
				title="notifications"
				description="webhooks and email addresses that hear about deploys, downtime, backups and crons."
			/>

			{data?.envWebhook && (
				<Alert tone="info" title="POWDER_NOTIFY_WEBHOOK_URL is set">
					that webhook always gets {ENV_WEBHOOK_EVENTS.map(notifyEventLabel).join(', ')}, on top of
					the targets below.
				</Alert>
			)}

			<form
				onSubmit={create}
				className="space-y-4 rounded-lg border border-border bg-card p-4 shadow-card"
			>
				<FieldRow
					columns="8rem minmax(0, 1fr) minmax(0, 14rem)"
					error={
						emailBlocked
							? 'SMTP not configured. set POWDER_SMTP_URL and POWDER_MAIL_FROM to add email targets.'
							: undefined
					}
				>
					<Field id="target-kind" label="kind">
						<Select
							id="target-kind"
							className="w-full"
							value={kind}
							onChange={(e) => setKind(e.target.value as 'webhook' | 'email')}
						>
							<option value="webhook">webhook</option>
							<option value="email">email</option>
						</Select>
					</Field>
					<Input
						id="target-dest"
						label={kind === 'webhook' ? 'webhook URL' : 'email address'}
						value={dest}
						onChange={(e) => setDest(e.target.value)}
						placeholder={kind === 'webhook' ? 'https://hooks.example.com/…' : 'ops@example.com'}
						disabled={emailBlocked}
						maxLength={2048}
					/>
					<Field id="target-app" label="app" className="min-w-0">
						<Select
							id="target-app"
							value={appRepoId}
							onChange={(e) => setAppRepoId(e.target.value)}
							className="w-full"
						>
							<option value="">all apps</option>
							{data?.apps.map((a) => (
								<option key={a.id} value={a.id}>
									{a.containerName} ({a.serverName ?? a.serverId})
								</option>
							))}
						</Select>
					</Field>
				</FieldRow>
				<fieldset className="flex flex-wrap gap-x-4 gap-y-2">
					<legend className="mb-1 text-xs text-muted-foreground">events</legend>
					{(data?.events ?? []).map((ev) => (
						<label key={ev} className="flex cursor-pointer items-center gap-1.5 text-sm">
							<input
								type="checkbox"
								checked={events.includes(ev)}
								onChange={(e) => toggleEvent(ev, e.target.checked)}
							/>
							{notifyEventLabel(ev)}
						</label>
					))}
				</fieldset>
				<Button
					type="submit"
					loading={busy}
					disabled={emailBlocked || events.length === 0 || !dest.trim()}
				>
					add target
				</Button>
			</form>

			{data === null ? (
				<SkeletonList />
			) : data.targets.length === 0 ? (
				<EmptyState icon={Bell} title="no targets yet" compact>
					add a webhook (Discord, Slack or any JSON receiver) or an email address above.
				</EmptyState>
			) : (
				<TableFrame>
					<table className="w-full text-left text-sm">
						<caption className="sr-only">notification targets</caption>
						<thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
							<tr>
								<th scope="col" className="px-3 py-2 font-medium">
									target
								</th>
								<th scope="col" className="px-3 py-2 font-medium">
									events
								</th>
								<th scope="col" className="px-3 py-2 font-medium">
									app
								</th>
								<th scope="col" className="px-3 py-2 font-medium">
									added
								</th>
								<th scope="col" className="px-3 py-2">
									<span className="sr-only">actions</span>
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border">
							{data.targets.map((t) => (
								<tr key={t.id}>
									<td className="px-3 py-2">
										<div className="text-2xs text-muted-foreground">{t.kind}</div>
										<div className="ph-no-capture break-all font-mono text-xs">{t.destination}</div>
									</td>
									<td className="px-3 py-2 text-xs">{t.events.map(notifyEventLabel).join(', ')}</td>
									<td className="px-3 py-2 text-xs">{appName(t.appRepoId)}</td>
									<td className="px-3 py-2 text-xs text-muted-foreground">
										{timeAgo(t.createdAt)}
									</td>
									<td className="px-3 py-2">
										<div className="flex justify-end gap-2">
											<Button
												size="sm"
												variant="outline"
												loading={testing === t.id}
												onClick={() => sendTest(t)}
											>
												send test
											</Button>
											<Button size="sm" variant="outline" onClick={() => setConfirmRemove(t)}>
												delete
											</Button>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</TableFrame>
			)}
			<ConfirmDialog
				open={confirmRemove !== null}
				title={`Delete this ${confirmRemove?.kind ?? ''} target?`}
				description="It stops getting notifications."
				confirmLabel="delete"
				danger
				onConfirm={() => {
					if (confirmRemove) void remove(confirmRemove)
				}}
				onClose={() => setConfirmRemove(null)}
			/>
		</div>
	)
}
