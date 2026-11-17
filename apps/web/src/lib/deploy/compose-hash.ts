// Pure shell fragments for the compose-guard hash tripwire (see compose-check.ts).

import { shq } from '../shell'

/** every `docker compose ... config` powder runs on an app's compose (probe,
 *  hash, checks, the on-server guards, service and image listings) passes this global flag.
 *  Without it compose drops a service whose profile is inactive, while `up --no-deps
 *  <service>` still starts it by name, so the rules never saw it. `'*'` activates every
 *  profile (compose v2.20+, same output as without the flag for a compose with no
 *  profiles). powder's own self-deploy compose is not an app compose and keeps its calls. */
export const ALL_PROFILES = `--profile '*'`

/** Marker the script prints when the hash tripwire fires (rebuildDeploy retries once). */
export const COMPOSE_CHANGED_MARKER = '__POWDER_COMPOSE_CHANGED__'

/** the marker tagged with the run's random nonce, so build output cannot
 *  print it (the plain marker without a nonce). */
export function composeChangedMarkerFor(nonce = ''): string {
	const n = nonce.replace(/[^A-Za-z0-9]/g, '')
	return n ? `__POWDER_COMPOSE_CHANGED_${n}__` : COMPOSE_CHANGED_MARKER
}

/** Shell: the hash of the two config outputs (64 hex chars, or the hash of empty). */
export function composeConfigHashShell(cf: string): string {
	return `{ docker compose ${cf} ${ALL_PROFILES} config --format json 2>/dev/null; echo ---; docker compose ${cf} ${ALL_PROFILES} config --no-interpolate --format json 2>/dev/null; } | sha256sum | cut -c1-64`
}

/** Shell fragment (safe inside an && chain): the config hash moved since the check.
 *  enforce: refuse (and print the retry marker). warn: one greppable WARN line, go on. */
export function composeHashGuardShell(
	cf: string,
	expected: string,
	where: string,
	enforce = true,
	app = 'app',
	/** warn mode: stop with the marker so powder re-checks the new
	 *  config with the high-severity rules enforced. CG_RECHECK=1 tells the exit
	 *  trap to keep a builder-staged image for the second run. */
	recheck = false,
	/** the run's nonce for the marker (composeChangedMarkerFor). */
	nonce = '',
): string {
	const marker = composeChangedMarkerFor(nonce)
	if (!/^[0-9a-f]{64}$/.test(expected)) return 'true'
	const detail = `the resolved compose config changed ${where} (a repo file or a container changed what powder checked: tracked .env, env_file/include under the checkout, a bind-mounted compose file)`
	const onChange = enforce
		? `echo ${shq(`deploy: refusing, ${detail}. powder re-checks it once.`)}; echo ${shq(marker)}; exit 1; `
		: recheck
			? `echo ${shq(`[compose-guard] WARN ${app} config_changed ${detail}; powder re-checks it with the high-severity rules enforced`)}; CG_RECHECK=1; echo ${shq(marker)}; exit 1; `
			: `echo ${shq(`[compose-guard] WARN ${app} config_changed ${detail}`)}; `
	return `{ CG_H=$(${composeConfigHashShell(cf)}); if [ "$CG_H" != ${shq(expected)} ]; then ${onChange}fi; }`
}
