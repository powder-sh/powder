// the ONE authority over which registry login a docker command on a managed server
// uses. powder runs every remote command as the ssh user (often root, home /root),
// so the docker CLI read /root/.docker/config.json and sent root's registry
// login (if the server has one, e.g. ghcr.io) with every pull, push, run, create, compose and
// build (BuildKit's session auth, the classic builder's X-Registry-Config). An app's
// compose, Dockerfile or base image (an ONBUILD trigger in a `FROM` it does not own) could
// then make docker fetch a private image of another org. Rules per path could not close
// that, so the login itself is taken away:
//
//   - every ssh exec powder makes goes through `sshCommand()`, which puts
//     `NOCREDS_PREFIX` in front: DOCKER_AUTH_CONFIG unset and DOCKER_CONFIG pointing at a
//     powder-owned dir whose config.json has no logins (`{"auths":{},"credHelpers":{}}`).
//     Public images still pull anonymously; a private one fails closed.
//   - `withRegistryCreds()` is the ONLY producer of `DOCKER_CONFIG=/root/.docker`, for one
//     `docker push` / `docker pull` command, and only with an allowing decision from
//     deployPushDecision (deploy-push-policy.ts). Two callers: the rollback tag push
//     (tagDeployCommand) and the rollback target pull (rollbackTargetShell).
//
// Guard test: lib/__tests__/docker-creds-authority.test.ts.

import { type PushDecision, isIssuedPushDecision } from './deploy-push-policy'

/** The login-free docker config dir root's commands use. /run is root-only (tmpfs), so
 *  no app can plant it; a non-root ssh user gets one under its own HOME. */
export const NOCREDS_DIR = '/run/powder-docker-nocreds'
/** The config.json powder keeps in it. */
export const NOCREDS_CONFIG_JSON = '{"auths":{},"credHelpers":{}}'
/** Root's own docker config dir (registry logins). Used only by withRegistryCreds. */
const ROOT_DOCKER_CONFIG = '/root/.docker'

const REFUSE = (why: string) =>
	`{ echo "[powder] refusing to run: ${why} (docker must run without root's registry logins)" >&2; exit 97; }`

/** POSIX sh, put in front of every remote command. Exits 97 (the whole remote shell)
 *  when the dir or its config.json is a symlink, not powder's, or cannot be written. */
export const NOCREDS_PREFIX =
	'unset DOCKER_AUTH_CONFIG; ' +
	`if [ "$(id -u 2>/dev/null)" = 0 ]; then __pdc=${NOCREDS_DIR}; else __pdc="$HOME/.powder-docker-nocreds"; fi; ` +
	`mkdir -p "$__pdc" 2>/dev/null; ` +
	`if [ -L "$__pdc" ] || [ ! -d "$__pdc" ] || [ ! -O "$__pdc" ] || [ -L "$__pdc/config.json" ] || { [ -e "$__pdc/config.json" ] && [ ! -f "$__pdc/config.json" ]; }; then ${REFUSE('$__pdc is a symlink, not a directory of the ssh user, or its config.json is not a regular file')}; fi; ` +
	`chmod 0755 "$__pdc" 2>/dev/null; ` +
	`if [ "$(cat "$__pdc/config.json" 2>/dev/null)" != '${NOCREDS_CONFIG_JSON}' ]; then printf '%s' '${NOCREDS_CONFIG_JSON}' > "$__pdc/.config.json.$$" && chmod 0644 "$__pdc/.config.json.$$" && mv -f "$__pdc/.config.json.$$" "$__pdc/config.json" || ${REFUSE('cannot write $__pdc/config.json')}; fi; ` +
	`export DOCKER_CONFIG="$__pdc"; unset __pdc; `

/** Every command powder runs over ssh (runCommand, the log stream, the builder's image
 *  stream) is wrapped here. Nothing is exempt; a command that needs a login carries it
 *  inside via withRegistryCreds. */
export function sshCommand(command: string): string {
	return NOCREDS_PREFIX + command
}

/** The only way a docker command gets root's registry login: one `docker push <ref>` or
 *  `docker pull <ref>`, with a decision deployPushDecision issued and that allows it.
 *  Throws on anything else, so a boolean literal or a hand-made object cannot grant it. */
export function withRegistryCreds(command: string, decision: PushDecision): string {
	if (!isIssuedPushDecision(decision) || decision.allow !== true)
		throw new Error('withRegistryCreds: needs an allowing decision from deployPushDecision')
	if (!/^docker (push|pull) '[A-Za-z0-9._\-:/@]+'$/.test(command))
		throw new Error(`withRegistryCreds: only a single docker push/pull of a quoted ref (got ${command.slice(0, 80)})`)
	return `DOCKER_CONFIG=${ROOT_DOCKER_CONFIG} ${command}`
}
