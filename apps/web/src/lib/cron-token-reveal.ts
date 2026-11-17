// the per-app cron token (POWDER_CRON_TOKEN) is shown in a create / import
// answer only once: when that very call minted it, and only to an admin browser
// session (a bearer token never sees it). Every other answer says only that the app
// has one. Pure, no DB.

export type CronTokenState = { value: string; minted: boolean } | null

export function cronTokenField(
	token: CronTokenState,
	user: { isAdmin: boolean; viaToken?: boolean },
): { cronToken: string } | { cronTokenSet: true } | Record<string, never> {
	if (!token) return {}
	if (token.minted && user.isAdmin === true && user.viaToken !== true) return { cronToken: token.value }
	return { cronTokenSet: true }
}
