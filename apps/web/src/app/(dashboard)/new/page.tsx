'use client'

import { uiErrorCopy } from '@/lib/ui-error-copy'
import { RECREATE_COMMAND } from '@/lib/recreate-hint'
import { Alert } from '@/components/ui/alert'
import { buttonVariants } from '@/components/ui/button-variants'
import { PageHeader } from '@/components/ui/page-header'
import Link from 'next/link'
import { SkeletonList } from '@/components/ui/skeleton'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronRight, Lock, Plus, Search, Trash2 } from 'lucide-react'
import { signIn } from '@/lib/auth-client'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { AddServerCard } from '@/components/add-server-card'
import { AgentHelp } from '@/components/agent-help'
import { appReadyPrompt } from '@/lib/agent-help-prompts'
import { parseRawEnv, serializeEnv } from '@/lib/env-parse'
import { newAppServerChoice } from '@/lib/new-app-servers'

interface GhRepo {
	id: number
	fullName: string
	name: string
	ownerLogin: string
	ownerAvatar: string
	private: boolean
	defaultBranch: string
	sshUrl: string
	updatedAt: string
}

interface ServerSummary {
	id: string
	name: string
	host: string
	kind: 'compose' | 'raw-docker'
	status: string
	traefik?: boolean
	baseDomain?: string | null
}

interface GhStatus {
	connected: boolean
	oauthAvailable?: boolean
}

interface DetectResult {
	framework: { id: string; displayName: string; defaultContainerPort: number }
	packageManager?: 'bun' | 'pnpm' | 'yarn' | 'npm'
	hasDockerfile: boolean
	defaultDockerfilePath: string
}

type Entry = { key: string; value: string; id: number }
let entryIdSeed = 0
const newId = () => ++entryIdSeed

export default function NewAppPage() {
	const router = useRouter()
	const [repos, setRepos] = useState<GhRepo[] | null>(null)
	const [reposError, setReposError] = useState<string | null>(null)
	const [github, setGithub] = useState<GhStatus | null>(null)
	// The status probe itself failed (5xx, network): not the same as "not connected".
	const [githubError, setGithubError] = useState<string | null>(null)
	const [githubRetrying, setGithubRetrying] = useState(false)
	const [allServers, setAllServers] = useState<ServerSummary[]>([])
	const [loading, setLoading] = useState(true)

	const [repoQuery, setRepoQuery] = useState('')
	const [pickedRepo, setPickedRepo] = useState<GhRepo | null>(null)
	const [branch, setBranch] = useState('')
	const [serverId, setServerId] = useState<string>('')
	const [name, setName] = useState('')
	const [dockerfilePath, setDockerfilePath] = useState('./Dockerfile')
	const [containerPort, setContainerPort] = useState('3000')

	const [envMode, setEnvMode] = useState<'form' | 'raw'>('form')
	const [envEntries, setEnvEntries] = useState<Entry[]>([])
	const [envRaw, setEnvRaw] = useState('')
	const [addPostgres, setAddPostgres] = useState(false)
	const [addKv, setAddKv] = useState(false)
	const [sharedInternal, setSharedInternal] = useState(false)
	const [addAgentsMd, setAddAgentsMd] = useState(false)

	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [showAddServer, setShowAddServer] = useState(false)
	const [showServerPicker, setShowServerPicker] = useState(false)
	const [detect, setDetect] = useState<DetectResult | null>(null)
	const [detecting, setDetecting] = useState(false)
	const [generatingDockerfile, setGeneratingDockerfile] = useState(false)
	const [dockerfileError, setDockerfileError] = useState<string | null>(null)

	async function loadServers() {
		const res = await fetch('/api/servers/list')
		if (!res.ok) return
		const data = (await res.json()) as { servers: ServerSummary[] }
		setAllServers(data.servers)
		// One rule for the pick and the picker (lib/new-app-servers.ts).
		setServerId((curr) => newAppServerChoice(data.servers, curr).selectedId)
	}

	const serverChoice = newAppServerChoice(allServers, serverId)
	const servers = serverChoice.eligible

	// Ask whether GitHub is connected first: not connected is a normal state here,
	// not a failed repo listing. A probe that fails says so and offers a retry.
	async function loadGithub() {
		setGithubError(null)
		const ghRes = await fetch('/api/integrations/github').catch(() => null)
		const gh: GhStatus | null = ghRes?.ok ? await ghRes.json().catch(() => null) : null
		if (!gh) {
			setGithubError(ghRes ? `the status check failed (${ghRes.status})` : 'network error')
			return
		}
		setGithub(gh)
		if (gh.connected) {
			setReposError(null)
			const repoRes = await fetch('/api/integrations/github/repos').catch(() => null)
			if (repoRes?.ok) {
				const data = (await repoRes.json()) as { repos: GhRepo[] }
				setRepos(data.repos)
			} else {
				const data = repoRes ? await repoRes.json().catch(() => ({})) : {}
				setReposError(
					data.error ?? (repoRes ? `GitHub error (${repoRes.status})` : 'network error'),
				)
			}
		}
	}

	async function retryGithub() {
		setGithubRetrying(true)
		try {
			await loadGithub()
		} finally {
			setGithubRetrying(false)
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount; loadServers and loadGithub are recreated every render and only call state setters, so listing them would refetch on every render
	useEffect(() => {
		;(async () => {
			await Promise.all([loadGithub(), loadServers()])
			setLoading(false)
		})()
	}, [])

	async function pickRepo(r: GhRepo) {
		setPickedRepo(r)
		setBranch(r.defaultBranch)
		if (!name) setName(slugify(r.name))
		setRepoQuery('')
		setDockerfileError(null)
		// Auto-detect framework + dockerfile in the background; prefill defaults.
		setDetect(null)
		setDetecting(true)
		try {
			const res = await fetch(
				`/api/integrations/github/repos/${encodeURIComponent(r.ownerLogin)}/${encodeURIComponent(r.name)}/detect?ref=${encodeURIComponent(r.defaultBranch)}`,
			)
			if (res.ok) {
				const d = (await res.json()) as DetectResult
				setDetect(d)
				if (d.framework.defaultContainerPort) {
					setContainerPort(String(d.framework.defaultContainerPort))
				}
				if (d.defaultDockerfilePath) {
					setDockerfilePath(d.defaultDockerfilePath)
				}
			}
		} catch {
			// non-fatal: defaults stay
		} finally {
			setDetecting(false)
		}
	}

	async function generateDockerfile() {
		if (!pickedRepo) return
		setGeneratingDockerfile(true)
		setDockerfileError(null)
		try {
			const res = await fetch(
				`/api/integrations/github/repos/${encodeURIComponent(pickedRepo.ownerLogin)}/${encodeURIComponent(pickedRepo.name)}/dockerfile`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ branch }),
				},
			)
			if (!res.ok) {
				const data = await res.json().catch(() => ({}))
				setDockerfileError(data.error ?? `failed (${res.status})`)
				return
			}
			// re-detect to flip the green/red badge
			const det = await fetch(
				`/api/integrations/github/repos/${encodeURIComponent(pickedRepo.ownerLogin)}/${encodeURIComponent(pickedRepo.name)}/detect?ref=${encodeURIComponent(branch)}`,
			)
			if (det.ok) setDetect((await det.json()) as DetectResult)
		} finally {
			setGeneratingDockerfile(false)
		}
	}

	const filteredRepos = useMemo(() => {
		if (!repos) return []
		const q = repoQuery.trim().toLowerCase()
		const list = q
			? repos.filter((r) => r.fullName.toLowerCase().includes(q))
			: [...repos].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
		return list.slice(0, 8)
	}, [repos, repoQuery])

	function envEntriesNow(): { key: string; value: string }[] {
		if (envMode === 'raw') return parseRawEnv(envRaw)
		return envEntries.filter((e) => e.key).map(({ key, value }) => ({ key, value }))
	}

	const serverForUrl = servers.find((s) => s.id === serverId)
	const isTraefik = !!serverForUrl?.traefik
	const baseDomain = serverForUrl?.baseDomain ?? null
	const previewUrl =
		isTraefik && baseDomain && /^[a-z][a-z0-9-]{1,30}$/.test(name)
			? `https://${name}.${baseDomain}`
			: null
	const noBaseDomain = isTraefik && !baseDomain

	const canSubmit =
		!!pickedRepo &&
		!!branch &&
		servers.some((s) => s.id === serverId) &&
		/^[a-z][a-z0-9-]{1,30}$/.test(name) &&
		!!containerPort &&
		!submitting

	async function submit() {
		if (!pickedRepo) return
		setSubmitting(true)
		setError(null)
		try {
			const res = await fetch('/api/apps', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					serverId,
					repoFullName: pickedRepo.fullName,
					branch,
					name,
					dockerfilePath,
					containerPort: Number(containerPort),
					envVars: envEntriesNow(),
					addPostgres,
					addKv,
					sharedInternal,
					addAgentsMd,
				}),
			})
			if (!res.ok) {
				const data = await res.json().catch(() => ({}))
				setError(data.error ? uiErrorCopy(data.error) : `failed (${res.status})`)
				setSubmitting(false)
				return
			}
			const data = (await res.json().catch(() => ({}))) as { id?: string; repoId?: string }
			const projectId = data.repoId ?? data.id
			router.push(projectId ? `/projects/${projectId}` : '/projects')
		} catch (e) {
			setError(e instanceof Error ? e.message : 'request failed')
			setSubmitting(false)
		}
	}

	if (loading) {
		return (
			<div className="space-y-6">
				<title>new app · powder</title>
				<Header />
				<SkeletonList />
			</div>
		)
	}

	const onlyOneServer = !serverChoice.showPicker
	const pickedServer = servers.find((s) => s.id === serverId)

	if (githubError) {
		return (
			<div className="max-w-2xl space-y-8">
				<title>new app · powder</title>
				<Header />
				<Alert
					tone="destructive"
					title="can't check the GitHub connection"
					action={
						<Button variant="outline" size="sm" onClick={retryGithub} loading={githubRetrying}>
							retry
						</Button>
					}
				>
					{githubError}. retry, or check the integrations page.
				</Alert>
			</div>
		)
	}

	if (!github?.connected || servers.length === 0) {
		return (
			<div className="max-w-2xl space-y-8">
				<title>new app · powder</title>
				<Header />
				<GettingStarted
					github={github ?? { connected: false }}
					hasServer={servers.length > 0}
					ineligible={serverChoice.ineligible.map((x) => x.name)}
					showAddServer={showAddServer}
					setShowAddServer={setShowAddServer}
					onServerAdded={async (added) => {
						await loadServers()
						setServerId(added.id)
						setShowAddServer(false)
					}}
				/>
			</div>
		)
	}

	return (
		<div className="max-w-2xl space-y-8">
			<title>new app · powder</title>
			<Header />

			{/* Step 1: pick a repo */}
			{reposError ? (
				<Alert
					tone="warning"
					title="can't list your GitHub repos"
					action={
						<Link
							href="/integrations"
							className={buttonVariants({ size: 'sm', variant: 'outline' })}
						>
							open integrations
						</Link>
					}
				>
					{reposError}. check the GitHub connection on the integrations page.
				</Alert>
			) : !pickedRepo ? (
				<section className="space-y-3">
					<SectionTitle step={1}>import a GitHub repo</SectionTitle>
					<div className="relative">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={repoQuery}
							onChange={(e) => setRepoQuery(e.target.value)}
							placeholder="search your repos…"
							className="pl-8"
						/>
					</div>
					<div className="rounded-md border border-border divide-y divide-border">
						{filteredRepos.length === 0 ? (
							<div className="px-3 py-3 text-xs text-muted-foreground">no matches.</div>
						) : (
							filteredRepos.map((r) => (
								<button
									key={r.id}
									type="button"
									onClick={() => pickRepo(r)}
									className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent/50"
								>
									<img src={r.ownerAvatar} alt="" className="h-5 w-5 rounded" />
									<div className="min-w-0 flex-1">
										<div className="truncate font-mono text-xs">{r.fullName}</div>
										<div className="truncate text-2xs text-muted-foreground">
											{r.defaultBranch} · updated {relTime(r.updatedAt)}
										</div>
									</div>
									{r.private && <Lock className="h-3 w-3 text-muted-foreground" />}
								</button>
							))
						)}
					</div>
				</section>
			) : (
				<>
					{/* picked repo summary, very compact */}
					<section className="rounded-md border border-border px-3 py-2.5 space-y-1">
						<div className="flex items-center justify-between gap-2">
							<div className="flex items-center gap-2 min-w-0">
								<img src={pickedRepo.ownerAvatar} alt="" className="h-5 w-5 rounded" />
								<span className="truncate font-mono text-sm">{pickedRepo.fullName}</span>
								{pickedRepo.private && <Lock className="h-3 w-3 text-muted-foreground" />}
								<span className="ml-2 text-2xs text-muted-foreground">
									branch: <span className="font-mono">{branch}</span>
								</span>
							</div>
							<Button variant="ghost" size="sm" onClick={() => setPickedRepo(null)}>
								change
							</Button>
						</div>
						{detecting ? (
							<div className="text-2xs text-muted-foreground">detecting framework…</div>
						) : detect ? (
							<div className="space-y-1">
								<div className="flex items-center gap-3 text-2xs text-muted-foreground">
									<span>
										detected:{' '}
										<span className="text-foreground">{detect.framework.displayName}</span>
										{detect.framework.id !== 'unknown' &&
											` · port ${detect.framework.defaultContainerPort}`}
										{detect.packageManager && ` · ${detect.packageManager}`}
									</span>
									{detect.hasDockerfile ? (
										<span className="text-success">✓ Dockerfile found</span>
									) : (
										<span className="text-destructive">no Dockerfile</span>
									)}
								</div>
								{!detect.hasDockerfile && detect.framework.id !== 'unknown' && (
									<div className="flex items-center gap-2">
										<Button
											size="sm"
											variant="outline"
											onClick={generateDockerfile}
											disabled={generatingDockerfile}
										>
											{generatingDockerfile
												? 'committing…'
												: `✨ commit a Dockerfile for ${detect.framework.displayName}`}
										</Button>
										<span className="text-2xs text-muted-foreground">
											pushes one commit to <span className="font-mono">{branch}</span>
										</span>
									</div>
								)}
								{dockerfileError && (
									<div className="text-2xs text-destructive">{dockerfileError}</div>
								)}
							</div>
						) : null}
						<AgentHelp
							className="pt-1.5"
							title="make this repo powder-ready"
							description="run it in a checkout of this repo. it checks the Dockerfile, health endpoint and env against how powder builds and swaps."
							prompt={appReadyPrompt({
								repo: pickedRepo.fullName,
								branch,
								name,
								framework: detect?.framework.displayName ?? null,
								hasDockerfile: detect ? detect.hasDockerfile : null,
								dockerfilePath,
								port: containerPort,
								addPostgres,
								addKv,
							})}
							note="includes the repo, branch, name, port and options you picked here. no secrets."
						/>
					</section>

					{/* destination: only show if >1 server. otherwise just a tiny pill */}
					{servers.length === 0 ? null : onlyOneServer ? (
						<section className="text-xs text-muted-foreground">
							deploying to{' '}
							<span className="rounded-md border border-border px-1.5 py-0.5 font-mono">
								{pickedServer?.name ?? '-'}
							</span>
						</section>
					) : (
						<section className="space-y-2">
							<SectionTitle step={2}>deploy target</SectionTitle>
							{!showServerPicker && pickedServer ? (
								<div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
									<div className="text-sm">
										{pickedServer.name}{' '}
										<span className="text-2xs text-muted-foreground font-mono">
											{pickedServer.host}
										</span>
									</div>
									<Button variant="ghost" size="sm" onClick={() => setShowServerPicker(true)}>
										change
									</Button>
								</div>
							) : (
								<div className="space-y-2">
									{servers.map((s) => (
										<label
											key={s.id}
											className="flex items-center gap-3 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent/30"
										>
											<input
												type="radio"
												name="server"
												value={s.id}
												checked={serverId === s.id}
												onChange={() => {
													setServerId(s.id)
													setShowServerPicker(false)
												}}
											/>
											<div className="flex-1 min-w-0">
												<div className="text-sm">{s.name}</div>
												<div className="text-2xs text-muted-foreground font-mono">{s.host}</div>
											</div>
											{s.status !== 'connected' && (
												<span className="text-2xs text-destructive">{s.status}</span>
											)}
										</label>
									))}
									{showAddServer ? (
										<AddServerCard
											onClose={() => setShowAddServer(false)}
											onAdded={async (added) => {
												await loadServers()
												setServerId(added.id)
												setShowServerPicker(false)
											}}
										/>
									) : (
										<Button variant="outline" size="sm" onClick={() => setShowAddServer(true)}>
											<Plus className="h-3 w-3" />
											add another server
										</Button>
									)}
								</div>
							)}
						</section>
					)}

					{/* Empty state: no server at all, or none /new can deploy to */}
					{servers.length === 0 && (
						<section className="space-y-3">
							<SectionTitle step={2}>deploy target</SectionTitle>
							{showAddServer ? (
								<AddServerCard
									onClose={() => setShowAddServer(false)}
									onAdded={async (added) => {
										await loadServers()
										setServerId(added.id)
									}}
								/>
							) : (
								<div className="rounded-md border border-dashed border-border p-4 space-y-2">
									{serverChoice.ineligible.length > 0 ? (
										<>
											<p className="text-sm font-medium">no server here can take a new app.</p>
											<p className="text-xs text-muted-foreground">
												new apps run with docker compose, and{' '}
												{serverChoice.ineligible.length === 1
													? 'your server is'
													: 'your servers are'}{' '}
												registered as raw-docker (
												<span className="font-mono">
													{serverChoice.ineligible.map((x) => x.name).join(', ')}
												</span>
												). add a compose server, or remove the server on{' '}
												<Link
													href="/servers"
													className="text-foreground underline underline-offset-2"
												>
													servers
												</Link>{' '}
												and add it again with kind compose.
											</p>
										</>
									) : (
										<>
											<p className="text-sm font-medium">you don't have a server yet.</p>
											<p className="text-xs text-muted-foreground">
												powder runs your apps on a Linux server. you paste one command on it and
												fill in its address here.
											</p>
										</>
									)}
									<Button size="sm" onClick={() => setShowAddServer(true)}>
										<Plus className="h-3 w-3" />
										add server
									</Button>
								</div>
							)}
						</section>
					)}

					{noBaseDomain && (
						<section className="rounded-md border border-border px-4 py-3 text-sm text-muted-foreground">
							no base domain set on this server, add a custom domain after the first deploy.
						</section>
					)}

					{/* live URL preview, prominent */}
					{previewUrl && (
						<section className="rounded-md border border-powder/40 bg-powder/5 px-4 py-3 text-sm">
							<div className="text-2xs text-muted-foreground">your app will be at</div>
							<div className="mt-0.5 font-mono">{previewUrl}</div>
							<div className="mt-1 text-2xs text-muted-foreground">
								https cert auto-issued on first hit (~30s).
							</div>
						</section>
					)}

					{/* Step: name + database */}
					<section className="space-y-4">
						<SectionTitle step={onlyOneServer || servers.length === 0 ? 2 : 3}>
							set it up
						</SectionTitle>

						<Field id="new-app-name" label="name" hint="lowercase, digits, hyphens">
							<Input
								id="new-app-name"
								aria-describedby="new-app-name-msg"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="widget"
								className="font-mono"
							/>
						</Field>

						<label
							className={`flex items-start gap-3 rounded-md border border-border px-3 py-3 ${'cursor-pointer hover:bg-accent/30'}`}
						>
							<input
								type="checkbox"
								checked={addPostgres}
								onChange={(e) => setAddPostgres(e.target.checked)}
								className="mt-0.5"
							/>
							<div className="flex-1">
								<div className="text-sm font-medium">add a database</div>
								<div className="text-2xs text-muted-foreground">
									postgres 16, runs next to your app. you'll get a{' '}
									<span className="font-mono">DATABASE_URL</span> automatically.
								</div>
							</div>
						</label>

						<label className="flex items-start gap-3 rounded-md border border-border px-3 py-3 cursor-pointer hover:bg-accent/30">
							<input
								type="checkbox"
								checked={addKv}
								onChange={(e) => setAddKv(e.target.checked)}
								className="mt-0.5"
							/>
							<div className="flex-1">
								<div className="text-sm font-medium">add a key-value store</div>
								<div className="text-2xs text-muted-foreground">
									redis 7, sibling container. you'll get a{' '}
									<span className="font-mono">REDIS_URL</span> in the env. data persists across
									deploys.
								</div>
							</div>
						</label>

						<label className="flex items-start gap-3 rounded-md border border-border px-3 py-3 cursor-pointer hover:bg-accent/30">
							<input
								type="checkbox"
								checked={sharedInternal}
								onChange={(e) => setSharedInternal(e.target.checked)}
								className="mt-0.5"
							/>
							<div className="flex-1">
								<div className="text-sm font-medium">join the shared internal network</div>
								<div className="text-2xs text-muted-foreground">
									only if the app must reach a container of another project on this server (a shared
									database, for example). off by default: the app gets{' '}
									<span className="font-mono">web</span> and its own networks only.
								</div>
							</div>
						</label>

						<label className="flex items-start gap-3 rounded-md border border-border px-3 py-3 cursor-pointer hover:bg-accent/30">
							<input
								type="checkbox"
								checked={addAgentsMd}
								onChange={(e) => setAddAgentsMd(e.target.checked)}
								className="mt-0.5"
							/>
							<div className="flex-1">
								<div className="text-sm font-medium">commit an AGENTS.md</div>
								<div className="text-2xs text-muted-foreground">
									one commit to <span className="font-mono">{branch}</span>, only if the repo has
									none: what a push does, where env vars live, how to check a deploy. for people and
									coding agents working in the repo.
								</div>
							</div>
						</label>

						<details className="group">
							<summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
								<ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
								environment variables (optional)
							</summary>
							<div className="mt-2 space-y-2">
								<div className="flex items-center justify-end">
									<div className="flex rounded-md border border-border p-0.5 text-xs">
										<button
											type="button"
											onClick={() => {
												if (envMode === 'raw') {
													setEnvEntries(parseRawEnv(envRaw).map((e) => ({ ...e, id: newId() })))
												}
												setEnvMode('form')
											}}
											className={`rounded px-3 py-1 ${envMode === 'form' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
										>
											form
										</button>
										<button
											type="button"
											onClick={() => {
												if (envMode === 'form') {
													setEnvRaw(serializeEnv(envEntries))
												}
												setEnvMode('raw')
											}}
											className={`rounded px-3 py-1 ${envMode === 'raw' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
										>
											raw .env
										</button>
									</div>
								</div>
								{envMode === 'raw' ? (
									<Textarea
										aria-label="environment variables, one KEY=value per line"
										value={envRaw}
										onChange={(e) => setEnvRaw(e.target.value)}
										spellCheck={false}
										textareaSize="sm"
										className="min-h-[180px] font-mono leading-relaxed"
										placeholder={'DATABASE_URL=postgres://…\nNODE_ENV=production'}
									/>
								) : (
									<div className="space-y-2">
										{envEntries.map((e, i) => (
											<div key={e.id} className="flex gap-2">
												<label htmlFor={`new-env-key-${e.id}`} className="sr-only">
													variable {i + 1} name
												</label>
												<Input
													id={`new-env-key-${e.id}`}
													value={e.key}
													onChange={(ev) =>
														setEnvEntries((curr) =>
															curr.map((x) =>
																x.id === e.id ? { ...x, key: ev.target.value.toUpperCase() } : x,
															),
														)
													}
													placeholder="KEY"
													inputSize="sm"
													className="w-1/3 font-mono"
												/>
												<label htmlFor={`new-env-value-${e.id}`} className="sr-only">
													variable {i + 1} value
												</label>
												<Input
													id={`new-env-value-${e.id}`}
													value={e.value}
													onChange={(ev) =>
														setEnvEntries((curr) =>
															curr.map((x) =>
																x.id === e.id ? { ...x, value: ev.target.value } : x,
															),
														)
													}
													placeholder="value"
													inputSize="sm"
													className="min-w-0 flex-1 font-mono"
												/>
												<button
													type="button"
													onClick={() => setEnvEntries((curr) => curr.filter((x) => x.id !== e.id))}
													className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive"
													aria-label={`remove variable ${i + 1}`}
												>
													<Trash2 className="h-3.5 w-3.5" />
												</button>
											</div>
										))}
										<Button
											variant="outline"
											size="sm"
											onClick={() =>
												setEnvEntries((curr) => [...curr, { key: '', value: '', id: newId() }])
											}
										>
											<Plus className="h-3 w-3" />
											add var
										</Button>
									</div>
								)}
							</div>
						</details>

						<details className="group">
							<summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
								<ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
								advanced (dockerfile path, port)
							</summary>
							<div className="mt-3 space-y-3">
								<Field
									id="new-app-dockerfile"
									label="dockerfile path"
									hint="default: ./Dockerfile in the repo root"
								>
									<Input
										id="new-app-dockerfile"
										aria-describedby="new-app-dockerfile-msg"
										value={dockerfilePath}
										onChange={(e) => setDockerfilePath(e.target.value)}
										className="font-mono"
									/>
								</Field>
								<Field
									id="new-app-port"
									label="internal port"
									hint="what port your app listens on inside the container"
								>
									<Input
										id="new-app-port"
										aria-describedby="new-app-port-msg"
										type="number"
										value={containerPort}
										onChange={(e) => setContainerPort(e.target.value)}
										className="font-mono w-32"
									/>
								</Field>
							</div>
						</details>
					</section>
				</>
			)}

			{error && (
				<div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
					{error}
				</div>
			)}

			{pickedRepo && (
				<div className="flex items-center justify-end gap-2 pt-2">
					<Button variant="outline" size="sm" onClick={() => router.push('/projects')}>
						cancel
					</Button>
					<Button size="sm" onClick={submit} disabled={!canSubmit}>
						{submitting ? 'shipping…' : 'ship it'}
					</Button>
				</div>
			)}
		</div>
	)
}

// Before the form makes sense: a server to deploy to and GitHub to import from,
// in that order, each with its one next action.
function GettingStarted({
	github,
	hasServer,
	ineligible,
	showAddServer,
	setShowAddServer,
	onServerAdded,
}: {
	github: GhStatus
	hasServer: boolean
	ineligible: string[]
	showAddServer: boolean
	setShowAddServer: (v: boolean) => void
	onServerAdded: (added: { id: string }) => Promise<void>
}) {
	const [redirecting, setRedirecting] = useState(false)
	async function connect() {
		setRedirecting(true)
		try {
			await signIn.social({
				provider: 'github',
				callbackURL: '/new',
				errorCallbackURL: '/integrations?gh_error=1',
			})
		} catch {
			// sign-in did not redirect; the button can be pressed again
		} finally {
			setRedirecting(false)
		}
	}
	const serverNext = !hasServer
	const githubNext = hasServer && !github.connected
	return (
		<ol className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
			<Step n={1} done={hasServer} next={serverNext} title="add a server">
				{hasServer ? (
					'a server is ready for new apps.'
				) : ineligible.length > 0 ? (
					<>
						new apps run with docker compose, and{' '}
						{ineligible.length === 1 ? 'your server is' : 'your servers are'} registered as
						raw-docker (<span className="font-mono">{ineligible.join(', ')}</span>). add a compose
						server, or remove it on{' '}
						<Link href="/servers" className="text-foreground underline underline-offset-2">
							servers
						</Link>{' '}
						and add it again.
					</>
				) : (
					'any Linux machine you can SSH into as root. you run one command on it and enter its address here.'
				)}
				{!hasServer &&
					(showAddServer ? (
						<div className="mt-3">
							<AddServerCard onClose={() => setShowAddServer(false)} onAdded={onServerAdded} />
						</div>
					) : (
						<div className="mt-3">
							<Button size="sm" onClick={() => setShowAddServer(true)}>
								<Plus className="h-3.5 w-3.5" />
								add a server
							</Button>
						</div>
					))}
			</Step>
			<Step n={2} done={github.connected} next={githubNext} title="connect GitHub">
				{github.connected ? (
					'powder can list your repos.'
				) : github.oauthAvailable ? (
					<>
						powder lists your repos, adds a read-only deploy key and a push webhook to the one you
						import.
						<div className="mt-3">
							<Button
								size="sm"
								variant={githubNext ? 'default' : 'outline'}
								onClick={connect}
								loading={redirecting}
							>
								connect GitHub
							</Button>
						</div>
					</>
				) : (
					<>
						this powder has no GitHub OAuth app yet. create one, set{' '}
						<code className="font-mono text-foreground">GITHUB_CLIENT_ID</code> and{' '}
						<code className="font-mono text-foreground">GITHUB_CLIENT_SECRET</code> in{' '}
						<code className="font-mono text-foreground">powder.env</code>, then in the powder source
						dir run <code className="font-mono text-foreground break-all">{RECREATE_COMMAND}</code>{' '}
						(a restart does not re-read the file). or paste a personal access token on the{' '}
						<Link href="/integrations" className="text-foreground underline underline-offset-2">
							integrations
						</Link>{' '}
						page.
						<div className="mt-3">
							<Link
								href="/docs/quickstart"
								className={buttonVariants({
									size: 'sm',
									variant: githubNext ? 'default' : 'outline',
								})}
							>
								open the quickstart
							</Link>
						</div>
					</>
				)}
			</Step>
			<Step n={3} done={false} next={false} title="import a GitHub repo">
				pick a repo and a name. powder builds it on your server and gives it a public HTTPS URL.
			</Step>
		</ol>
	)
}

function Step({
	n,
	done,
	next,
	title,
	children,
}: {
	n: number
	done: boolean
	next: boolean
	title: string
	children: React.ReactNode
}) {
	return (
		<li
			className={cn(
				'flex gap-3 border-b border-border px-4 py-4 last:border-b-0 sm:px-5',
				next && 'bg-accent/30',
			)}
		>
			<span
				className={cn(
					'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-2xs font-semibold',
					done
						? 'border-success/40 bg-success/10 text-success'
						: next
							? 'border-foreground bg-foreground text-background'
							: 'border-border-strong text-muted-foreground',
				)}
			>
				{done ? <Check className="h-3 w-3" aria-hidden="true" /> : n}
			</span>
			<div className="min-w-0 flex-1">
				<p className={cn('text-sm font-medium', (done || !next) && 'text-muted-foreground')}>
					{title}
					{done && <span className="sr-only"> (done)</span>}
				</p>
				<div className="mt-0.5 text-xs text-muted-foreground">{children}</div>
			</div>
		</li>
	)
}

function SectionTitle({ step, children }: { step: number; children: React.ReactNode }) {
	return (
		<h2 className="flex items-center gap-2.5">
			<span className="flex h-6 w-6 items-center justify-center rounded-full border border-border-strong bg-card font-mono text-2xs font-semibold text-foreground">
				{step}
			</span>
			<span className="text-sm font-semibold tracking-tight">{children}</span>
		</h2>
	)
}

function relTime(iso: string): string {
	try {
		const t = new Date(iso).getTime()
		const diff = Date.now() - t
		const min = 60_000
		const hr = 60 * min
		const day = 24 * hr
		if (diff < min) return 'just now'
		if (diff < hr) return `${Math.round(diff / min)}m ago`
		if (diff < day) return `${Math.round(diff / hr)}h ago`
		return `${Math.round(diff / day)}d ago`
	} catch {
		return ''
	}
}

function Header() {
	return (
		<PageHeader
			back={{ href: '/projects', label: 'apps' }}
			title="new app"
			description="pick a GitHub repo and a server. powder builds it there and gives it a public HTTPS URL."
		/>
	)
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 31)
}
