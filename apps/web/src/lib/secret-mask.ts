// runtime env values leave the server masked by default. Full values need
// an explicit `?reveal=1` AND an admin browser session (never a bearer token,
// scoped or not), so a leaked read-only token cannot read secrets.

import type { CurrentUser } from './access'
import { SECRET_NAME_RE, maskValue } from './secret-text'
import { selfDeployNames } from './compose-safety'

export { maskValue }

export function maskEntries<T extends { key: string; value: string }>(entries: T[]): T[] {
	return entries.map((e) => ({ ...e, value: maskValue(e.value) }))
}

export function revealRequested(req: Request): boolean {
	return new URL(req.url).searchParams.get('reveal') === '1'
}

/** `?reveal=1&key=NAME`: reveal one entry only (the per-key eye toggle). */
export function revealKey(req: Request): string | null {
	return new URL(req.url).searchParams.get('key') || null
}

/** Entries for a response: all masked unless revealed; with a key, only that one is revealed. */
export function revealView<T extends { key: string; value: string }>(
	entries: T[],
	reveal: boolean,
	key: string | null,
): T[] {
	if (!reveal) return maskEntries(entries)
	if (key === null) return entries
	return entries.map((e) => (e.key === key ? e : { ...e, value: maskValue(e.value) }))
}

/** 404 for powder's own containers (their env holds POWDER_ENCRYPTION_KEY,
 *  BETTER_AUTH_SECRET, DATABASE_URL): never served by a container env route. */
export function powderSelfDenied(name: string): Response | null {
	return isPowderSelfContainer(name)
		? Response.json({ error: 'unknown container' }, { status: 404 })
		: null
}

export function canReveal(user: Pick<CurrentUser, 'isAdmin' | 'viaToken'>): boolean {
	return user.isAdmin === true && user.viaToken !== true
}

// Returns a 403 Response when reveal was asked for but is not allowed.
export function revealDenied(
	req: Request,
	user: Pick<CurrentUser, 'isAdmin' | 'viaToken'>,
): Response | null {
	if (revealRequested(req) && !canReveal(user)) {
		return Response.json({ error: 'reveal needs an admin session' }, { status: 403 })
	}
	return null
}

/** strip the password from a connection URL unless revealed. Parsed with
 *  `new URL()` (not a regex: `@` or `:` inside a password, `?password=` query params and
 *  `host=... password=...` DSNs all slip past a pattern). The userinfo
 *  password and every sensitive query parameter become `****`. Anything that does not
 *  parse as a URL (DSN keyword form, garbage) is masked entirely.
 *  a username with no password (`redis://<token>@host`) is masked too: there
 *  the userinfo IS the credential. */
export function maskUrlPassword(url: string | null): string | null {
	if (url == null) return null
	let u: URL
	try {
		u = new URL(url.trim())
	} catch {
		return '****'
	}
	if (!u.host && !u.pathname) return '****'
	if (u.password) u.password = '****'
	else if (u.username) u.username = '****'
	for (const k of [...new Set([...u.searchParams.keys()])]) {
		if (SECRET_NAME_RE.test(k)) u.searchParams.set(k, '****')
	}
	return u.toString()
}

/** powder's own containers: never listed by the env-vars API, never restarted, rolled
 *  back, redeployed or read (logs) through a container route. Keyed on
 *  selfDeployNames (POWDER_SELF_CONTAINER, default `powder`) and its `-worker`, plus the
 *  stock compose names `powder` / `powder-worker`. */
export function isPowderSelfContainer(name: string, env: Record<string, string | undefined> = process.env): boolean {
	return powderSelfContainerNames(env).includes(name)
}

/** The names isPowderSelfContainer matches, for SQL filters (`NOT IN`). */
export function powderSelfContainerNames(env: Record<string, string | undefined> = process.env): string[] {
	const c = selfDeployNames(env).container
	return [...new Set(['powder', 'powder-worker', c, `${c}-worker`])]
}
