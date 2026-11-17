// Daily "is a newer powder out?" check against the public GitHub releases API.
//
// Sends nothing but a User-Agent naming the running version: no instance id,
// no hostname, no user data. Result is cached in memory and in the powder_meta
// table (key 'update_check') so restarts and the web/worker split share it.
// Off with POWDER_UPDATE_CHECK=off. Never throws.

import { db, eq, powderMeta } from './db'

const RELEASES_API = 'https://api.github.com/repos/powder-sh/powder/releases/latest'
const RELEASES_URL_PREFIX = 'https://github.com/powder-sh/powder/'
export const UPGRADE_DOCS_PATH = '/docs/upgrading'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5_000
const META_KEY = 'update_check'

export interface UpdateRecord {
	latest: string
	checked_at: string
	url?: string
}

export interface UpdateStatus {
	current: string
	latest: string
	url: string
}

export interface MetaStore {
	read(): Promise<UpdateRecord | null>
	write(rec: UpdateRecord): Promise<void>
}

function runningVersion(): string {
	return process.env.NEXT_PUBLIC_POWDER_VERSION ?? '0.0.0'
}

function updateCheckEnabled(): boolean {
	return (process.env.POWDER_UPDATE_CHECK ?? '').trim().toLowerCase() !== 'off'
}

function parseSemver(v: string): [number, number, number] | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim())
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** True when `latest` is a strictly higher x.y.z than `current`. Unparseable input is never newer. */
export function isNewer(latest: string, current: string): boolean {
	const a = parseSemver(latest)
	const b = parseSemver(current)
	if (!a || !b) return false
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] > b[i]
	}
	return false
}

const dbStore: MetaStore = {
	async read() {
		const [row] = await db.select().from(powderMeta).where(eq(powderMeta.key, META_KEY)).limit(1)
		return row ? (JSON.parse(row.value) as UpdateRecord) : null
	},
	async write(rec) {
		const value = JSON.stringify(rec)
		await db
			.insert(powderMeta)
			.values({ key: META_KEY, value })
			.onConflictDoUpdate({ target: powderMeta.key, set: { value, updatedAt: new Date() } })
	},
}

let memo: UpdateRecord | null = null
// A failed fetch is not retried for an hour, so an offline server does not wait
// on the 5 s timeout during every page render.
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000
let lastFailureAt = 0
let inflight: Promise<UpdateRecord | null> | null = null

/** Test hook: clear the in-memory cache. */
export function resetUpdateCheckCache(): void {
	memo = null
	inflight = null
	lastFailureAt = 0
}

function fresh(rec: UpdateRecord | null, now: number): rec is UpdateRecord {
	if (!rec) return false
	const t = Date.parse(rec.checked_at)
	return Number.isFinite(t) && now - t < CHECK_INTERVAL_MS && now >= t
}

async function fetchLatest(fetchFn: typeof fetch, current: string): Promise<{ latest: string; url?: string } | null> {
	const res = await fetchFn(RELEASES_API, {
		headers: { 'User-Agent': `powder/${current}`, Accept: 'application/vnd.github+json' },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})
	if (!res.ok) return null
	const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
	if (typeof body.tag_name !== 'string' || !parseSemver(body.tag_name)) return null
	const url =
		typeof body.html_url === 'string' && body.html_url.startsWith(RELEASES_URL_PREFIX) ? body.html_url : undefined
	return { latest: body.tag_name.replace(/^v/, ''), url }
}

/**
 * Returns the cached record, refreshing it at most once per 24 h. Never throws;
 * null when disabled or nothing is known yet.
 */
export async function checkForUpdate(
	opts: { fetchFn?: typeof fetch; store?: MetaStore; now?: number } = {},
): Promise<UpdateRecord | null> {
	try {
		if (!updateCheckEnabled()) return null
		const fetchFn = opts.fetchFn ?? fetch
		const store = opts.store ?? dbStore
		const now = opts.now ?? Date.now()
		if (fresh(memo, now)) return memo
		let stored: UpdateRecord | null = null
		try {
			stored = await store.read()
		} catch {
			stored = null
		}
		if (fresh(stored, now)) {
			memo = stored
			return stored
		}
		// Stale-while-revalidate: a record that merely aged out is returned at once and
		// refreshed in the background, so a page render never waits on GitHub. Only a
		// cold start (nothing known yet) awaits the first fetch.
		const known = stored ?? memo
		if (inflight) return known ?? (await inflight)
		if (lastFailureAt && now - lastFailureAt < RETRY_AFTER_FAILURE_MS) return known
		const refresh = (async () => {
			try {
				const found = await fetchLatest(fetchFn, runningVersion())
				if (!found) {
					lastFailureAt = now
					return known
				}
				const rec: UpdateRecord = { ...found, checked_at: new Date(now).toISOString() }
				memo = rec
				try {
					await store.write(rec)
				} catch {
					// cache write is best effort
				}
				return rec
			} catch {
				// Network error or timeout: keep the last known value, retry after the backoff.
				lastFailureAt = now
				return known
			} finally {
				inflight = null
			}
		})()
		inflight = refresh
		return known ?? (await refresh)
	} catch {
		return null
	}
}

/** The banner data: set only when a newer release is known. Safe to call per render. */
export async function getUpdateStatus(): Promise<UpdateStatus | null> {
	const rec = await checkForUpdate()
	const current = runningVersion()
	if (!rec || !isNewer(rec.latest, current)) return null
	return { current, latest: rec.latest, url: rec.url ?? `${RELEASES_URL_PREFIX}releases/tag/v${rec.latest}` }
}
