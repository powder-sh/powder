// In-memory sliding-window rate limiter. Buckets keyed by string. Each call
// records `now` into the key's array, evicts entries older than windowMs, and
// returns whether we're at limit. Single-process only (resets on restart) —
// acceptable for the closed-beta single-pod deploy. Move to a postgres-backed
// limiter when we scale to multiple powder pods.

const buckets = new Map<string, number[]>()

// The web process may not run the scheduler that calls
// pruneRateLimitBuckets, and keys can be attacker-chosen, so the map is bounded
// here: past MAX_KEYS, prune stale buckets and then evict oldest-inserted keys.
const MAX_KEYS = 10_000

export function rateLimitBucketCount(): number {
	return buckets.size
}

function enforceKeyCap(): void {
	if (buckets.size <= MAX_KEYS) return
	pruneRateLimitBuckets()
	// Evict down to 90% so the O(n) prune above runs once per ~1000 inserts.
	const target = Math.floor(MAX_KEYS * 0.9)
	for (const k of buckets.keys()) {
		if (buckets.size <= target) break
		buckets.delete(k)
	}
}

export function checkRateLimit(
	key: string,
	limit: number,
	windowMs: number,
): { ok: boolean; remaining: number; retryAfterMs: number } {
	const now = Date.now()
	const cutoff = now - windowMs
	const arr = (buckets.get(key) ?? []).filter((t) => t >= cutoff)
	if (arr.length >= limit) {
		const oldest = arr[0] ?? now
		return { ok: false, remaining: 0, retryAfterMs: oldest + windowMs - now }
	}
	arr.push(now)
	buckets.delete(key) // re-insert so Map order tracks recency
	buckets.set(key, arr)
	enforceKeyCap()
	return { ok: true, remaining: limit - arr.length, retryAfterMs: 0 }
}

// Periodic cleanup — buckets older than the longest window we use stick
// around forever otherwise. Called from cron-scheduler.ts.
export function pruneRateLimitBuckets(maxAgeMs = 600_000): void {
	const cutoff = Date.now() - maxAgeMs
	for (const [k, arr] of buckets.entries()) {
		const fresh = arr.filter((t) => t >= cutoff)
		if (fresh.length === 0) buckets.delete(k)
		else buckets.set(k, fresh)
	}
}
