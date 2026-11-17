import { sessionOnlyActionDenied } from './session-only'

// an exec cron runs a command of the caller's choice inside the app container
// (docker exec, as the container's user, with its env and network). An API token
// (scoped or not) must not get that: creating an exec cron, editing a cron into or as
// an exec cron, importing a host line as one and running one now need an admin BROWSER
// session. The rule lives in the session-only registry (lib/session-only.ts,
// action `exec_cron`, next to `cron_bearer_env`); routes use cronSessionOnlyDenied.

/** 403 when `kind` is exec and the caller is not an admin browser session, else null. */
export function execCronDenied(kind: string | null | undefined, user: { isAdmin: boolean; viaToken?: boolean }): Response | null {
	if (kind !== 'exec') return null
	return sessionOnlyActionDenied('exec_cron', user)
}
