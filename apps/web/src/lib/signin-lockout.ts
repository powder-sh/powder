// Per-email sign-in failure lockout, on top of better-auth's per-IP limiter
// (which a client can sidestep when it controls the trusted IP header, see
// lib/client-ip.ts). In memory: powder's dashboard is one process, and a
// restart resetting the counters is acceptable for a backstop.
//
// MAX_FAILURES failed email sign-ins for one address inside WINDOW_MS lock that
// address for LOCK_MS, whatever the password (a correct one too). A success
// clears the counter. Trade-off: someone who knows the email can keep the
// email login locked; GitHub sign-in is not affected and the lock ends by itself.

import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api'

const SIGNIN_MAX_FAILURES = 10
const SIGNIN_WINDOW_MS = 15 * 60 * 1000
const SIGNIN_LOCK_MS = 15 * 60 * 1000
const MAX_TRACKED = 10_000

interface Entry {
	failures: number[]
	lockedUntil: number
}

export class SigninLockout {
	private readonly m = new Map<string, Entry>()

	constructor(
		private readonly max = SIGNIN_MAX_FAILURES,
		private readonly windowMs = SIGNIN_WINDOW_MS,
		private readonly lockMs = SIGNIN_LOCK_MS,
		private readonly maxTracked = MAX_TRACKED,
	) {}

	private key(email: string): string {
		return email.trim().toLowerCase()
	}

	/** Milliseconds left on the lock, 0 when sign-in may proceed. */
	lockedFor(email: string, now = Date.now()): number {
		const e = this.m.get(this.key(email))
		return e && e.lockedUntil > now ? e.lockedUntil - now : 0
	}

	recordFailure(email: string, now = Date.now()): void {
		const k = this.key(email)
		let e = this.m.get(k)
		if (!e) {
			// bound memory against random-email floods WITHOUT evicting a lock or
			// a recent failure count (evicting the oldest entries let a flood of new
			// addresses unlock a locked one). When full, first drop entries that hold
			// nothing (lock over, no failure inside the window).
			// if still full, evict the unlocked entry with the fewest failures
			// inside the window (oldest first on a tie) instead of not tracking the new
			// address: refusing to track let a flood of fresh addresses exempt a target
			// from the lockout. A flood's one-failure entries churn among themselves, and
			// a target's count survives unless the flood spends as many failures per
			// address. Only when every entry is locked is the new address not tracked.
			if (this.m.size >= this.maxTracked) this.sweep(now)
			if (this.m.size >= this.maxTracked && !this.evictWeakest(now)) return
			e = { failures: [], lockedUntil: 0 }
			this.m.set(k, e)
		}
		e.failures = e.failures.filter((t) => now - t < this.windowMs)
		e.failures.push(now)
		if (e.failures.length >= this.max) {
			e.lockedUntil = now + this.lockMs
			e.failures = []
		}
	}

	/** Drop entries that are neither locked nor carry a failure inside the window. */
	private sweep(now: number): void {
		for (const [k, e] of this.m) {
			if (e.lockedUntil > now) continue
			if (e.failures.some((t) => now - t < this.windowMs)) continue
			this.m.delete(k)
		}
	}

	/** Drop the unlocked entry with the fewest in-window failures (insertion order
	 *  breaks ties, so the oldest goes). False when every entry is locked. */
	private evictWeakest(now: number): boolean {
		let victim: string | null = null
		let fewest = Number.POSITIVE_INFINITY
		for (const [k, e] of this.m) {
			if (e.lockedUntil > now) continue
			const n = e.failures.filter((t) => now - t < this.windowMs).length
			if (n < fewest) {
				fewest = n
				victim = k
				if (n <= 1) break
			}
		}
		if (victim === null) return false
		this.m.delete(victim)
		return true
	}

	/** Tracked addresses (tests). */
	get size(): number {
		return this.m.size
	}

	recordSuccess(email: string): void {
		this.m.delete(this.key(email))
	}
}

const signinLockout = new SigninLockout()

function emailOf(body: unknown): string {
	const e = (body as { email?: unknown } | undefined)?.email
	return typeof e === 'string' ? e : ''
}

/** better-auth `hooks` for /sign-in/email: refuse while locked (429), count a
 *  401 as a failure, clear on success. */
export function signinLockoutHooks(lock: SigninLockout = signinLockout) {
	return {
		before: createAuthMiddleware(async (ctx) => {
			if (ctx.path !== '/sign-in/email') return
			const email = emailOf(ctx.body)
			if (email && lock.lockedFor(email) > 0) {
				throw new APIError('TOO_MANY_REQUESTS', {
					message: 'too many failed sign-ins for this account, try again later',
				})
			}
		}),
		after: createAuthMiddleware(async (ctx) => {
			if (ctx.path !== '/sign-in/email') return
			const email = emailOf(ctx.body)
			if (!email) return
			const r = ctx.context.returned
			if (isAPIError(r)) {
				if (r.statusCode === 401) lock.recordFailure(email)
			} else if (r !== undefined) {
				lock.recordSuccess(email)
			}
		}),
	}
}
