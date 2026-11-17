import { gitHardenShellFunctions } from './git-harden'
import { posix } from 'node:path'
import { shq } from './shell'

// ONE symlink authority. A hostile repo can commit symlinks (git mode 120000);
// powder runs as root next to (or inside) the checkout, so any writer that
// follows such a link, or any `[ -d src/.git ]` style probe that does, is a
// host write/read primitive. Two parts close it for every caller:
//   - repoSymlinkGuardShell: after ANY checkout/reset/clone, every TRACKED
//     symlink that is absolute, resolves outside the checkout, or carries a
//     powder-owned top-level name is removed and reported.
//   - atomicWriteShell: the only way powder writes a file next to a repo
//     (rm -f the destination, then rename a temp over it), so a leftover link
//     is replaced, never followed.
// Guard tests: __tests__/symlink-authority.test.ts.

const GUARD_SCRIPT = String.raw`
dir="$1"
cd "$dir" 2>/dev/null || exit 0
[ -e .git ] || exit 0
root=$(readlink -f .) || exit 1
bad=0
if [ -L src ]; then
  echo "removed hostile symlink: src -> $(readlink src)"
  rm -f -- src
  bad=1
fi
while IFS=$'\t' read -r -d '' meta p; do
  case "$meta" in 120000\ *) ;; *) continue ;; esac
  t=""
  [ -L "$p" ] && t=$(readlink -- "$p")
  hostile=0
  case "$p" in
    */*) ;;
    docker-compose.yml*|docker-compose.powder.yml|.powder-*|.env*|.deploy-key*) hostile=1 ;;
  esac
  if [ -L "$p" ]; then
    case "$t" in /*) hostile=1 ;; esac
    r=$(readlink -f -- "$p" 2>/dev/null || true)
    case "$r" in "$root"/*) ;; *) hostile=1 ;; esac
  fi
  if [ "$hostile" = 1 ]; then
    if [ -L "$p" ]; then
      echo "removed hostile symlink: $p -> $t"
      rm -f -- "$p"
    else
      echo "hostile symlink entry in the repo: $p (tracked as a link, not present as one)"
    fi
    bad=1
  fi
done < <(powder_git -c safe.directory="$dir" ls-files -s -z 2>/dev/null)
# powder's compose override lives outside the checkout; a repo that tracks the name is
# trying to smuggle compose config in (privileged, host mounts). Refuse the deploy.
if [ -n "$(powder_git -c safe.directory="$dir" ls-files -- docker-compose.powder.yml 2>/dev/null)" ]; then
  echo "refusing: the repo tracks docker-compose.powder.yml (a powder-owned name, never taken from a checkout)"
  bad=1
fi
exit $bad
`

/** Shell command (works from any POSIX shell: it runs bash itself). Exit 0 when
 *  the checkout in `dir` holds no hostile tracked symlink; otherwise removes each
 *  one, prints `removed hostile symlink: <path> -> <target>` and exits 1. The
 *  caller must refuse the deploy on non-zero. No-op when `dir` is not a git checkout. */
export function repoSymlinkGuardShell(dir: string): string {
	return `bash -c ${shq(gitHardenShellFunctions() + GUARD_SCRIPT)} _ ${shq(dir)}`
}

/** `rm -f dest && mv -fT src dest` (plain `mv -f` where -T is unsupported). The
 *  destination is unlinked first, so a link planted there is replaced, never
 *  written through. Both arguments are raw paths and are quoted here. */
export function atomicWriteShell(dest: string, srcTmp: string): string {
	return atomicWriteShellRaw(shq(dest), shq(srcTmp))
}

/** Same as atomicWriteShell for arguments that are already shell words
 *  (quoted strings or "$VAR" expansions). */
export function atomicWriteShellRaw(destWord: string, srcWord: string): string {
	return `rm -f -- ${destWord} && { mv -fT -- ${srcWord} ${destWord} 2>/dev/null || mv -f -- ${srcWord} ${destWord}; }`
}

/** (env render target): shell that exits non-zero when any existing component of `path` below `root`
 *  (root itself included) is a symlink: a repo cannot route the root write through
 *  a link it planted in its checkout. */
export function noSymlinkBelowShell(root: string, path: string): string {
	const r = posix.normalize(root)
	const rel = posix.normalize(path).slice(r.length).split('/').filter(Boolean)
	const steps = [r]
	for (const seg of rel) steps.push(`${steps[steps.length - 1]}/${seg}`)
	return `for P in ${steps.map(shq).join(' ')}; do if [ -L "$P" ]; then echo "env file path component $P is a symlink" >&2; exit 41; fi; done`
}
