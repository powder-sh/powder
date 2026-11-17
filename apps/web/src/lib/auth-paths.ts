// better-auth endpoints powder's UI does not call. better-auth answers them with
// 404 (disabledPaths, exact match on the path under /api/auth). What the UI and
// the server use, and so stays on: /get-session (useSession, the swap check),
// /sign-in/email and /sign-in/social (login form, GitHub connect),
// /callback/:id (the GitHub OAuth callback), /sign-out, /error (OAuth error
// redirect) and /ok, plus /change-password (current password required): no
// page calls it yet, but the temp-password notice of POST /api/admin/users
// tells a new user they can change it. Users are managed in /admin/users (POST, DELETE
// /api/admin/users), never through these.
export const AUTH_DISABLED_PATHS = [
	'/sign-up/email',
	'/list-sessions',
	'/revoke-session',
	'/revoke-sessions',
	'/revoke-other-sessions',
	'/update-session',
	'/update-user',
	'/change-email',
	'/verify-password',
	'/delete-user',
	'/delete-user/callback',
	'/link-social',
	'/unlink-account',
	'/list-accounts',
	'/account-info',
	'/get-access-token',
	'/refresh-token',
	'/request-password-reset',
	'/reset-password',
	'/send-verification-email',
	'/verify-email',
] as const

/** Paths the route answers 404 before better-auth: signup (any /sign-up/*), and
 *  /reset-password/:token, which disabledPaths cannot list (exact match only). */
export function isRemovedAuthPath(pathname: string): boolean {
	return pathname.startsWith('/api/auth/sign-up') || pathname.startsWith('/api/auth/reset-password/')
}
