import { after } from 'next/server'
import { BodyTooLargeError, MAX_WEBHOOK_BYTES, bodyTooLargeResponse, readTextCapped } from '@/lib/http-limits'
import { runInWeb } from '@/lib/deploy-runner'
import { pushIsUrgent, settleNote } from '@/lib/deploy-settle'
import { AppBeingDeletedError, DeployInFlightError, appDeleteInFlight, deployWorkerEnabled, recentSuccessfulGitShas, startDeploy } from '@/lib/deploys'
import { pathsMatch } from '@/lib/paths-match'
import { onlyDeploymentMdChanged } from '@/lib/deployment-md-push'
import { schedulePendingRedeploy } from '@/lib/pending-redeploy'
import { commentPreviewOnPR, notifyDeploymentStarted } from '@/lib/github-deployments'
import { previewBuildInputs, previewLastSha, previewSkipReason, spinOrRedeployPreview } from '@/lib/preview-deploys'
import { checkRateLimit } from '@/lib/rate-limit'
import { rateLimitedResponse, unknownTokenResponse, webhookClientIp, webhookEventGate, webhookLimitKeys } from '@/lib/webhook-gate'
import { decryptWebhookSecret, getRepoByToken, setRepoGithubIds } from '@/lib/repos'
import { notify } from '@/lib/notifications'
import { redactSecrets } from '@/lib/secret-text'
import { repoIdDecision } from '@/lib/webhook-repo-id'
import { decryptWebhookSecretForGroup, getGroupByToken, listSubAppsForGroup, setGroupGithubRepoId } from '@/lib/repo-groups'
import { payloadFullName, removeStaleHook } from '@/lib/stale-webhook'

/** How many of an app's latest successful git deploys count as "already deployed". */
const RECENT_SHAS = 20

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
	const { token } = await ctx.params

	// Best-effort rate limiting. The cheap per-IP check runs first (no DB hit);
	// the per-token bucket is charged only once the signature verified
	// (webhookEventGate onVerified), so unsigned or badly signed POSTs cost only
	// the per-IP bucket and cannot starve real deliveries. A limiter error never
	// breaks a legitimate deploy (rateLimitedResponse swallows it).
	// a token that cannot be one is refused before any bucket or DB lookup;
	// with no trusted client IP there is no per-IP bucket (a shared 'unknown' bucket
	// let one client 429 every GitHub delivery).
	const keys = webhookLimitKeys(webhookClientIp(req.headers), token)
	if (!keys) return Response.json({ error: 'unknown webhook' }, { status: 404 })
	if (keys.ipKey) {
		const limited = rateLimitedResponse(checkRateLimit, keys.ipKey, 60, 60_000)
		if (limited) return limited
	}
	const chargeToken = () => rateLimitedResponse(checkRateLimit, keys.tokenKey, 30, 60_000)

	// Both lookups run for every token (app, group or unknown), so the number of
	// queries before the signature check does not tell the three apart.
	const [repo, group] = await Promise.all([getRepoByToken(token), getGroupByToken(token)])
	if (!repo) {
		// Not a single-app token: maybe a deployment-group (mono) token. Fan out
		// to every sub-app whose pathsFilter matches the push.
		if (group) return handleGroupWebhook(group, req, chargeToken)
		// Unknown token: read the body and answer like a bad signature
		// (lib/webhook-gate.ts), so the answer does not tell an unknown token from
		// a valid one. A GitHub hook still posting to a token powder no longer has
		// is removed after answering (lib/stale-webhook.ts holds the guards).
		let unknownBody: string
		try {
			unknownBody = await readTextCapped(req, MAX_WEBHOOK_BYTES)
		} catch (err) {
			if (err instanceof BodyTooLargeError) return bodyTooLargeResponse()
			throw err
		}
		const hookId = req.headers.get('x-github-hook-id')
		if (hookId && req.headers.get('x-github-event')) {
			const repository = payloadFullName(unknownBody)
			if (repository) after(() => removeStaleHook({ token, hookId, repository }).then(() => {}))
		}
		return unknownTokenResponse(unknownBody, req.headers.get('x-hub-signature-256') ?? '')
	}

	const sig = req.headers.get('x-hub-signature-256') ?? ''
	const event = req.headers.get('x-github-event') ?? ''
	let body: string
	try {
		body = await readTextCapped(req, MAX_WEBHOOK_BYTES)
	} catch (err) {
		if (err instanceof BodyTooLargeError) return bodyTooLargeResponse()
		throw err
	}

	// Signature first, then ping/non-push replies (lib/webhook-gate.ts).
	const gated = webhookEventGate(event, body, sig, decryptWebhookSecret(repo), {
		delivery: req.headers.get('x-github-delivery'),
		onVerified: chargeToken,
	})
	if (gated) return gated
	if (deliverySeen(req)) return Response.json({ ignored: 'duplicate delivery' })

	let payload: {
		ref?: string
		after?: string
		pusher?: { name?: string }
		powder_force?: boolean
		repository?: unknown
		commits?: unknown
		head_commit?: unknown
		forced?: unknown
		created?: unknown
		deleted?: unknown
	} = {}
	try {
		payload = JSON.parse(body)
	} catch {
		return Response.json({ error: 'bad json' }, { status: 400 })
	}
	// the signed body must keep naming the connected repository.
	const repoId = repoIdDecision(repo, payload.repository)
	if (repoId.action === 'refuse') {
		console.warn(`[webhook] ${repo.containerName}: ${repoId.message}`)
		void notify('deploy_failed', {
			app: repo.containerName,
			server: repo.serverId,
			appRepoId: repo.id,
			instanceId: req.headers.get('x-github-delivery') ?? undefined,
			message: redactSecrets(repoId.message),
		})
		return Response.json({ error: repoId.message }, { status: 409 })
	}
	if (repoId.warn) console.warn(`[webhook] ${repo.containerName}: ${repoId.warn}`)
	if (repoId.action === 'store') await setRepoGithubIds(repo.id, { repoId: repoId.id })
	const ref = payload.ref ?? ''
	// Only branch pushes deploy: tags, notes and other refs are ignored.
	if (!ref.startsWith('refs/heads/')) {
		return Response.json({ ignored: `ref ${ref || '(none)'} is not a branch` })
	}
	const branch = ref.slice('refs/heads/'.length)

	// A delete of this app is running: no preview and no deploy for it (startDeploy
	// refuses too; this also stops a preview from being spun for an app going away).
	if (await appDeleteInFlight(repo.serverId, repo.containerName)) {
		return Response.json({ error: 'app is being deleted' }, { status: 409 })
	}

	// Non-default branch on an app on a Traefik server → preview deploy.
	if (branch !== repo.branch) {
		// Bot pushes (dependabot, renovate, ...) never spin a preview.
		if (payload.pusher?.name?.endsWith('[bot]')) {
			return Response.json({ ignored: `bot push by ${payload.pusher.name}` })
		}
		const skipReason = await previewSkipReason(repo)
		if (skipReason) {
			return Response.json({
				ignored: `branch ${branch} != ${repo.branch}`,
				reason: skipReason,
			})
		}
		// Replay guard: a replayed push of the sha this preview already runs is not redeployed
		// (powder_force in the signed body overrides, like the main path).
		if (payload.powder_force !== true && payload.after && /^[0-9a-f]{40}$/.test(payload.after)) {
			const last = await previewLastSha(repo, branch).catch(() => null)
			if (last && last === payload.after) {
				return Response.json({ ignored: 'preview already at this commit', sha: payload.after }, { status: 200 })
			}
		}
		// fire-and-forget; github gets 202 immediately
		;(async () => {
			try {
				// The app's own Dockerfile and port, not ./Dockerfile:3000.
				const { containerPort, dockerfilePath } = await previewBuildInputs(repo)
				const result = await spinOrRedeployPreview(repo, branch, containerPort, dockerfilePath, payload.after ?? null)
				console.log(`[preview] ${repo.containerName}/${branch} → ${result.url}`)
				// Sticky comment on the open PR. Best-effort: silent if no PR yet
				// or no GH integration. Re-runs every push, edits the same comment.
				const host = result.url.replace(/^https?:\/\//, '')
				await commentPreviewOnPR(repo, branch, {
					previewUrl: result.url,
					previewHost: host,
					sha: payload.after ?? null,
				})
			} catch (err) {
				console.error(`[preview] ${repo.containerName}/${branch} failed:`, err)
			}
		})()
		// an accepted preview push is remembered like a main-branch one, so a
		// replay of the same delivery id does not spin the preview again.
		rememberDelivery(req)
		return Response.json({ accepted: true, kind: 'preview', branch }, { status: 202 })
	}

	// powder's own DEPLOYMENT.md sync commit (or any push touching only that file) changes nothing that runs.
	if (payload.powder_force !== true && onlyDeploymentMdChanged(payload)) {
		return Response.json({ ignored: 'only DEPLOYMENT.md changed', sha: payload.after ?? null }, { status: 200 })
	}

	// Replay guard: a captured signed body replayed with a fresh delivery id would force a
	// rebuild (or roll back to an older commit) every time. If the pushed commit is one
	// of the app's last RECENT_SHAS successful git deploys, there is nothing to do.
	// Operator opt-in: `powder_force: true` inside the HMAC-signed body (GitHub never
	// sends it, so a captured GitHub delivery cannot carry it) skips this check.
	if (payload.powder_force !== true && payload.after && /^[0-9a-f]{40}$/.test(payload.after)) {
		const recent = await recentSuccessfulGitShas(repo.serverId, repo.containerName, RECENT_SHAS).catch(() => [] as string[])
		if (recent.includes(payload.after)) {
			return Response.json({ ignored: 'already deployed', sha: payload.after }, { status: 200 })
		}
	}

	// Acquire the deploy lock by inserting the row. The partial unique index
	// `deploys_in_flight_unique` rejects a second running row for the same app
	// — that's our cross-process lock. `deploy-watchdog` (15-min reap) frees
	// the lock if SSH hangs without throwing.
	let deploy: Awaited<ReturnType<typeof startDeploy>>
	try {
		deploy = await startDeploy({
			serverId: repo.serverId,
			containerName: repo.containerName,
			kind: 'git_deploy',
			triggeredBy: payload.pusher?.name ? `webhook:${payload.pusher.name}` : 'webhook',
			// Build exactly the pushed commit — not whatever HEAD is when the
			// worker gets to it — and the same commit on builder and target.
			requestedSha: payload.after ?? null,
			// powder_force or `[urgent]` in any pushed commit message: skip the settle window
			urgent: pushIsUrgent(payload),
		})
	} catch (err) {
		if (err instanceof AppBeingDeletedError) {
			return Response.json({ error: 'app is being deleted' }, { status: 409 })
		}
		if (err instanceof DeployInFlightError && err.coalesced) {
			// Folded into the app's already-queued deploy, which now builds the
			// branch HEAD (this commit included). Nothing dropped.
			rememberDelivery(req)
			return Response.json({ accepted: true, reason: 'folded into the queued deploy (builds branch HEAD)' }, { status: 202 })
		}
		if (err instanceof DeployInFlightError) {
			// A deploy is already in flight for this app. This push is not dropped:
			// a catch-up deploy fires once the current one clears. It git-syncs to
			// the branch HEAD, so it carries this commit and any others that land
			// mid-build, and a burst of pushes ends on the newest commit.
			schedulePendingRedeploy({
				serverId: repo.serverId,
				containerName: repo.containerName,
				triggeredBy: payload.pusher?.name ? `webhook-catchup:${payload.pusher.name}` : 'webhook-catchup',
			})
			rememberDelivery(req)
			return Response.json({ accepted: true, reason: 'catch-up scheduled (deploy in flight)' }, { status: 202 })
		}
		console.error('[webhook] startDeploy failed:', err)
		return Response.json({ error: 'failed to start deploy' }, { status: 500 })
	}

	rememberDelivery(req)

	// Surface deploy in GitHub commit/PR view. Best-effort; never blocks deploy.
	const deployRef = payload.after || repo.branch
	await notifyDeploymentStarted(repo, deploy, deployRef)

	// Hand off execution. In worker mode the row is 'queued' and the deploy
	// worker claims + runs it — so a powder self-deploy (which only recreates
	// the `powder` service) cannot SIGHUP an in-flight app deploy. In
	// in-web mode (POWDER_DEPLOY_WORKER off), run it here. Either way we
	// respond 202 immediately so GitHub doesn't time out the webhook.
	if (!deployWorkerEnabled()) {
		runInWeb(deploy)
	}

	const waiting = settleNote(deploy)
	return Response.json({ accepted: true, deployId: deploy.id, ...(waiting ? { waiting } : {}) }, { status: 202 })
}

// Mono / deployment-group webhook: one repo → many sub-apps. Verify with the
// group secret, then fan out a deploy to each sub-app whose pathsFilter matches
// the files changed in the push (no filter = always). Each sub-app's on-disk
// setup (src/ = group repo clone, .deploy-key = group key, compose build
// context ./src + its dockerfile_path) makes rebuildDeploy work unchanged.
async function handleGroupWebhook(
	group: NonNullable<Awaited<ReturnType<typeof getGroupByToken>>>,
	req: Request,
	chargeToken: () => Response | null,
): Promise<Response> {
	const sig = req.headers.get('x-hub-signature-256') ?? ''
	const event = req.headers.get('x-github-event') ?? ''
	let body: string
	try {
		body = await readTextCapped(req, MAX_WEBHOOK_BYTES)
	} catch (err) {
		if (err instanceof BodyTooLargeError) return bodyTooLargeResponse()
		throw err
	}
	const secret = decryptWebhookSecretForGroup(group)

	const gated = webhookEventGate(event, body, sig, secret, {
		pongExtra: { group: group.id },
		delivery: req.headers.get('x-github-delivery'),
		onVerified: chargeToken,
	})
	if (gated) return gated
	if (deliverySeen(req)) return Response.json({ ignored: 'duplicate delivery' })

	let payload: {
		ref?: string
		after?: string
		pusher?: { name?: string }
		commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>
		head_commit?: { added?: string[]; modified?: string[]; removed?: string[] }
		forced?: unknown
		created?: unknown
		deleted?: unknown
		powder_force?: boolean
		repository?: unknown
	} = {}
	try {
		payload = JSON.parse(body)
	} catch {
		return Response.json({ error: 'bad json' }, { status: 400 })
	}
	// the same repository-id pin as the single-app path, per group.
	const repoId = repoIdDecision(group, payload.repository)
	if (repoId.action === 'refuse') {
		console.warn(`[webhook-group] ${group.id}: ${repoId.message}`)
		for (const app of await listSubAppsForGroup(group.id).catch(() => [])) {
			void notify('deploy_failed', {
				app: app.containerName,
				server: app.serverId,
				appRepoId: app.id,
				instanceId: req.headers.get('x-github-delivery') ?? undefined,
				message: redactSecrets(repoId.message),
			})
		}
		return Response.json({ error: repoId.message }, { status: 409 })
	}
	if (repoId.warn) console.warn(`[webhook-group] ${group.id}: ${repoId.warn}`)
	if (repoId.action === 'store') await setGroupGithubRepoId(group.id, repoId.id)
	const branch = (payload.ref ?? '').replace(/^refs\/heads\//, '')
	if (branch !== group.branch) {
		return Response.json({ ignored: `branch ${branch} != ${group.branch}` })
	}

	if (payload.powder_force !== true && onlyDeploymentMdChanged(payload)) {
		return Response.json({ ignored: 'only DEPLOYMENT.md changed', sha: payload.after ?? null }, { status: 200 })
	}

	const changed = new Set<string>()
	for (const c of [
		...(payload.commits ?? []),
		...(payload.head_commit ? [payload.head_commit] : []),
	]) {
		for (const f of [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])])
			changed.add(f)
	}
	const changedFiles = [...changed]

	const subApps = await listSubAppsForGroup(group.id)
	const triggered: string[] = []
	const skipped: string[] = []
	const alreadyDeployed: string[] = []
	const checkReplay = payload.powder_force !== true && !!payload.after && /^[0-9a-f]{40}$/.test(payload.after)
	// one push, one answer for every sub-app row it creates or folds into
	const urgent = pushIsUrgent(payload)
	for (const app of subApps) {
		if (!pathsMatch(app.pathsFilter, changedFiles)) {
			skipped.push(app.containerName)
			continue
		}
		// Same replay guard as the single-app path, per sub-app.
		if (checkReplay) {
			const recent = await recentSuccessfulGitShas(app.serverId, app.containerName, RECENT_SHAS).catch(() => [] as string[])
			if (recent.includes(payload.after as string)) {
				alreadyDeployed.push(app.containerName)
				continue
			}
		}
		try {
			const deploy = await startDeploy({
				serverId: app.serverId,
				containerName: app.containerName,
				kind: 'git_deploy',
				triggeredBy: `webhook-group:${payload.pusher?.name ?? 'push'}`,
				requestedSha: payload.after ?? null,
				urgent,
			})
			triggered.push(app.containerName)
			if (!deployWorkerEnabled()) runInWeb(deploy)
		} catch (err) {
			if (err instanceof AppBeingDeletedError) {
				skipped.push(`${app.containerName} (being deleted)`)
			} else if (err instanceof DeployInFlightError && err.coalesced) {
				triggered.push(`${app.containerName} (folded into queued)`)
			} else if (err instanceof DeployInFlightError) {
				// Same catch-up as the single-app path: don't drop a sub-app push
				// that lands mid-deploy — re-queue it once the current one clears.
				schedulePendingRedeploy({
					serverId: app.serverId,
					containerName: app.containerName,
					triggeredBy: `webhook-group-catchup:${payload.pusher?.name ?? 'push'}`,
				})
			} else {
				console.error(`[webhook-group] startDeploy ${app.containerName} failed:`, err)
			}
		}
	}
	rememberDelivery(req)
	return Response.json({ accepted: true, kind: 'group', triggered, skipped, alreadyDeployed }, { status: 202 })
}

// Replay guard: a captured signed body stays valid forever (the HMAC has no
// timestamp), so remember GitHub's per-delivery id for 24h and drop repeats.
// Only deliveries that were ACCEPTED are remembered, so a GitHub "Redeliver" of
// one that failed (5xx, bad state) still goes through. In-memory is enough — a
// restart only reopens a window in which a replay redeploys HEAD anyway.
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000
const seenDeliveries = new Map<string, number>()
function deliverySeen(req: Request): boolean {
	const id = req.headers.get('x-github-delivery')
	if (!id) return false
	const t = seenDeliveries.get(id)
	return t !== undefined && Date.now() - t < DELIVERY_TTL_MS
}
function rememberDelivery(req: Request): void {
	const id = req.headers.get('x-github-delivery')
	if (!id) return
	const now = Date.now()
	if (seenDeliveries.size > 5000) {
		for (const [k, t] of seenDeliveries) if (now - t > DELIVERY_TTL_MS) seenDeliveries.delete(k)
	}
	seenDeliveries.set(id, now)
}
