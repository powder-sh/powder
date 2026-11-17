import { randomBytes, timingSafeEqual } from 'node:crypto'
import { adminIdsConfigured, registerBootstrapAdmin } from './admin-ids'
import { asc, db, eq, sql, user as userTable } from './db'
import { RECREATE_HINT } from './recreate-hint'

// The env file powder reads (POWDER_ENV_FILE when the install moved it).
const powderEnvFile = (): string => process.env.POWDER_ENV_FILE || '/opt/apps/powder.env'

// First-run bootstrap. Signup does not exist: the only way a `user` row gets
// created through the auth layer is when the table is empty AND no admin ids are
// configured (POWDER_ADMIN_USER_IDS unset). That first login (GitHub) becomes the
// admin. Later admins are added with POST /api/admin/users.
//
// Setup token: on a fresh public install, whoever clicks "continue with
// github" first must not become admin, so the first-run create also needs
// the one-time setup token, which is printed ONLY to the server log
// ("[first-run] setup token: ..."). The operator enters it at /setup, which sets
// a short-lived httpOnly cookie (SETUP_COOKIE); user.create.before checks it.
// Installs with POWDER_ADMIN_USER_IDS set never reach this path (unchanged).

export const SETUP_COOKIE = 'powder_setup'
export const SETUP_COOKIE_MAX_AGE_SEC = 30 * 60

const t = globalThis as { __powderSetupToken?: string }

// One random token per process, generated on first use and logged once. A
// restart makes a new one (an old cookie then stops working, by design).
export function setupToken(): string {
	if (!t.__powderSetupToken) {
		t.__powderSetupToken = randomBytes(24).toString('base64url')
		console.log(
			`[first-run] setup token: ${t.__powderSetupToken} (open /setup on this powder, enter it, then continue with GitHub; the first login becomes admin)`,
		)
	}
	return t.__powderSetupToken
}

export function setupTokenMatches(candidate: string | null | undefined): boolean {
	if (!candidate) return false
	const a = Buffer.from(candidate)
	const b = Buffer.from(setupToken())
	return a.length === b.length && timingSafeEqual(a, b)
}

function cookieValue(cookieHeader: string | null | undefined, name: string): string | null {
	if (!cookieHeader) return null
	for (const part of cookieHeader.split(';')) {
		const i = part.indexOf('=')
		if (i < 0) continue
		if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
	}
	return null
}

function setupCookieValid(cookieHeader: string | null | undefined): boolean {
	return setupTokenMatches(cookieValue(cookieHeader, SETUP_COOKIE))
}

// True while nobody can be admin yet: no POWDER_ADMIN_USER_IDS and no user row.
export async function firstRunOpen(): Promise<boolean> {
	if (adminIdsConfigured()) return false
	return userTableIsEmpty()
}

// Boot hook (instrumentation.ts): print the token right away on a fresh install
// so the operator finds it at the top of the log. DB down: say so; the token is
// still printed the first time /setup is used.
export async function announceSetupTokenIfFirstRun(): Promise<void> {
	// eval: also with POWDER_ADMIN_USER_IDS set, so the stored first-run
	// admin is dropped once the env is persisted (restoreFirstRunAdmin deletes it).
	await restoreFirstRunAdmin()
	if (adminIdsConfigured()) return
	try {
		if (await userTableIsEmpty()) setupToken()
	} catch (err) {
		console.warn(
			'[first-run] could not check for a first run:',
			err instanceof Error ? err.message : err,
		)
	}
}

async function userTableIsEmpty(): Promise<boolean> {
	const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(userTable)
	return (row?.n ?? 0) === 0
}

// Claimed synchronously (before any await) so two concurrent first logins cannot
// both pass: only one caller gets true. Released if the table is non-empty.
// The claim holds the time it was taken. A claim whose user create then fails
// (better-auth aborts after the before-hook) is not released by that path, so a
// later attempt, once the in-flight window has passed, re-checks the table: still
// empty = the claim is released and retaken. Inside the window a second login is
// refused.
const g = globalThis as { __powderFirstRunClaimedAt?: number }
export const FIRST_RUN_CLAIM_WINDOW_MS = 30_000

// better-auth user.create.before: false aborts the creation. `cookieHeader` is
// the request's Cookie header; the first-run create needs a valid setup cookie.
export async function allowUserCreate(
	cookieHeader?: string | null,
	now: number = Date.now(),
): Promise<boolean> {
	if (adminIdsConfigured()) return false
	const claimedAt = g.__powderFirstRunClaimedAt
	if (claimedAt !== undefined && now - claimedAt < FIRST_RUN_CLAIM_WINDOW_MS) return false
	if (!setupCookieValid(cookieHeader)) {
		console.warn(
			'[first-run] refused creating a user without a valid setup token (first run: enter it at /setup; later users come from /admin/users)',
		)
		return false
	}
	g.__powderFirstRunClaimedAt = now
	try {
		const empty = await userTableIsEmpty()
		if (!empty) {
			g.__powderFirstRunClaimedAt = undefined
			return false
		}
		if (claimedAt !== undefined)
			console.warn('[first-run] an earlier first-run user create did not finish; claim released')
		// A fresh first run (the user table is empty again): an id stored by an
		// earlier one must not survive into this one.
		await clearFirstRunAdmin()
		return true
	} catch (err) {
		// DB error: release the claim so a retry can bootstrap, then surface it.
		g.__powderFirstRunClaimedAt = undefined
		throw err
	}
}

// Test hook: forget the claim.
export function resetFirstRunClaim(): void {
	g.__powderFirstRunClaimedAt = undefined
}

// Test hook: forget the setup token (the next setupToken() makes a new one).
export function resetSetupToken(): void {
	t.__powderSetupToken = undefined
}

// better-auth user.create.after for an allowed first-run user. Admin for this
// process immediately, but only if this user is the oldest row; the log line
// tells the owner what to persist.
export async function onFirstUserCreated(userId: string, email: string): Promise<void> {
	const [oldest] = await db
		.select({ id: userTable.id })
		.from(userTable)
		.orderBy(asc(userTable.createdAt))
		.limit(1)
	if (oldest && oldest.id !== userId) return
	registerBootstrapAdmin(userId)
	await persistFirstRunAdmin(userId)
	console.log(
		`[first-run] ${email} is the first user and the admin of this powder. Persist it: in the powder source dir run sudo bin/install.sh --set-admin ${userId} (or set POWDER_ADMIN_USER_IDS=${userId} in ${powderEnvFile()}, then recreate both containers; a plain restart does not re-read the env file: ${RECREATE_HINT})`,
	)
}

// the first-run admin also goes to powder_meta, so a restart before
// POWDER_ADMIN_USER_IDS is set does not lock the owner out. Honoured only while
// POWDER_ADMIN_USER_IDS is empty and the user row still exists; each boot that
// relies on it logs a WARN to set the env.
export const FIRST_RUN_ADMIN_META_KEY = 'first_run_admin'

async function persistFirstRunAdmin(userId: string): Promise<void> {
	try {
		await db.execute(
			sql`INSERT INTO powder_meta (key, value, updated_at) VALUES (${FIRST_RUN_ADMIN_META_KEY}, ${userId}, now()) ON CONFLICT (key) DO NOTHING`,
		)
	} catch (err) {
		console.warn(
			'[first-run] could not store the first-run admin id (set POWDER_ADMIN_USER_IDS before a restart):',
			err instanceof Error ? err.message : err,
		)
	}
}

/** Forget the stored first-run admin. Throws on a DB error. */
async function clearFirstRunAdmin(): Promise<void> {
	await db.execute(sql`DELETE FROM powder_meta WHERE key = ${FIRST_RUN_ADMIN_META_KEY}`)
}

/** Boot (web and worker): re-register the stored first-run admin when
 *  POWDER_ADMIN_USER_IDS is empty. Returns the id, or null. Never throws.
 *  With POWDER_ADMIN_USER_IDS set the stored id is deleted instead: the fallback
 *  only bridges the time until the env is persisted, so an admin the operator
 *  later removes from the env (or empties it to lock everyone out) is never
 *  brought back from the DB. A stored id whose user row is gone is deleted too. */
export async function restoreFirstRunAdmin(): Promise<string | null> {
	if (adminIdsConfigured()) {
		try {
			await clearFirstRunAdmin()
		} catch (err) {
			console.warn(
				'[first-run] could not delete the stored first-run admin:',
				err instanceof Error ? err.message : err,
			)
		}
		return null
	}
	try {
		const rows = (await db.execute(
			sql`SELECT value FROM powder_meta WHERE key = ${FIRST_RUN_ADMIN_META_KEY}`,
		)) as unknown as Array<{ value: string }>
		const id = rows[0]?.value
		if (!id) return null
		const [u] = await db
			.select({ id: userTable.id })
			.from(userTable)
			.where(eq(userTable.id, id))
			.limit(1)
		if (!u) {
			await clearFirstRunAdmin()
			return null
		}
		registerBootstrapAdmin(id)
		console.warn(
			`[first-run] WARN: POWDER_ADMIN_USER_IDS is empty; the admin is the first-run user ${id} stored in powder's DB. In the powder source dir run sudo bin/install.sh --set-admin ${id} (or set POWDER_ADMIN_USER_IDS=${id} in ${powderEnvFile()}, then ${RECREATE_HINT})`,
		)
		return id
	} catch (err) {
		console.warn(
			'[first-run] could not read the stored first-run admin:',
			err instanceof Error ? err.message : err,
		)
		return null
	}
}
