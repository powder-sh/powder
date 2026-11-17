// Uptime checker: pings every uptime-enabled app every UPTIME_TICK_MS, records
// status, and triggers a notification on UP→DOWN transition. Runs as part of
// the in-process scheduler in cron-scheduler.ts (which defines UPTIME_TICK_MS).
//
// URL resolution (first match wins):
//   1. app_repos.health_url: absolute URL as-is; a path ("/api/health") is
//      joined with the live hostname, else the server default host
//   2. first app_domains row with status='live' (preview rows excluded) — hits
//      the user-facing hostname end-to-end through nginx/Traefik
//   3. "https://<container>.<servers.base_domain>/" - fallback for apps that
//      haven't attached a custom domain yet. A server with no base domain has
//      no fallback: the app is skipped until it has health_url or a live domain.
//
// Opt-in via app_repos.uptime_enabled. Default false so adding apps doesn't
// auto-page; the 0028 migration enables it for every app of the hosted Traefik server to preserve
// the previous behavior.

import { and, appDomains, appRepos, appUptimeChecks, db, eq, inArray, isNull } from './db'
import type { AppRepo } from './db'
import { defaultHostFor, firstLiveHostByRepo } from './app-hosts'
import type { HostServer } from './app-hosts'
import { notifyAppDown, notifyAppUp } from './notifications'
import { guardedAppFetch } from './notify-url-guard'
import { listAllServers } from './servers'

const PING_TIMEOUT_MS = 10_000
const FAIL_THRESHOLD = 2 // need N consecutive failures before flipping is_up=false

export async function uptimeTick(): Promise<void> {
	const repos = await db.select().from(appRepos).where(eq(appRepos.uptimeEnabled, true))

	if (repos.length === 0) return

	// Load existing checks for these app_repos in one query.
	const existingChecks = await db
		.select()
		.from(appUptimeChecks)
		.where(
			inArray(
				appUptimeChecks.appRepoId,
				repos.map((r) => r.id),
			),
		)
	const checkByRepoId = new Map(existingChecks.map((c) => [c.appRepoId, c]))

	// Preload live parent-app domains (one query, not N) for fallback URL lookup.
	const liveDomains = await db
		.select({
			appRepoId: appDomains.appRepoId,
			hostname: appDomains.hostname,
			createdAt: appDomains.createdAt,
		})
		.from(appDomains)
		.where(
			and(
				inArray(
					appDomains.appRepoId,
					repos.map((r) => r.id),
				),
				eq(appDomains.status, 'live'),
				isNull(appDomains.previewDeployId),
			),
		)
	// Same pick as http crons (cron-scheduler resolveAppUrl): oldest live domain.
	const liveHostnameByRepoId = firstLiveHostByRepo(liveDomains)

	const serverById = new Map((await listAllServers()).map((s) => [s.id, s]))

	await Promise.all(
		repos.map((repo) =>
			checkOne(
				repo,
				checkByRepoId.get(repo.id) ?? null,
				liveHostnameByRepoId.get(repo.id) ?? null,
				serverById.get(repo.serverId),
			),
		),
	)
}

export function resolveUrl(
	repo: Pick<AppRepo, 'containerName' | 'healthUrl'>,
	liveHostname: string | null,
	server?: HostServer,
): string | null {
	const host = liveHostname ?? (server ? defaultHostFor(server, repo.containerName) : null)
	const raw = repo.healthUrl?.trim()
	if (raw) {
		// Absolute http(s) URL: used as-is. Anything else is a PATH (the deploy
		// health gate uses health_url as a path against the container).
		if (/^https?:\/\/[^/\s]/i.test(raw)) return raw
		if (!host) return null
		return `https://${host}${raw.startsWith('/') ? raw : `/${raw}`}`
	}
	return host ? `https://${host}/` : null
}

const warnedNoUrl = new Set<string>()
/** apps whose uptime target was refused as a private address (EBLOCKED), logged
 *  once until the app answers again. */
const warnedBlocked = new Set<string>()

/** True when the probe failed because the target resolves to (or is) a loopback,
 *  link-local or private address (notify-url-guard EBLOCKED). Pure. */
export function isBlockedTargetError(err: unknown): boolean {
	const e = err as { code?: unknown; cause?: { code?: unknown } } | null
	return e?.code === 'EBLOCKED' || e?.cause?.code === 'EBLOCKED'
}

/** An outage still needs its alert: the app is down and no notification has gone
 *  out since this outage began. Retried every tick, so a failed webhook or a
 *  cooldown suppression on the transition tick is not lost. Pure. */
export function needsDownNotice(c: {
	isUp: boolean
	lastDownAt: Date | null
	lastNotifiedAt: Date | null
}): boolean {
	if (c.isUp) return false
	if (!c.lastNotifiedAt) return true
	return c.lastDownAt !== null && c.lastNotifiedAt.getTime() < c.lastDownAt.getTime()
}

/** Recovery of an outage we already alerted on: was down, told about it (a
 *  notification at or after the outage began), and is up now. Pure. */
export function needsUpNotice(
	prev: { isUp: boolean; lastDownAt: Date | null; lastNotifiedAt: Date | null } | null,
	isUp: boolean,
): boolean {
	if (!prev || prev.isUp || !isUp) return false
	if (!prev.lastNotifiedAt || !prev.lastDownAt) return false
	return prev.lastNotifiedAt.getTime() >= prev.lastDownAt.getTime()
}

async function checkOne(
	repo: AppRepo,
	prev: typeof appUptimeChecks.$inferSelect | null,
	liveHostname: string | null,
	server?: HostServer,
): Promise<void> {
	const url = resolveUrl(repo, liveHostname, server)
	if (!url) {
		if (!warnedNoUrl.has(repo.id)) {
			warnedNoUrl.add(repo.id)
			console.warn(
				`[uptime ${repo.containerName}] skipped: no health_url, no live domain and no base domain on ${repo.serverId}; set a health URL on the app's Settings tab or add a custom domain`,
			)
		}
		return
	}
	const now = new Date()
	let status: number | null = null
	let ok = false
	try {
		const ctrl = new AbortController()
		const t = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS)
		// connect-time check against loopback, link-local and private addresses.
		const res = await guardedAppFetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal })
		clearTimeout(t)
		await res.body?.cancel().catch(() => {})
		status = res.status
		// 2xx and 3xx both count as "responding". 5xx, network errors → down.
		ok = res.status < 500
		warnedBlocked.delete(repo.id)
	} catch (err) {
		ok = false
		if (isBlockedTargetError(err) && !warnedBlocked.has(repo.id)) {
			warnedBlocked.add(repo.id)
			console.warn(
				`[uptime ${repo.containerName}] ${url} resolves to a loopback, link-local or private address; powder does not probe those (Tailscale 100.64/10 and fd7a:115c:a1e0::/48 are allowed). The app counts as down until its health_url or domain points at a public or Tailscale address.`,
			)
		}
	}

	const consecutiveFailures = ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1
	const isUp = consecutiveFailures < FAIL_THRESHOLD

	if (!prev) {
		await db.insert(appUptimeChecks).values({
			appRepoId: repo.id,
			url,
			lastCheckedAt: now,
			lastStatusCode: status,
			isUp,
			consecutiveFailures,
			lastDownAt: isUp ? null : now,
			lastNotifiedAt: null,
		})
	} else {
		await db
			.update(appUptimeChecks)
			.set({
				url,
				lastCheckedAt: now,
				lastStatusCode: status,
				isUp,
				consecutiveFailures,
				// Recovery ends the outage: the next one starts a fresh lastDownAt.
				lastDownAt: isUp ? null : (prev.lastDownAt ?? now),
			})
			.where(eq(appUptimeChecks.appRepoId, repo.id))
		if (needsUpNotice(prev, isUp)) {
			await notifyAppUp(repo, url).catch((err) =>
				console.error(`[uptime ${repo.containerName}] recovery notify failed:`, err),
			)
		}
	}

	// Down and not yet told about THIS outage: notify (cooldown enforced inside
	// notifyAppDown; a miss is retried on the next tick).
	if (!isUp) {
		const refreshed = await db
			.select()
			.from(appUptimeChecks)
			.where(eq(appUptimeChecks.appRepoId, repo.id))
			.then((rows) => rows[0])
		if (!refreshed || !needsDownNotice(refreshed)) return
		const result = await notifyAppDown(repo, refreshed).catch((err) => {
			console.error(`[uptime ${repo.containerName}] notify failed:`, err)
			return { notified: false }
		})
		if (result.notified) {
			await db
				.update(appUptimeChecks)
				.set({ lastNotifiedAt: now })
				.where(eq(appUptimeChecks.appRepoId, repo.id))
		}
	}
}
