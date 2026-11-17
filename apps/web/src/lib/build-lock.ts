// The server build lock: every build on a server takes it with flock, so a server never
// runs two builds at once. The dedicated builder takes one of its slot locks
// `<lock>.<i>` instead (lib/builder.ts). bin/install.sh and bin/self-deploy.sh
// (run as root) use the same root path (a test keeps them in sync).
//
// /run is root-owned (0755), so no other local user can create the file or plant
// a link there first, as they could in /tmp. A non-root ssh user (servers.sshUser)
// cannot create files in /run: it takes a lock under its own HOME instead
// (USER_BUILD_LOCK), refused when that path is a symlink, like the docker config dir
// fallback in docker-env.ts. Such a user's builds therefore lock under its $HOME and do
// NOT serialise against the root-run locks under /run (bin/install.sh, bin/self-deploy.sh
// and the builds of a root ssh user on the same server): two builds can run at once
// there. The docs require root SSH on every managed server for this reason among others.
//
// bin/install.sh and bin/self-deploy.sh also take /tmp/powder-build.lock when it is a
// regular root-owned file: a build holding that path is not serialised by the /run
// lock, so an upgrade that starts during such a build waits for it instead of running
// a second build next to it. Deploy scripts rendered here never take the /tmp path:
// they run only once the upgraded powder is up, and both upgrade scripts wait for
// in-flight deploys before they recreate powder.
export const BUILD_LOCK = '/run/powder-build.lock'
/** The lock of a non-root ssh user (shell text, expanded on the server). */
export const USER_BUILD_LOCK = '$HOME/.powder-build.lock'

/** Shell word (double-quoted command substitution) for a lock or state file on a
 *  server: `rootPath` as root (under /run or /var/lib, which only root can write),
 *  else `userPath` (shell text under $HOME, expanded on the server). When the user
 *  path is a symlink it prints a refusal to stderr and yields an empty path, so
 *  opening or locking it fails. The one choice for every lock and state file powder
 *  keeps on a server (the build lock here, the builder cap prune in builder-prune.ts);
 *  never a fixed name under /tmp, where any local user could create it or plant a
 *  link first. No single quotes: callers embed it in larger shell text. */
export function rootOrHomePathShell(rootPath: string, userPath: string, tag: string): string {
	return (
		`"$(if [ "$(id -u 2>/dev/null)" = 0 ]; then printf %s "${rootPath}"; ` +
		`elif [ -L "${userPath}" ]; then echo "[${tag}] refusing: ${userPath} is a symlink" >&2; ` +
		`else printf %s "${userPath}"; fi)"`
	)
}

/** Shell word for the build lock path on the server: BUILD_LOCK as root, else
 *  USER_BUILD_LOCK; `suffix` is appended to either (shell text, e.g. `.$__pi` for a
 *  builder slot). See rootOrHomePathShell. */
export function buildLockShell(suffix = ''): string {
	return rootOrHomePathShell(`${BUILD_LOCK}${suffix}`, `${USER_BUILD_LOCK}${suffix}`, 'build-lock')
}
