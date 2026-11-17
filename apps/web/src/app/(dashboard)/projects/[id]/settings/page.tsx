'use client'

// Settings tab: webhook URL, DEPLOYMENT.md sync, health URL and uptime, preview
// deploys, automatic rollback, the settle window for push deploys, runtime (stop / start) and the danger zone (delete). Reads the same project response the layout loaded.

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FieldRow, Input } from '@/components/ui/input'
import { DEPLOY_SETTLE_MAX_SECONDS } from '@/lib/deploy-settle'
import { PORT_COPY, SETTLE_COPY, uiErrorCopy } from '@/lib/ui-error-copy'
import { Check, Copy } from 'lucide-react'
import { type ProjectMeta, useProject } from '../_lib/project-context'
import { AppControls } from './danger-zone'

type SettingsPatch = Partial<
	Pick<
		ProjectMeta,
		| 'syncDeploymentMd'
		| 'uptimeEnabled'
		| 'healthUrl'
		| 'previewsEnabled'
		| 'dockerfilePath'
		| 'containerPort'
		| 'autoRollback'
		| 'deploySettleSeconds'
	>
>

// Empty port: the compose file decides, so the row says so.
const PORT_ROW_COPY = `${PORT_COPY}, or leave it empty`
const portRow = (m: string) => (m === PORT_COPY ? PORT_ROW_COPY : m)

export default function SettingsPage() {
	const { id, project, meta: loaded, reload } = useProject()
	const [overrides, setOverrides] = useState<SettingsPatch>({})
	const [copied, setCopied] = useState<string | null>(null)
	const [saving, setSaving] = useState<string | null>(null)
	const [errors, setErrors] = useState<Record<string, string>>({})
	const [healthDraft, setHealthDraft] = useState<string | null>(null)
	const [dockerfileDraft, setDockerfileDraft] = useState<string | null>(null)
	const [portDraft, setPortDraft] = useState<string | null>(null)
	const [settleDraft, setSettleDraft] = useState<string | null>(null)
	const meta = loaded ? { ...loaded, ...overrides } : null
	// The preview-build row has two fields and one message: a message about the port
	// marks the port field invalid, anything else the Dockerfile field.
	const previewBuildError = errors.previewBuild || ''
	const previewBuildPortError = /\bport\b/i.test(previewBuildError)

	if (!project) return null

	const copy = async (text: string, label: string) => {
		try {
			await navigator.clipboard.writeText(text)
			setCopied(label)
			setTimeout(() => setCopied(null), 1500)
		} catch {
			// no-op
		}
	}

	// One PATCH per control; `key` names the control for its saving state and error.
	const save = async (key: string, patch: SettingsPatch): Promise<boolean> => {
		setSaving(key)
		setErrors((e) => ({ ...e, [key]: '' }))
		try {
			const res = await fetch(`/api/projects/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch),
			})
			const d = (await res.json().catch(() => ({}))) as SettingsPatch & { error?: string }
			if (!res.ok) {
				setErrors((e) => ({
					...e,
					[key]: d.error ? portRow(uiErrorCopy(d.error)) : `save failed (${res.status})`,
				}))
				return false
			}
			setOverrides((o) => ({
				...o,
				syncDeploymentMd: d.syncDeploymentMd === true,
				uptimeEnabled: d.uptimeEnabled === true,
				healthUrl: d.healthUrl ?? null,
				previewsEnabled: d.previewsEnabled === true,
				dockerfilePath: d.dockerfilePath || './Dockerfile',
				containerPort: typeof d.containerPort === 'number' ? d.containerPort : null,
				autoRollback: d.autoRollback !== false,
				deploySettleSeconds:
					typeof d.deploySettleSeconds === 'number' ? d.deploySettleSeconds : null,
			}))
			return true
		} catch {
			setErrors((e) => ({ ...e, [key]: 'save failed' }))
			return false
		} finally {
			setSaving(null)
		}
	}

	const healthValue = healthDraft ?? meta?.healthUrl ?? ''
	const healthDirty = healthDraft !== null && healthDraft.trim() !== (meta?.healthUrl ?? '')
	const dockerfileValue = dockerfileDraft ?? meta?.dockerfilePath ?? './Dockerfile'
	const portValue = portDraft ?? (meta?.containerPort != null ? String(meta.containerPort) : '')
	const previewBuildDirty =
		(dockerfileDraft !== null &&
			dockerfileDraft.trim() !== (meta?.dockerfilePath ?? './Dockerfile')) ||
		(portDraft !== null &&
			portDraft.trim() !== (meta?.containerPort != null ? String(meta.containerPort) : ''))

	const settleSaved = meta?.deploySettleSeconds != null ? String(meta.deploySettleSeconds) : ''
	const settleValue = settleDraft ?? settleSaved
	const settleDirty = settleDraft !== null && settleDraft.trim() !== settleSaved

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle>webhook</CardTitle>
					<CardDescription className="mt-0.5">
						GitHub calls this URL on every push to{' '}
						<code className="font-mono text-foreground">{project.branch}</code>. powder added it to
						the repo when you created the app.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex gap-2">
						<Input
							readOnly
							aria-label="webhook URL"
							value={meta?.webhookUrl ?? ''}
							placeholder="not available"
							onFocus={(e) => e.currentTarget.select()}
							className="min-w-0 flex-1 bg-muted/40 font-mono"
						/>
						{meta?.webhookUrl && (
							<Button
								variant="outline"
								onClick={() => copy(meta.webhookUrl as string, 'webhook')}
								aria-label="copy webhook URL"
							>
								{copied === 'webhook' ? (
									<Check className="h-3.5 w-3.5 text-success" />
								) : (
									<Copy className="h-3.5 w-3.5" />
								)}
								<span className="hidden sm:inline">{copied === 'webhook' ? 'copied' : 'copy'}</span>
							</Button>
						)}
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>DEPLOYMENT.md</CardTitle>
				</CardHeader>
				<CardContent>
					<label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-3 hover:bg-accent/30">
						<input
							type="checkbox"
							checked={meta?.syncDeploymentMd ?? false}
							disabled={!meta || saving !== null}
							onChange={(e) => save('sync', { syncDeploymentMd: e.target.checked })}
							className="mt-0.5"
						/>
						<div className="flex-1">
							<div className="text-sm font-medium">sync DEPLOYMENT.md to the repo</div>
							<div className="text-2xs text-muted-foreground">
								after each successful deploy powder commits a DEPLOYMENT.md (server, hostnames, how
								to deploy) to <code className="font-mono">{project.branch}</code> of this app's
								GitHub repo.
							</div>
						</div>
					</label>
					{errors.sync && <p className="mt-2 text-xs text-destructive">{errors.sync}</p>}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>health and uptime</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<form
						onSubmit={async (e) => {
							e.preventDefault()
							if (await save('health', { healthUrl: healthValue.trim() || null }))
								setHealthDraft(null)
						}}
					>
						<FieldRow
							error={errors.health}
							hint="a path or an http(s) URL. the deploy health gate, uptime checks and the Traefik health check probe it; the Traefik health check picks up a change on the next deploy. empty: no health check path."
							action={
								<Button type="submit" variant="outline" disabled={!healthDirty || saving !== null}>
									{saving === 'health' ? 'saving…' : 'save'}
								</Button>
							}
						>
							<Input
								label="health URL"
								placeholder="/api/health"
								value={healthValue}
								disabled={!meta}
								onChange={(e) => setHealthDraft(e.target.value)}
								className="font-mono"
							/>
						</FieldRow>
					</form>
					<label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-3 hover:bg-accent/30">
						<input
							type="checkbox"
							checked={meta?.uptimeEnabled ?? false}
							disabled={!meta || saving !== null}
							onChange={(e) => save('uptime', { uptimeEnabled: e.target.checked })}
							className="mt-0.5"
						/>
						<div className="flex-1">
							<div className="text-sm font-medium">uptime checks</div>
							<div className="text-2xs text-muted-foreground">
								every 5 minutes powder probes the health URL (else the app's live domain or default
								host) and notifies when the app goes down and comes back.
							</div>
						</div>
					</label>
					{errors.uptime && <p className="text-xs text-destructive">{errors.uptime}</p>}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>preview deploys</CardTitle>
				</CardHeader>
				<CardContent>
					<label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-3 hover:bg-accent/30">
						<input
							type="checkbox"
							checked={meta?.previewsEnabled ?? false}
							disabled={!meta || saving !== null}
							onChange={(e) => save('previews', { previewsEnabled: e.target.checked })}
							className="mt-0.5"
						/>
						<div className="flex-1">
							<div className="text-sm font-medium">deploy previews of other branches</div>
							<div className="text-2xs text-muted-foreground">
								a push to another branch gets its own container and hostname. needs a Traefik server
								with a base domain. previews get only the preview env vars; they don't reach this
								app's database unless you point one at it.
							</div>
						</div>
					</label>
					{errors.previews && <p className="mt-2 text-xs text-destructive">{errors.previews}</p>}
					<form
						className="mt-4"
						onSubmit={async (e) => {
							e.preventDefault()
							const port = portValue.trim()
							if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
								setErrors((er) => ({ ...er, previewBuild: PORT_ROW_COPY }))
								return
							}
							const ok = await save('previewBuild', {
								dockerfilePath: dockerfileValue.trim() || './Dockerfile',
								containerPort: port ? Number(port) : null,
							})
							if (ok) {
								setDockerfileDraft(null)
								setPortDraft(null)
							}
						}}
					>
						<FieldRow
							error={previewBuildError}
							hint="previews build this Dockerfile and route to this port. empty port: read from the app's compose file, else 3000."
							action={
								<Button
									type="submit"
									variant="outline"
									disabled={!previewBuildDirty || saving !== null}
								>
									{saving === 'previewBuild' ? 'saving…' : 'save'}
								</Button>
							}
						>
							<Input
								label="Dockerfile"
								placeholder="./Dockerfile"
								value={dockerfileValue}
								disabled={!meta}
								onChange={(e) => setDockerfileDraft(e.target.value)}
								className="font-mono"
								aria-invalid={previewBuildError && !previewBuildPortError ? true : undefined}
							/>
							<Input
								label="container port"
								placeholder="from the compose file"
								inputMode="numeric"
								value={portValue}
								disabled={!meta}
								onChange={(e) => setPortDraft(e.target.value)}
								className="font-mono"
								aria-invalid={previewBuildPortError ? true : undefined}
							/>
						</FieldRow>
					</form>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>automatic rollback</CardTitle>
				</CardHeader>
				<CardContent>
					<label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-3 hover:bg-accent/30">
						<input
							type="checkbox"
							checked={meta?.autoRollback ?? true}
							disabled={!meta || saving !== null}
							onChange={(e) => save('autoRollback', { autoRollback: e.target.checked })}
							className="mt-0.5"
						/>
						<div className="flex-1">
							<div className="text-sm font-medium">allow automatic rollback</div>
							<div className="text-2xs text-muted-foreground">
								a monitor that calls powder's rollback preflight may roll this app back to its
								previous image within 25 minutes of a deploy. off: the preflight always says no; the
								Roll back button still works.
							</div>
						</div>
					</label>
					{errors.autoRollback && (
						<p className="mt-2 text-xs text-destructive">{errors.autoRollback}</p>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>settle window</CardTitle>
				</CardHeader>
				<CardContent>
					<form
						onSubmit={async (e) => {
							e.preventDefault()
							const v = settleValue.trim()
							if (v && (!/^\d+$/.test(v) || Number(v) > DEPLOY_SETTLE_MAX_SECONDS)) {
								setErrors((er) => ({ ...er, settle: SETTLE_COPY }))
								return
							}
							if (await save('settle', { deploySettleSeconds: v ? Number(v) : null }))
								setSettleDraft(null)
						}}
					>
						<FieldRow
							error={errors.settle}
							hint={`a push deploy waits this long so further pushes ship with it as one deploy of the newest commit. 0: never wait. empty: the install default (off unless set). at most ${DEPLOY_SETTLE_MAX_SECONDS}. a commit with [urgent] or redeploy now skips the wait.`}
							action={
								<Button type="submit" variant="outline" disabled={!settleDirty || saving !== null}>
									{saving === 'settle' ? 'saving…' : 'save'}
								</Button>
							}
						>
							<Input
								label="seconds"
								placeholder="install default"
								inputMode="numeric"
								value={settleValue}
								disabled={!meta}
								onChange={(e) => setSettleDraft(e.target.value)}
								className="font-mono"
							/>
						</FieldRow>
					</form>
				</CardContent>
			</Card>

			<AppControls project={project} reload={reload} />
		</div>
	)
}
