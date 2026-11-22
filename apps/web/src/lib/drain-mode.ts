// POWDER_DRAIN (powder.env): whether a bridged deploy stops the old container itself,
// after refusing its new connections and letting its requests finish (deploy/fragments.ts
// drainShellFunctions), and whether powder renders the `<app>-retry` Traefik middleware
// that the Traefik drain needs.
//   off (default, also unset or anything else): nothing of the drain is rendered; the
//     deploy script and the Traefik labels are exactly what they were before the drain.
//   canary: only the apps named in POWDER_DRAIN_APPS (comma list of container names).
//   on: every app.
// Read where the script and the labels are rendered (worker and web), so both sides of
// one app always agree.

export type DrainMode = 'off' | 'canary' | 'on'

export function drainModeFrom(env: Record<string, string | undefined> = process.env): DrainMode {
	const v = (env.POWDER_DRAIN ?? '').trim().toLowerCase()
	return v === 'on' || v === 'canary' ? v : 'off'
}

/** Is the drain on for this app (container name)? */
export function drainActiveFor(app: string, env: Record<string, string | undefined> = process.env): boolean {
	const mode = drainModeFrom(env)
	if (mode === 'on') return true
	if (mode !== 'canary') return false
	return (env.POWDER_DRAIN_APPS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.includes(app)
}
