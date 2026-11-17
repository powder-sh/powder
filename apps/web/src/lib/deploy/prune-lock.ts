// Shared guard for every image/cache prune powder runs on an app server.
//
// `docker image prune -f` on a server with the containerd image store can delete
// the layers of an image another process is pulling or unpacking right then
// (a cron's `docker run`/`docker pull`, another app's deploy). That container
// then fails to start (a smoke image broken by another app's post-deploy
// cleanup). So every prune:
//   1. takes the same flock as the hourly infra/powder-image-prune.sh, so no
//      two prunes overlap, and
//   2. runs the dangling-image prune only when no docker CLI process is
//      pulling, building, loading or starting an image (waits a while first;
//      still busy = that step is skipped, the hourly prune reclaims it later).
// Build-cache prune and tag retention still run under the lock: BuildKit keeps
// in-use cache records, and `rmi` of named old tags never touches a pull.

/** The lock infra/powder-image-prune.sh takes. Under /run, which only root can
 *  write: the hourly prune runs as root. A deploy script whose ssh user is not root
 *  cannot open it and prunes without the lock (never a fixed name under /tmp,
 *  where any local user could create the file or plant a link first). */
export const PRUNE_LOCK_PATH = '/run/powder-image-prune.lock'

/** ERE over the args of `ps -C docker,docker-compose,docker-buildx`: a docker CLI
 *  process that may be downloading, unpacking or creating an image. Matching
 *  on the process name (not `pgrep -f`) keeps the deploy script's own shell,
 *  whose argv mentions `docker compose pull`, from matching itself. Over-matches
 *  (e.g. `docker compose exec app npm run x`) only delay or skip one prune. */
export const IMAGE_ACTIVITY_ERE =
	'(^|/)docker(-compose|-buildx)?( (image|container|buildx))? (pull|run|create|build|bake|load|import|up)( |$)|compose .*(pull|run|create|build|up)( |$)'

/** Seconds after which a matching process no longer counts as busy: a
 *  foreground `docker run` under systemd or a long cron job would otherwise
 *  block the dangling-image prune forever. Above the 1800s build timeout plus grace, so a long build still counts. */
export const IMAGE_ACTIVITY_MAX_AGE_SEC = 3600

/** Shell test: true while a recent (< max age) docker CLI process pulls, builds
 *  or starts an image. awk reads all of ps's output (no early-exit grep -q, so
 *  no SIGPIPE under pipefail). No ps or no etimes: false (not busy).
 *  infra/powder-image-prune.sh carries the same check (a test keeps them equal). */
export const IMAGE_BUSY_CHECK = `ps -C docker,docker-compose,docker-buildx -o etimes=,args= 2>/dev/null | awk -v max=${IMAGE_ACTIVITY_MAX_AGE_SEC} -v re='${IMAGE_ACTIVITY_ERE}' '$1 < max { $1 = ""; sub(/^ +/, ""); if ($0 ~ re) f = 1 } END { exit !f }'`

export interface LockedPruneOpts {
	/** Prefix for the lines it prints (e.g. "[preflight]"). */
	label: string
	/** Max seconds to wait for another prune holding the lock; then skip. */
	lockWaitSec: number
	/** Max seconds to wait for a running pull/build before skipping the image prune. */
	busyWaitSec: number
	/** The dangling-image prune: runs only when no pull/build is in progress. */
	imagePrune: string
	/** Commands that run under the lock regardless (build cache, tag retention). */
	rest?: string[]
	/** Lock still held after lockWaitSec: run `rest` anyway (a low-disk preflight
	 *  must still reclaim build cache; BuildKit keeps in-use records). Default false. */
	restOnLockTimeout?: boolean
}

/** One subshell (so its fd 7, and with it the lock, ends with it) that prunes
 *  without overlapping the hourly prune or an image pull. Always exits 0. */
export function lockedPruneShell(o: LockedPruneOpts): string {
	const lockWait = Math.max(0, Math.floor(o.lockWaitSec))
	const busyWait = Math.max(0, Math.floor(o.busyWaitSec))
	const rest = (o.rest ?? []).map((c) => `${c} || true; `).join('')
	const onTimeout = o.restOnLockTimeout
		? `{ echo "${o.label} another image prune still running after ${lockWait}s, only build cache reclaimed"; ${rest}exit 0; }`
		: `{ echo "${o.label} another image prune still running after ${lockWait}s, skipped"; exit 0; }`
	return (
		// Wait out a running pull/build BEFORE taking the lock, so the lock is
		// held only while pruning (the hourly prune uses flock -n and would
		// otherwise skip its run, build-cache size cap included).
		`( W=0; while [ "$W" -lt ${busyWait} ] && ${IMAGE_BUSY_CHECK}; do sleep 5; W=$((W+5)); done; ` +
		'PL=; ' +
		`{ exec 7>${PRUNE_LOCK_PATH}; } 2>/dev/null && PL=1; ` +
		`if [ -n "$PL" ] && command -v flock >/dev/null 2>&1; then flock -w ${lockWait} 7 || ${onTimeout}; fi; ` +
		`if ${IMAGE_BUSY_CHECK}; then echo "${o.label} an image pull/build is in progress, dangling-image prune skipped (the hourly prune reclaims it)"; else ${o.imagePrune} || true; fi; ` +
		rest +
		'true )'
	)
}
