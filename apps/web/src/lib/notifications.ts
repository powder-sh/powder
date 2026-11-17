// Notification dispatch. One entry point: notify(event, payload).
//
// Targets:
// - rows in notification_targets (kind 'webhook' with an encrypted URL, or
//   'email' over POWDER_SMTP_URL), each with its subscribed events and an
//   optional app filter (null = all apps). Managed at /settings/notifications.
// - POWDER_NOTIFY_WEBHOOK_URL, an implicit always-on webhook for the events in
//   ENV_WEBHOOK_EVENTS (notify-routing.ts: deploy_failed, app_down, app_up, cron_failed).
//
// Webhook body: {event, app, server, message, url, at}. Discord and Slack
// incoming webhooks want a text field, so `content` (Discord) and `text`
// (Slack) carry the same one-line message; other receivers ignore them.
//
// Best effort: never throws, short timeouts, errors are logged. The same
// (event, server, app) is sent once per dedupe window (5 minutes for most
// events, see dedupeWindowMs).
// Callers on the deploy path must not await it (fire and forget).

import { decryptSecret } from './crypto'
import { and, appRepos, db, eq, notificationTargets } from './db'
import type { AppRepo, AppUptimeCheck, NotificationTarget } from './db'
import { dashboardUrl } from './hosts'
import { sendMail } from './mailer'
import {
	NotifyDedupe,
	type NotifyEvent,
	dedupeWindowMs,
	envWebhookTarget,
	routeTargets,
} from './notify-routing'
import { sanitizeNotifyText } from './notify-text'
import { checkWebhookUrl, guardedPost } from './notify-url-guard'
import { type SafeText, redactSecrets, safeSlice } from './secret-text'

export type { NotifyEvent } from './notify-routing'
export { sanitizeNotifyText }

// Hold further app_down alerts for one app for this long.
const DOWN_COOLDOWN_MS = 15 * 60 * 1000
const WEBHOOK_TIMEOUT_MS = 5000

export interface NotifyPayload {
	app: string
	server: string
	/** Leaves powder (Discord, Slack, email, webhooks): must be masked. */
	message: SafeText
	/** Dashboard link; defaults to the container view. */
	url?: string
	/** app_repos.id, for app-filtered targets. Looked up from server+app when omitted. */
	appRepoId?: string | null
	/** Distinct occurrence id (the deploy id for deploy events). Part of the
	 *  dedupe key, so only true repeats of one occurrence are dropped. */
	instanceId?: string
}

export interface NotifyOptions {
	/** Dedupe window for this (event, server, app). Default: dedupeWindowMs(event). */
	dedupeMs?: number
}

const dedupe = new NotifyDedupe()

function containerUrl(server: string, app: string): string {
	return `${dashboardUrl()}/servers/${encodeURIComponent(server)}/${encodeURIComponent(app)}`
}

function detailUrl(repo: AppRepo): string {
	return `${dashboardUrl()}/servers/${repo.serverId}/${repo.containerName}`
}

interface Message {
	event: string
	app: string
	server: string
	message: string
	url: string
	at: string
}

function buildMessage(event: string, p: NotifyPayload): Message {
	return {
		event,
		app: sanitizeNotifyText(p.app),
		server: p.server,
		message: sanitizeNotifyText(p.message),
		url: p.url ?? containerUrl(p.server, p.app),
		at: new Date().toISOString(),
	}
}

async function postWebhook(target: string, body: Message, guarded: boolean): Promise<boolean> {
	if (guarded) {
		const check = await checkWebhookUrl(target)
		if (!check.ok) {
			console.warn('[notify] webhook target refused:', check.error)
			return false
		}
	}
	const line = `[${body.event}] ${body.app}: ${body.message}`.slice(0, 1900)
	const payload = JSON.stringify({
		...body,
		content: line,
		text: line,
		allowed_mentions: { parse: [] },
	})
	try {
		// Stored targets go through guardedPost: the connected address is checked
		// again (DNS rebinding) and redirects are never followed (SSRF past the
		// guard). The env webhook keeps fetch's default, as before targets existed.
		const status = guarded
			? await guardedPost(target, {
					headers: { 'content-type': 'application/json' },
					body: payload,
					timeoutMs: WEBHOOK_TIMEOUT_MS,
				})
			: (
					await fetch(target, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: payload,
						signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
					})
				).status
		if (status < 200 || status > 299) {
			console.warn('[notify] webhook failed:', status)
			return false
		}
		return true
	} catch (err) {
		console.warn('[notify] webhook threw:', err instanceof Error ? err.message : err)
		return false
	}
}

async function sendEmail(to: string, body: Message): Promise<boolean> {
	return sendMail({
		to,
		subject: `[powder] ${body.event}: ${body.app}`.slice(0, 200),
		text: `${body.message}\n\napp: ${body.app}\nserver: ${body.server}\n${body.url}\n${body.at}\n`,
	})
}

/** Send one message to one stored target. Never throws. */
async function deliver(t: NotificationTarget, body: Message): Promise<boolean> {
	try {
		if (t.kind === 'webhook' && t.urlEncrypted) {
			return await postWebhook(decryptSecret(t.urlEncrypted), body, true)
		}
		if (t.kind === 'email' && t.email) return await sendEmail(t.email, body)
		return false
	} catch (err) {
		console.warn(`[notify] target ${t.id} failed:`, err instanceof Error ? err.message : err)
		return false
	}
}

async function loadTargets(): Promise<NotificationTarget[]> {
	try {
		return await db.select().from(notificationTargets).where(eq(notificationTargets.enabled, true))
	} catch (err) {
		console.warn('[notify] could not load targets:', err instanceof Error ? err.message : err)
		return []
	}
}

async function resolveAppRepoId(p: NotifyPayload): Promise<string | null> {
	if (p.appRepoId !== undefined) return p.appRepoId
	try {
		const [row] = await db
			.select({ id: appRepos.id })
			.from(appRepos)
			.where(and(eq(appRepos.serverId, p.server), eq(appRepos.containerName, p.app)))
			.limit(1)
		return row?.id ?? null
	} catch {
		return null
	}
}

/**
 * Fan an event out to every matching target. Resolves with how many sends
 * succeeded; never rejects. A repeat of the same (event, server, app) inside
 * the dedupe window sends nothing (delivered 0, deduped true).
 */
export async function notify(
	event: NotifyEvent,
	payload: NotifyPayload,
	opts: NotifyOptions = {},
): Promise<{ delivered: number; deduped: boolean }> {
	try {
		const key = NotifyDedupe.key(event, payload.server, payload.app, payload.instanceId)
		if (!dedupe.claim(key, dedupeWindowMs(event, opts.dedupeMs)))
			return { delivered: 0, deduped: true }

		const body = buildMessage(event, payload)
		const sends: Promise<boolean>[] = []
		const env = envWebhookTarget()
		if (env?.events.includes(event)) sends.push(postWebhook(env.url, body, false))

		const all = await loadTargets()
		if (all.length > 0) {
			const needsApp = all.some((t) => t.appRepoId !== null)
			const appRepoId = needsApp ? await resolveAppRepoId(payload) : null
			for (const t of routeTargets(all, event, appRepoId)) sends.push(deliver(t, body))
		}

		const results = await Promise.allSettled(sends)
		const delivered = results.filter((r) => r.status === 'fulfilled' && r.value).length
		// Nothing got through: forget the claim so the next attempt is not swallowed.
		if (delivered === 0) dedupe.release(key)
		return { delivered, deduped: false }
	} catch (err) {
		console.warn('[notify] dispatch threw:', err instanceof Error ? err.message : err)
		return { delivered: 0, deduped: false }
	}
}

/** "send test" from the settings page: one message to one target, no dedupe,
 *  no event filter. Returns whether it got through. */
export async function sendTestNotification(t: NotificationTarget): Promise<boolean> {
	const body = buildMessage('test', {
		app: 'powder',
		server: '-',
		message: redactSecrets('test notification from powder. this target works.'),
		url: `${dashboardUrl()}/settings/notifications`,
	})
	return deliver(t, body)
}

// ── Typed helpers for the existing emit sites ─────────────────────────────────

export async function notifyDeployFailed(
	repo: AppRepo,
	opts: {
		deployId: string
		errorMessage: SafeText
		gitSha: string | null
		gitBranch: string | null
	},
): Promise<void> {
	const branch = opts.gitBranch ?? repo.branch
	const sha = opts.gitSha ? opts.gitSha.slice(0, 7) : 'unknown'
	await notify('deploy_failed', {
		app: repo.containerName,
		server: repo.serverId,
		appRepoId: repo.id ?? null,
		instanceId: opts.deployId,
		message: redactSecrets(
			`deploy failed (branch ${branch}, commit ${sha}): ${safeSlice(opts.errorMessage, 0, 500)}`,
		),
		url: detailUrl(repo),
	})
}

export async function notifyDeploySucceeded(
	repo: AppRepo,
	deployId: string,
	gitSha: string | null,
): Promise<void> {
	await notify('deploy_succeeded', {
		app: repo.containerName,
		server: repo.serverId,
		appRepoId: repo.id ?? null,
		instanceId: deployId,
		message: redactSecrets(
			`deployed ${gitSha ? gitSha.slice(0, 7) : 'unknown commit'} (branch ${repo.branch})`,
		),
		url: detailUrl(repo),
	})
}

export async function notifyAppDown(
	repo: AppRepo,
	check: AppUptimeCheck,
): Promise<{ notified: boolean }> {
	if (check.lastNotifiedAt && Date.now() - check.lastNotifiedAt.getTime() < DOWN_COOLDOWN_MS) {
		return { notified: false }
	}
	const status = check.lastStatusCode ? `${check.lastStatusCode}` : 'unreachable'
	const { delivered } = await notify('app_down', {
		app: repo.containerName,
		server: repo.serverId,
		appRepoId: repo.id ?? null,
		message: redactSecrets(`stopped responding at ${check.url} (last status: ${status})`),
		url: detailUrl(repo),
	})
	return { notified: delivered > 0 }
}

/** Recovery after an alerted outage. No cooldown: one per outage. */
export async function notifyAppUp(repo: AppRepo, url: string): Promise<{ notified: boolean }> {
	const { delivered } = await notify('app_up', {
		app: repo.containerName,
		server: repo.serverId,
		appRepoId: repo.id ?? null,
		message: redactSecrets(`is responding again at ${url}`),
		url: detailUrl(repo),
	})
	return { notified: delivered > 0 }
}
