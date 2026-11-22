// Hermetic environment for unit tests that spawn shell scripts.
//
// Many tests run generated scripts under bash with stubs and pass
// `{ ...process.env, PATH: `${stubs}:${process.env.PATH}` }`. Whatever the host
// carries then leaks into the script: a global git config, ~/.pgpass and PG*
// vars, DOCKER_HOST/DOCKER_CONFIG, the locale (`sort` order), a shared TMPDIR,
// and the real docker CLI on PATH. The suite passed on one machine and failed
// on another. vitest.setup.ts calls installHermeticEnv() before every test
// file, so process.env itself is clean and every spawn inherits the clean copy.
//
// What it covers (see hermetic-env.test.ts for the guard that keeps it so):
// - host-state env vars are removed: PG*, GIT_*, DOCKER_*, COMPOSE_*, BUILDKIT_*,
//   SSH_AUTH_SOCK, SSH_KEY_PATH, XDG_*, LC_*/LANG/LANGUAGE, POWDER_* (POWDER_TEST_* stays: it is
//   the opt-in for the .db tests)
// - HOME, XDG_CONFIG_HOME and TMPDIR point at a private per-file temp dir (no
//   host ~/.gitconfig, ~/.pgpass, ~/.docker, ~/.ssh; ~/.ssh/id_ed25519 is a
//   stand-in, as tests stub ssh2's connect; os.tmpdir() is private, so listing
//   it never sees another process's files)
// - git: GIT_CONFIG_NOSYSTEM=1 and GIT_CONFIG_GLOBAL is an empty file
// - git run from a hook: git exports GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and the
//   rest of `git rev-parse --local-env-vars` to hooks, so a suite started from a
//   hook (pre-commit, `git rebase --exec`, an editor hook) would run every temp-repo
//   `git init/commit/push` against the REAL repository (a fixture's
//   push can replace the real branch's whole tree). The GIT_* strip removes them
//   all; GIT_CEILING_DIRECTORIES is the hermetic root, so a temp dir that is not a
//   repo never finds one above it. git-hook-env.test.ts starts vitest with a
//   sentinel repo in those vars and checks it stays untouched.
// - no LC_*/LANG: the POSIX locale (byte order for sort/ls/find)
// - TMPDIR is short (/tmp/pv-XXXXXX/f-XXXXXX/t, never the long macOS
//   /var/folders/... dir): the .db tests put a postgres unix socket under it and
//   macOS caps a socket path at 104 bytes
// - PATH starts with a guard dir whose `docker` fails (like a CLI without a
//   reachable daemon), so no test talks to the host's docker daemon. Only the
//   client-only `docker compose version` and `docker compose ... config` pass
//   through to the host CLI ($POWDER_TEST_HOST_DOCKER, with the host's docker
//   config dir for the compose plugin), so the real-compose tests still run where
//   compose is installed. A test that needs docker ABSENT uses pathWithout(['docker']).
// - host config files the generated bridge / swap-check scripts read (/opt/apps/.mem-cap)
//   come from an empty <root>/host-opt-apps (POWDER_TEST_HOST_APPS_DIR, honoured only
//   under vitest by deploy/fragments.ts hostAppsDir)
// - `mktemp` and `mktemp -d` without a template land in $TMPDIR: the guard dir
//   wraps the host mktemp, as the BSD one on newer macOS ignores TMPDIR and would
//   put a script's temp files in the shared per-user temp dir
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** Env var names a spawned script must never inherit from the host. */
export const HOST_STATE_ENV = /^(PG[A-Z_]*|GIT_[A-Z0-9_]*|DOCKER_[A-Z_]*|COMPOSE_[A-Z_]*|BUILDKIT_[A-Z_]*|SSH_AUTH_SOCK|SSH_KEY_PATH|XDG_[A-Z_]*|LC_[A-Z_]*|LANG|LANGUAGE|POWDER_(?!TEST_)[A-Z0-9_]*)$/

/** The system dirs pathWithout() draws from. */
const SYSTEM_DIRS = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

const ROOT_VAR = 'VITEST_HERMETIC_ROOT'

/** Short fixed base for the hermetic roots (see the TMPDIR note above). */
export const HERMETIC_BASE = '/tmp/pv-'

/** First executable `name` on a PATH, or an empty string. */
function findOnPath(name: string, path: string): string {
	for (const d of path.split(':')) {
		if (!d) continue
		try {
			if (statSync(join(d, name)).isFile()) return join(d, name)
		} catch {}
	}
	return ''
}

// The guard docker: compose's client-only subcommands (version, config) go to the
// host CLI; everything else fails as with no daemon.
const GUARD_DOCKER = `#!/bin/sh
if [ "$1" = compose ] && [ -n "$POWDER_TEST_HOST_DOCKER" ]; then
  skip=0
  for a in "$@"; do
    if [ "$a" = compose ] || [ $skip = 1 ]; then skip=0; continue; fi
    case "$a" in
      -f|--file|-p|--project-name|--profile|--env-file|--project-directory|--ansi|--progress|--parallel) skip=1; continue;;
      -*) continue;;
      version|config) DOCKER_CONFIG="$POWDER_TEST_HOST_DOCKER_CONFIG" exec "$POWDER_TEST_HOST_DOCKER" "$@";;
      *) break;;
    esac
  done
fi
echo "docker: the host docker CLI is blocked in unit tests (stub it on PATH)" >&2
exit 1
`

// No template: name one in $TMPDIR, as GNU mktemp does. Anything else goes through.
const guardMktemp = (real: string) => `#!/bin/sh
case "$*" in
  '') exec '${real}' "\${TMPDIR:-/tmp}/tmp.XXXXXXXXXX";;
  -d) exec '${real}' -d "\${TMPDIR:-/tmp}/tmp.XXXXXXXXXX";;
esac
exec '${real}' "$@"
`

/** The private root installHermeticEnv() created for this test file. */
export function hermeticRoot(): string {
	const r = process.env[ROOT_VAR]
	if (!r) throw new Error('hermetic env not installed (vitest.setup.ts runs installHermeticEnv)')
	return r
}

/** Strip host state from process.env and point HOME/TMPDIR/git at a private dir. Returns that dir. */
export function installHermeticEnv(): string {
	// under the run's parent (vitest.global-setup.ts) when there is one
	const parent = process.env.VITEST_HERMETIC_PARENT
	const root = parent ? mkdtempSync(join(parent, 'f-')) : mkdtempSync(HERMETIC_BASE)
	const home = join(root, 'home')
	const tmp = join(root, 't')
	const guard = join(root, 'guard-bin')
	for (const d of [home, tmp, guard, join(home, '.config')]) mkdirSync(d, { recursive: true })
	mkdirSync(join(home, '.ssh'), { mode: 0o700 })
	writeFileSync(join(home, '.gitconfig'), '')
	// ssh/connection.ts reads the default key ($HOME/.ssh/id_ed25519) before any
	// (stubbed) connect: a stand-in, so no test depends on the host having a key.
	writeFileSync(join(home, '.ssh', 'id_ed25519'), 'not-a-key\n', { mode: 0o600 })
	writeFileSync(join(guard, 'docker'), GUARD_DOCKER)
	chmodSync(join(guard, 'docker'), 0o755)
	const hostDocker = findOnPath('docker', process.env.PATH ?? '')
	const hostMktemp = findOnPath('mktemp', process.env.PATH ?? SYSTEM_DIRS.join(':'))
	if (hostMktemp) {
		writeFileSync(join(guard, 'mktemp'), guardMktemp(hostMktemp))
		chmodSync(join(guard, 'mktemp'), 0o755)
	}
	const hostDockerConfig = process.env.DOCKER_CONFIG || join(process.env.HOME ?? '/nonexistent', '.docker')
	for (const k of Object.keys(process.env)) if (HOST_STATE_ENV.test(k)) delete process.env[k]
	process.env.HOME = home
	process.env.XDG_CONFIG_HOME = join(home, '.config')
	process.env.TMPDIR = tmp
	process.env.GIT_CONFIG_NOSYSTEM = '1'
	process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig')
	// git compares real paths here (macOS /tmp is a symlink)
	process.env.GIT_CEILING_DIRECTORIES = realpathSync(root)
	process.env.POWDER_TEST_HOST_DOCKER = hostDocker
	process.env.POWDER_TEST_HOST_DOCKER_CONFIG = hostDockerConfig
	process.env.PATH = `${guard}:${process.env.PATH ?? SYSTEM_DIRS.join(':')}`
	// generated bridge / swap-check scripts read host config files (/opt/apps/.mem-cap)
	// from here instead of the real host (deploy/fragments.ts hostAppsDir): empty, so the
	// scripts take their no-file defaults.
	const hostApps = join(root, 'host-opt-apps')
	mkdirSync(hostApps)
	process.env.POWDER_TEST_HOST_APPS_DIR = hostApps
	process.env[ROOT_VAR] = root
	return root
}

export function removeHermeticRoot(root: string) {
	rmSync(root, { recursive: true, force: true })
}

/**
 * A PATH (one dir) with every executable of the system dirs except `names`,
 * for tests that want only system tools (pathWithout([])) or need a command to
 * be ABSENT (`command -v docker` fails) on a server that has it installed. The
 * host's docker is never linked: `docker` is the failing guard stub unless
 * 'docker' is in `names`, then it is absent.
 *
 * One dir per distinct `names` set per hermetic root, built on first use: a
 * dir holds about a thousand symlinks, and building one per call made a test
 * that probes in a loop slow to run and slow to clean up. The dir is shared,
 * so callers treat it as read-only (put stubs in a dir of their own, ahead of
 * it on PATH).
 */
const pathWithoutCache = new Map<string, string>()

export function pathWithout(names: string[]): string {
	const root = hermeticRoot()
	const key = `${root}\0${[...new Set(names)].sort().join('\0')}`
	const cached = pathWithoutCache.get(key)
	if (cached && existsSync(cached)) return cached
	const dir = buildPathWithout(root, names)
	pathWithoutCache.set(key, dir)
	return dir
}

function buildPathWithout(root: string, names: string[]): string {
	const dir = mkdtempSync(join(root, 'path-'))
	if (!names.includes('docker')) symlinkSync(join(root, 'guard-bin', 'docker'), join(dir, 'docker'))
	if (!names.includes('mktemp') && existsSync(join(root, 'guard-bin', 'mktemp')))
		symlinkSync(join(root, 'guard-bin', 'mktemp'), join(dir, 'mktemp'))
	for (const sys of SYSTEM_DIRS) {
		if (!existsSync(sys)) continue
		for (const n of readdirSync(sys)) {
			if (names.includes(n) || existsSync(join(dir, n))) continue
			try {
				if (!statSync(join(sys, n)).isFile()) continue
			} catch {
				continue
			}
			symlinkSync(join(sys, n), join(dir, n))
		}
	}
	return dir
}
