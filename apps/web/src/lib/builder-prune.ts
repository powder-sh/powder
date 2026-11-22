// Disk cap on every dedicated build host (servers.build_host).
//
// The builder keeps BuildKit cache from every app's build. A size cap given as
// `docker builder prune --max-used-space` counts only the cache's PRIVATE bytes:
// with shared records the `docker buildx du` total can be several times the
// private bytes, so such a cap never bites while the snapshots fill the disk.
// So the cap here is checked against the `docker buildx du` Total (shared
// records included) and, while it is over, the cache is pruned by age in
// steps (24h, 12h, 6h, 3h, 1h), never below 1h while the root disk is under
// BUILDER_ROOT_PCT_WARN. At or above it the steps go on to 30m and 15m, each
// only while the root disk is still at the warn level (BUILDER_PRUNE_DEEP_AGES).
//
// It measures first, with no lock: a host under its cap takes no build slot.
// Over the cap, no prune runs while a build is in progress on the host: the
// prune takes every build slot lock (the flock files builds hold through plock
// in builder.ts), so no powder build or test gate runs during it and none starts
// until it ends (at most bodyTimeoutSec). It waits for the slots (a blocked flock
// wins a freed slot over plock's 2s poll), so a host that never goes idle still
// gets pruned between builds. Image pulls run outside the slots, so a pull-only
// process check (PULL_BUSY_CHECK: docker pull/load/import, compose pull) is asked
// before and while holding them, and the prune holds the pull lock that a builder
// script's own image pulls take (builderPullGuardFunctions), so the test gate's pull
// never overlaps it; builds and test gates are already kept out by
// the slots, so a `docker build` in ps never blocks the prune. Once the prune has
// held the slots (done, failed, or stopped by a pull it saw there), it does not
// run again for 1h while the root disk is under BUILDER_ROOT_PCT_WARN, so a host
// far over its cap does not drain the build slots after every build; a timed-out
// slot wait (which may have held the first slots) waits 15 min. The gate ends
// early with the disk at risk (see the root disk rule below). When it cannot prune it only measures, says so in the
// marker (pruned=0 skip=<why>) and powder gives no "after the prune" verdict for
// it; the age of the last real prune (a state file on the host) turns a host
// whose cache was not pruned for a day into a warning of its own. The reclaimed totals
// docker prints are logged.
//
// The cap is a soft target, not the alert. A busy build host (a few builds an
// hour on 2 slots) can refill tens of GB of cache within the hour, all of it
// under 1h old and in use, so a prune cannot take it under the cap. Over the cap
// after a prune that shrank the cache is a busy host, not a disk at risk. So a prune
// that ran warns only for the real risk: the root disk at
// BUILDER_ROOT_PCT_WARN, or BUILDER_PRUNE_STUCK_RUNS prunes in a row that each
// left the cache over the cap AND larger than the prune before left it (the
// prune cannot keep up, the cache keeps growing toward the disk). The
// post-prune size and the count live in files on the host; any prune that
// leaves less than the one before, or a run under the cap, resets the count.
// A growth streak rather than a time-to-full projection: the marker has no
// disk size and one hour of builds swings the cache by 30+ GB, so a
// projection from two points would be noise.
//
// The 1h gate yields to a root disk that is filling. Every prune that held the
// slots records the root disk it left (`root` state file). With the cache over
// its cap and the root disk at BUILDER_ROOT_PCT_WARN or more and higher than that
// prune left it, a run at least BUILDER_PRUNE_RATE_MIN_GAP_SEC after it ends the
// gate: the cache refilled the disk to the card's own threshold, so the prune runs
// before the card would post. From BUILDER_ROOT_PCT_ALERT the gate is skipped
// outright. So a quiet host (under the warn level, a disk that is not rising, or
// a disk filled by something other than the cache) prunes at most once an hour,
// and a burst of builds gets a prune each time it brings the disk back to the
// warn level, at most once per BUILDER_PRUNE_RATE_MIN_GAP_SEC below the alert
// level. The card warns at BUILDER_ROOT_PCT_WARN: a disk the prune could not
// bring under it, or one at it while the prune could not run.
// Anything else after a prune resolves the card.
//
// powder runs it over ssh after every builder phase (no cron to install, so any
// new build host gets it with its first build). One run at a time (flock -n).
// Tagged images are never removed here (a built `<image>-b<id>` may still be
// waiting for its stream). Clone dirs of apps not built for a week are removed
// (a build removes its own clone when it ends).

import { buildLockShell, rootOrHomePathShell } from './build-lock'
import { IMAGE_ACTIVITY_MAX_AGE_SEC } from './deploy/prune-lock'
import { shq } from './shell'

/** Default cap for the build cache Total on a build host, in GB. */
const BUILDER_CACHE_CAP_GB_DEFAULT = 30

/** Root disk use (%) at or above which a build host is reported and pruned. */
export const BUILDER_ROOT_PCT_WARN = 75

/** Root disk use (%) at or above which the prune skips its 1h gate (it still
 *  waits for pulls and takes the build slots). Under it, from
 *  BUILDER_ROOT_PCT_WARN, the gate ends for a disk the cache is filling (see
 *  BUILDER_PRUNE_RATE_MIN_GAP_SEC). */
export const BUILDER_ROOT_PCT_ALERT = 85

/** Seconds after a prune that held the slots before a root disk at
 *  BUILDER_ROOT_PCT_WARN, higher than that prune left it and with the cache over
 *  its cap, may end the 1h gate: a rise over less time is df noise, and it bounds
 *  the prunes below BUILDER_ROOT_PCT_ALERT to one per this many seconds. */
export const BUILDER_PRUNE_RATE_MIN_GAP_SEC = 900

/** Age steps below 1h, taken only with the root disk at BUILDER_ROOT_PCT_WARN
 *  (each one only while it still is). The prune holds the build slots, so no
 *  build is using the cache it removes. */
export const BUILDER_PRUNE_DEEP_AGES = ['30m', '15m'] as const

/** Prunes in a row that each left the cache over the cap and larger than the
 *  prune before, at which a build host is reported (prunes an hour apart, or at least
 *  BUILDER_PRUNE_RATE_MIN_GAP_SEC apart with the root disk at the warn level). */
export const BUILDER_PRUNE_STUCK_RUNS = 3

/** Where the cap prune keeps its run lock and state on the build host: under /run
 *  and /var/lib/powder as root, under the ssh user's $HOME otherwise (the same choice
 *  as the build lock, rootOrHomePathShell). `last`: the time (epoch s) of the last
 *  completed cache prune; `attempt`: when a prune last held the build slots (the 1h
 *  gate); `stuck`: the count of prunes in a row that left the cache over the cap and
 *  larger than the prune before; `after`: the cache the last prune left (MB);
 *  `root`: the root disk (%) when a prune last held the slots (0: unknown);
 *  `pull`: held shared by every image pull of a builder script and exclusively
 *  by the prune (builderPullGuardFunctions). */
export const BUILDER_PRUNE_PATHS = {
	lock: { root: '/run/powder-builder-prune.lock', user: '$HOME/.powder-builder-prune.lock' },
	last: { root: '/var/lib/powder/builder-prune.last', user: '$HOME/.powder-builder-prune.last' },
	attempt: { root: '/var/lib/powder/builder-prune.attempt', user: '$HOME/.powder-builder-prune.attempt' },
	stuck: { root: '/var/lib/powder/builder-prune.stuck', user: '$HOME/.powder-builder-prune.stuck' },
	after: { root: '/var/lib/powder/builder-prune.after', user: '$HOME/.powder-builder-prune.after' },
	root: { root: '/var/lib/powder/builder-prune.root', user: '$HOME/.powder-builder-prune.root' },
	pull: { root: '/run/powder-builder-pull.lock', user: '$HOME/.powder-builder-pull.lock' },
} as const

/** Seconds the prune waits for the pull lock while it holds the build slots. */
export const BUILDER_PRUNE_PULL_LOCK_WAIT_SEC = 60

/** Seconds a builder script's image pull waits for a running prune to end
 *  (above the prune's bodyTimeoutSec and its kill grace). */
export const BUILDER_PULL_LOCK_WAIT_SEC = 960

/** Shell functions for the builder script: `docker pull` called from the script's
 *  own shell (the test gate's image pull, and the Dockerfile check's base image
 *  pulls through dfr_pull in build-cache.ts, which sets $__PULL_TIMEOUT to the
 *  `timeout <s>` the pull runs under) holds the pull lock shared, so the cap
 *  prune (which takes it exclusively) never runs during one. A prune that
 *  overlaps a pull fails the pull inside dockerd ("failed to lease content:
 *  NotFound: lease ... not found"), which the test gate reports as a registry
 *  that did not answer. A pull that still fails is tried once more without the
 *  lock, so a lock that cannot be taken never fails a pull by itself. Every
 *  other docker call passes through. `lockPath`, `retryDelaySec`: tests only. */
export function builderPullGuardFunctions(lockPath?: string, retryDelaySec = 3): string {
	const lock = lockPath === undefined ? rootOrHomePathShell(BUILDER_PRUNE_PATHS.pull.root, BUILDER_PRUNE_PATHS.pull.user, 'builder-pull') : shq(SAFE_PATH(lockPath, 'pull lock path'))
	return (
		`__PULL_LOCK=${lock}; ` +
		`docker() { if [ "\${1:-}" != pull ]; then command docker "$@"; return $?; fi; __dr=1; ` +
		`if [ -n "$__PULL_LOCK" ] && command -v flock >/dev/null 2>&1; then __dr=0; flock -s -w ${BUILDER_PULL_LOCK_WAIT_SEC} "$__PULL_LOCK" \${__PULL_TIMEOUT:-} docker "$@" || __dr=$?; fi; ` +
		`if [ "$__dr" -ne 0 ]; then sleep ${Math.max(0, Math.floor(retryDelaySec))}; __dr=0; \${__PULL_TIMEOUT:-command} docker "$@" || __dr=$?; fi; return "$__dr"; }; `
	)
}

/** Cap in GB (env POWDER_BUILDER_CACHE_CAP_GB, default 30, clamped 5..2000). */
export function builderCacheCapGb(env: Record<string, string | undefined> = process.env): number {
	const n = Number.parseInt(env.POWDER_BUILDER_CACHE_CAP_GB ?? '', 10)
	return Number.isFinite(n) ? Math.min(2000, Math.max(5, n)) : BUILDER_CACHE_CAP_GB_DEFAULT
}

/** Each `docker buildx du` is bounded by this (seconds). */
const DU_TIMEOUT_SEC = 120

/** Shell: the `docker buildx du` Total in MB (decimal units, as docker prints
 *  them), or -1 when it cannot be read. */
export const BUILD_CACHE_TOTAL_MB_SHELL =
	`timeout --foreground ${DU_TIMEOUT_SEC} docker buildx du 2>/dev/null | awk '/^Total:/{v=$2} END{ if (v == "") { print -1; exit } n = v + 0; u = v; sub(/^[0-9.]+/, "", u); m = 0; ` +
	`if (u == "B") m = 1e-6; else if (u == "kB" || u == "KB") m = 1e-3; else if (u == "MB") m = 1; else if (u == "GB") m = 1e3; else if (u == "TB") m = 1e6; ` +
	`if (m == 0) { print -1; exit } printf "%d\\n", n * m }'`

/** The marker line the prune ends with; parsed by parseBuilderPruneResult. */
const BUILDER_PRUNE_MARKER = 'POWDER_BUILDER_PRUNE'


/** ERE over the args of a docker CLI process that pulls or unpacks an image
 *  (an image prune deletes the layers of one in progress). Builds and test gate
 *  runs are left out: on a build host they run under the build slots the prune
 *  holds. `--pull`/`--load` flags of a build do not match. */
export const IMAGE_PULL_ERE = '(^|/)docker(-compose)?( image)? (pull|load|import)( |$)|compose( .*)? pull( |$)'

/** Shell test: true while a recent docker CLI process pulls, loads or imports
 *  an image (same ps/awk shape as IMAGE_BUSY_CHECK in deploy/prune-lock.ts). */
export const PULL_BUSY_CHECK = `ps -C docker,docker-compose,docker-buildx -o etimes=,args= 2>/dev/null | awk -v max=${IMAGE_ACTIVITY_MAX_AGE_SEC} -v re='${IMAGE_PULL_ERE}' '$1 < max { $1 = ""; sub(/^ +/, ""); if ($0 ~ re) f = 1 } END { exit !f }'`

/** Seconds after a prune that held the build slots (done or failed) before the
 *  next one may take them. */
export const BUILDER_PRUNE_MIN_GAP_SEC = 3600

/** Seconds before the next try after the wait for the slots timed out (it may
 *  have held the first slots meanwhile, so builds queued behind it). */
export const BUILDER_PRUNE_LOCKED_GAP_SEC = 900

/** Defaults of the waits and bounds in builderCapPruneShell (seconds). */
export const BUILDER_PRUNE_DEFAULTS = { pullWaitSec: 120, busyWaitSec: 600, bodyTimeoutSec: 900 } as const

/** Worst-case run time (seconds) of builderCapPruneShell with the given waits:
 *  the pull wait, the slot wait, the prune and its kill grace, and the two
 *  cache measurements outside it. */
export function builderCapPruneWorstSec(o: { pullWaitSec?: number; busyWaitSec?: number; bodyTimeoutSec?: number } = {}): number {
	const d = BUILDER_PRUNE_DEFAULTS
	return (o.pullWaitSec ?? d.pullWaitSec) + (o.busyWaitSec ?? d.busyWaitSec) + (o.bodyTimeoutSec ?? d.bodyTimeoutSec) + 10 + 2 * DU_TIMEOUT_SEC
}

/** How long powder waits for the cap prune over ssh (seconds): above
 *  builderCapPruneWorstSec() with the defaults (1870s). */
export const BUILDER_PRUNE_RUN_TIMEOUT_SEC = 2400

/** A skipped prune is reported once the last real one is this old (seconds).
 *  A day: a skipped prune alone is information (the log line), not a risk. On
 *  a busy host the pull check and the 1h gate skip it for hours on end and the
 *  next free moment catches up, while the root disk rule above covers a disk
 *  that really fills. A day without one prune means the prune itself is broken. */
export const BUILDER_PRUNE_STALE_SEC = 24 * 3600

export interface BuilderCapPruneOpts {
	/** Cap in GB (default builderCacheCapGb()). */
	capGb?: number
	/** Where the builder clones live (default /opt/builds). */
	buildsRoot?: string
	/** Seconds to wait in all for the build slots before skipping the cache prune
	 *  (default 600, split evenly across the slots). */
	busyWaitSec?: number
	/** Seconds to wait for a running image pull to end, before any slot is
	 *  taken (default 120). */
	pullWaitSec?: number
	/** Seconds the prune may hold the slots (default 900); each docker call
	 *  inside gets at most 300. */
	bodyTimeoutSec?: number
	/** Build slots on the host (builderBuildSlots(); default 2). */
	slots?: number
	/** Tests only: the run lock, the slot lock prefix and the state file (default
	 *  BUILDER_PRUNE_PATHS). With stateFile set, the attempt, stuck, after and root
	 *  files default to builder-prune.attempt / .stuck / .after / .root next to it; with lockPath
	 *  set, the pull lock defaults to `<lockPath>.pull`. */
	lockPath?: string
	slotLockPrefix?: string
	stateFile?: string
	attemptFile?: string
	stuckFile?: string
	afterFile?: string
	rootFile?: string
	pullLockPath?: string
	/** Seconds to wait for the pull lock while holding the slots (default 60). */
	pullLockWaitSec?: number
}

const SAFE_PATH = (p: string, what: string): string => {
	if (!/^\/[A-Za-z0-9._/-]+$/.test(p) || /(^|\/)\.\.?(\/|$)/.test(p)) throw new Error(`builder-prune: bad ${what} ${p}`)
	return p
}

/** Why a prune that was needed did not run: `locked` builds held the build
 *  slots, `busy` an image pull was in progress, `failed` the prune failed or
 *  timed out, `recent` a prune held the slots under 1h ago and the cache has
 *  not refilled the root disk to the warn level (or did so within 15 min). */
export type BuilderPruneSkip = 'locked' | 'busy' | 'failed' | 'recent'

/** The cap prune run on a build host. Pure string builder (tested under bash
 *  with a stub docker). Always exits 0.
 *  It measures first, with no lock: a host under its cap (and its root disk
 *  under 75%) is a verdict on its own and takes no build slot. Otherwise the
 *  prune runs holding every build slot lock (no build or test gate runs
 *  meanwhile: BuildKit can fail a running solve whose parent snapshot a prune
 *  removed), never while an image pull runs (pulls run outside the slots: the
 *  Dockerfile base check and the test gate pull; an image prune deletes the
 *  layers of a pull in progress), and for at most bodyTimeoutSec. When it
 *  cannot run the marker says pruned=0 and why (skip=). A prune that held the
 *  slots (done or failed) gates the next one for 1h, except with the root disk
 *  at 85%, or at 75%, over the cap and higher than the last prune left it after
 *  15 min (with the root disk at 75% the age steps also go below 1h). Every completed prune,
 *  and every run that finds the cache under the cap, writes the time to the
 *  state file; the marker carries its age. */
export function builderCapPruneShell(o: BuilderCapPruneOpts = {}): string {
	const capGb = Math.max(1, Math.floor(o.capGb ?? builderCacheCapGb()))
	const capMb = capGb * 1000
	const root = SAFE_PATH(o.buildsRoot ?? '/opt/builds', 'builds root')
	// shell words: a test path as given, else the root-or-$HOME choice
	const P = BUILDER_PRUNE_PATHS
	const word = (given: string | undefined, what: string, d: { root: string; user: string }) =>
		given === undefined ? rootOrHomePathShell(d.root, d.user, 'builder-prune') : shq(SAFE_PATH(given, what))
	const sib = (name: string) => (o.stateFile === undefined ? undefined : `${posixDir(o.stateFile)}/builder-prune.${name}`)
	const lock = word(o.lockPath, 'lock path', P.lock)
	// Slot i is the lock plockFn in builder.ts takes: buildLockShell(`.<i>`).
	const slotPrefix = o.slotLockPrefix === undefined ? null : SAFE_PATH(o.slotLockPrefix, 'slot lock prefix')
	const slotLock = (i: number) => (slotPrefix === null ? buildLockShell(`.${i}`) : shq(`${slotPrefix}${i}`))
	const st = word(o.stateFile, 'state file', P.last)
	const at = word(o.attemptFile ?? sib('attempt'), 'attempt file', P.attempt)
	const sk = word(o.stuckFile ?? sib('stuck'), 'stuck file', P.stuck)
	const af = word(o.afterFile ?? sib('after'), 'after file', P.after)
	const rf = word(o.rootFile ?? sib('root'), 'root file', P.root)
	const pl = word(o.pullLockPath ?? (o.lockPath === undefined ? undefined : `${o.lockPath}.pull`), 'pull lock path', P.pull)
	const slots = Math.min(8, Math.max(1, Math.floor(o.slots ?? 2)))
	const busyWait = Math.max(0, Math.floor(o.busyWaitSec ?? BUILDER_PRUNE_DEFAULTS.busyWaitSec))
	const perSlot = Math.max(1, Math.ceil(busyWait / slots))
	const pullWait = Math.max(0, Math.floor(o.pullWaitSec ?? BUILDER_PRUNE_DEFAULTS.pullWaitSec))
	const bodyT = Math.max(1, Math.floor(o.bodyTimeoutSec ?? BUILDER_PRUNE_DEFAULTS.bodyTimeoutSec))
	const dockerT = Math.min(300, bodyT)
	// wr FILE: records the time now (its dir is created as needed); an optional
	// 2nd arg backdates the record by that many seconds. The paths are in
	// $__ST / $__AT / $__SK / $__AF (exported, so the prune's sh -c sees them;
	// empty when a $HOME path was refused as a symlink, then every write fails).
	// wstate: a completed prune; watt: a prune that held the slots.
	const wr = `wr() { mkdir -p "\${1%/*}" 2>/dev/null; __t=$(( $(date +%s) - \${2:-0} )); { echo "$__t" > "$1"; } 2>/dev/null || true; }; `
	const wstate = `wstate() { wr "$__ST"; }; watt() { wr "$__AT" "$1"; }; `
	// dp ARGS: one docker call, bounded; logs the reclaimed totals it prints.
	const dp = `dp() { __o=$(timeout --foreground ${dockerT} docker "$@" 2>&1); __r=$?; printf '%s\n' "$__o" | awk -v w="docker $*" '/^Total/ { gsub(/\t+/, " "); print "[builder-prune] " w ": " $0 }'; return $__r; }; `
	const rootPct = `df -P / 2>/dev/null | awk 'NR==2{gsub(/%/, "", $5); print $5 + 0}'`
	const defs = `CAP_MB=${capMb}; cache_mb() { ${BUILD_CACHE_TOTAL_MB_SHELL}; }; busy() { ${PULL_BUSY_CHECK}; }; rootpct() { __p=$(${rootPct}); echo "\${__p:--1}"; }; ${wr}${wstate}${dp}`
	// the prune itself, run holding every build slot. Exit 215: a pull started
	// while it held them (214 is the check before any slot is taken).
	// --foreground keeps each docker call in the prune's process group, so the
	// outer timeout kills it too (a plain timeout makes a group of its own).
	const body =
		defs +
		`if busy; then echo "[builder-prune] an image pull is in progress, cache and image prune skipped"; exit 215; fi; ` +
		`dp image prune -f || true; ` +
		`dp builder prune -af --max-used-space ${capGb}GB || dp builder prune -af --keep-storage ${capGb}GB || true; ` +
		`C=$(cache_mb); C=\${C:--1}; ` +
		// unknown size (-1): stop, never prune blind down to 1h. $__DEEP: the steps
		// under 1h (root disk at the warn level when the run began); each needs the
		// root disk still at it (an unreadable one stops them).
		`for A in 24h 12h 6h 3h 1h $__DEEP; do if [ "$C" -lt 0 ] || [ "$C" -le "$CAP_MB" ]; then break; fi; ` +
		`case "$A" in *m) if [ "$(rootpct)" -lt ${BUILDER_ROOT_PCT_WARN} ]; then break; fi;; esac; ` +
		`if busy; then echo "[builder-prune] build cache \${C}MB over the \${CAP_MB}MB cap, but an image pull is in progress: age prune stopped"; exit 215; fi; ` +
		`echo "[builder-prune] build cache \${C}MB over the \${CAP_MB}MB cap, pruning cache unused for $A"; ` +
		`dp builder prune -af --filter "until=$A" || true; C=$(cache_mb); C=\${C:--1}; done; ` +
		`wstate; exit 0`
	// -o: the slot fds stay with the flock processes, never with the prune's
	// children, so the slots are free the moment timeout kills the prune.
	// after the slots, the pull lock: the builder scripts' image pulls hold it shared
	// (builderPullGuardFunctions), so none is in progress or starts during the prune.
	// Not free in time: exit 215, as for a pull seen while holding the slots.
	const holdSlots =
		Array.from({ length: slots }, (_, i) => `flock -o -w ${perSlot} -E 213 ${slotLock(i)} `).join('') +
		`flock -o -x -w ${Math.max(0, Math.floor(o.pullLockWaitSec ?? BUILDER_PRUNE_PULL_LOCK_WAIT_SEC))} -E 215 ${pl} `
	const runBody = `timeout -k 10 ${bodyT} sh -c ${shq(body)}`
	return (
		`( __PL=${lock}; __ST=${st}; __AT=${at}; __SK=${sk}; __AF=${af}; __RT=${rf}; __DEEP=; export __ST __AT __SK __AF __DEEP; ` +
		`if [ -z "$__PL" ] || ! { exec 8>"$__PL"; } 2>/dev/null; then echo "[builder-prune] cannot open the prune lock \${__PL:-(refused)}, skipped"; exit 0; fi; ` +
		`if command -v flock >/dev/null 2>&1 && ! flock -n 8; then echo "[builder-prune] another prune is running, skipped"; exit 0; fi; ` +
		defs +
		`rd() { __v=$(head -n1 "$1" 2>/dev/null); case "$__v" in ''|*[!0-9]*) echo 0;; *) echo "$__v";; esac; }; ` +
		`ago() { if [ "$1" -gt 0 ]; then __g=$(( $(date +%s) - $1 )); [ "$__g" -lt 0 ] && __g=0; echo "$__g"; else echo -1; fi; }; ` +
		`last() { rd "$__ST"; }; age() { ago "$(last)"; }; gage() { ago "$(rd "$__AT")"; }; ` +
		// wn FILE VALUE: a value that may go down; a file it cannot write is said.
		`wn() { mkdir -p "\${1%/*}" 2>/dev/null; { echo "$2" > "$1"; } 2>/dev/null || echo "[builder-prune] \${1:-(refused path)} is not writable: the cache growth streak is not kept"; }; ` +
		// rs/ws: the count of prunes in a row that left the cache over the cap
		// and larger than the prune before; ra/wa: the cache the last one left.
		`rs() { rd "$__SK"; }; ws() { wn "$__SK" "$1"; }; ` +
		`ra() { rd "$__AF"; }; wa() { wn "$__AF" "$1"; }; ` +
		// wp: the root disk a prune that held the slots left (a file it cannot
		// write only loses the early end of the gate: the fixed gate stays).
		`wp() { mkdir -p "\${__RT%/*}" 2>/dev/null; { echo "$1" > "$__RT"; } 2>/dev/null || true; }; ` +
		// no record yet: start counting now, so a host whose prune never runs
		// still turns stale.
		`if [ "$(last)" -eq 0 ]; then wstate; if [ "$(last)" -eq 0 ]; then echo "[builder-prune] \${__ST:-(refused path)} is not writable: the last prune age is unknown"; fi; fi; ` +
		`C=$(cache_mb); C=\${C:--1}; C0=$C; P=$(rootpct); GA=$(gage); PR=0; SKIP=none; NEED=0; EARLY=0; ` +
		`if [ "$P" -ge ${BUILDER_ROOT_PCT_WARN} ] || [ "$C" -gt "$CAP_MB" ]; then NEED=1; fi; ` +
		`if [ "$P" -ge ${BUILDER_ROOT_PCT_WARN} ]; then __DEEP=${shq(BUILDER_PRUNE_DEEP_AGES.join(' '))}; fi; ` +
		// the cache refilled the disk: over the cap, the root disk at the warn level
		// and above the $RA% the last prune that held the slots left, $GA s ago (at
		// least ${BUILDER_PRUNE_RATE_MIN_GAP_SEC}s): the gate ends. An unknown $RA (0) keeps it.
		`RA=$(rd "$__RT"); if [ "$C" -gt "$CAP_MB" ] && [ "$P" -ge ${BUILDER_ROOT_PCT_WARN} ] && [ "$P" -lt ${BUILDER_ROOT_PCT_ALERT} ] && [ "$RA" -gt 0 ] && [ "$P" -gt "$RA" ] && [ "$GA" -ge ${BUILDER_PRUNE_RATE_MIN_GAP_SEC} ] && [ "$GA" -lt ${BUILDER_PRUNE_MIN_GAP_SEC} ]; then EARLY=1; ` +
		`echo "[builder-prune] root disk \${P}%, \${RA}% after the prune \${GA}s ago, cache over the cap: the gate ends, pruning now"; fi; ` +
		// the 1h gate holds unless the root disk is at ${BUILDER_ROOT_PCT_ALERT}% or the cache refilled it (EARLY).
		`if [ "$NEED" -eq 1 ] && { [ "$GA" -lt 0 ] || [ "$GA" -ge ${BUILDER_PRUNE_MIN_GAP_SEC} ] || [ "$P" -ge ${BUILDER_ROOT_PCT_ALERT} ] || [ "$EARLY" -eq 1 ]; }; then ` +
		// a pull in progress: wait for it before taking any slot.
		`W=0; while [ "$W" -lt ${pullWait} ] && busy; do sleep 5; W=$((W+5)); done; ` +
		`if busy; then RC=214; elif command -v flock >/dev/null 2>&1; then ${holdSlots}${runBody} 8>&-; RC=$?; ` +
		// no flock binary (no slot locks either): the process check decides.
		`else ${runBody} 8>&-; RC=$?; fi; ` +
		// it held the slots (done, failed, timed out, a pull came): the next one
		// waits 1h; the slot wait timed out (it may have held the first ones):
		// ${BUILDER_PRUNE_LOCKED_GAP_SEC}s. Only the pull check before the slots (214) is ungated.
		`if [ "$RC" -eq 213 ]; then watt ${BUILDER_PRUNE_MIN_GAP_SEC - BUILDER_PRUNE_LOCKED_GAP_SEC}; elif [ "$RC" -ne 214 ]; then watt; fi; ` +
		`if [ "$RC" -ne 214 ] && [ "$(rd "$__AT")" -eq 0 ]; then echo "[builder-prune] \${__AT:-(refused path)} is not writable: the prune runs after every build"; fi; ` +
		`if [ "$RC" -eq 0 ]; then PR=1; elif [ "$RC" -eq 213 ]; then SKIP=locked; echo "[builder-prune] builds held the build slots for ${busyWait}s, cache and image prune skipped (a later run catches up)"; ` +
		`elif [ "$RC" -eq 214 ] || [ "$RC" -eq 215 ]; then SKIP=busy; echo "[builder-prune] an image pull is in progress, cache and image prune skipped (a later run catches up)"; ` +
		`else SKIP=failed; echo "[builder-prune] the prune failed or timed out (exit $RC)"; fi; ` +
		`C=$(cache_mb); C=\${C:--1}; P=$(rootpct); ` +
		// the root disk this attempt left (0 when unreadable: the fixed gate holds).
		`if [ "$RC" -ne 214 ]; then if [ "$P" -gt 0 ]; then wp "$P"; else wp 0; fi; fi; ` +
		// a prune that ran: over the cap and larger than the prune before left
		// it counts one more in the growth streak; anything else resets it.
		`if [ "$PR" -eq 1 ] && [ "$C" -ge 0 ]; then PA=$(ra); if [ "$C" -gt "$CAP_MB" ] && [ "$PA" -gt 0 ] && [ "$C" -gt "$PA" ]; then ws $(( $(rs) + 1 )); else ws 0; fi; wa "$C"; fi; ` +
		`elif [ "$NEED" -eq 1 ]; then SKIP=recent; echo "[builder-prune] build cache \${C}MB (cap \${CAP_MB}MB), root disk \${P}%: a prune took the build slots \${GA}s ago, skipped until the gate ends"; ` +
		// under the cap: nothing to prune, a verdict on its own.
		`else PR=1; if [ "$C" -ge 0 ]; then wstate; if [ "$(rs)" -ne 0 ]; then ws 0; fi; if [ "$(ra)" -ne 0 ]; then wa 0; fi; fi; fi; ` +
		`find ${shq(root)} -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf -- {} \\; 2>/dev/null || true; ` +
		`AGE=$(age); STK=$(rs); ` +
		`echo "${BUILDER_PRUNE_MARKER} cache_mb=$C cap_mb=$CAP_MB root_pct=$P pruned=$PR skip=$SKIP last_prune_age_s=$AGE before_mb=$C0 stuck=$STK"; true )`
	)
}

function posixDir(p: string): string {
	const i = p.lastIndexOf('/')
	return i <= 0 ? '/' : p.slice(0, i)
}

export interface BuilderPruneResult {
	cacheMb: number
	capMb: number
	rootPct: number
	/** Whether the cache prune ran (or had nothing to do) this time (an old
	 *  marker: true). */
	pruned: boolean
	/** Why it did not run (pruned false); null when it ran or unknown. */
	skip: BuilderPruneSkip | null
	/** Seconds since the last completed cache prune; null when unknown. */
	lastPruneAgeSec: number | null
	/** The cache this run found before any prune (MB); null when unknown. */
	beforeMb: number | null
	/** Prunes in a row that each left the cache over the cap and larger than
	 *  the prune before (0 when unknown). */
	stuckPrunes: number
}

/** The last marker line of the prune's output, or null (skipped or cut off).
 *  An old marker without pruned/last_prune_age_s reads as pruned, age unknown;
 *  without before_mb/stuck as before unknown, no stuck prunes. */
export function parseBuilderPruneResult(stdout: string): BuilderPruneResult | null {
	const all = [
		...stdout.matchAll(
			new RegExp(`^${BUILDER_PRUNE_MARKER} cache_mb=(-?\\d+) cap_mb=(\\d+) root_pct=(-?\\d+)(?: pruned=([01]))?(?: skip=([a-z]+))?(?: last_prune_age_s=(-?\\d+))?(?: before_mb=(-?\\d+))?(?: stuck=(\\d+))?$`, 'gm'),
		),
	]
	const m = all[all.length - 1]
	if (!m) return null
	const age = m[6] === undefined ? -1 : Number(m[6])
	const before = m[7] === undefined ? -1 : Number(m[7])
	const skip = (['locked', 'busy', 'failed', 'recent'] as const).find((k) => k === m[5]) ?? null
	return {
		cacheMb: Number(m[1]),
		capMb: Number(m[2]),
		rootPct: Number(m[3]),
		pruned: m[4] !== '0',
		skip: m[4] === '0' ? skip : null,
		lastPruneAgeSec: age >= 0 ? age : null,
		beforeMb: before >= 0 ? before : null,
		stuckPrunes: m[8] === undefined ? 0 : Number(m[8]),
	}
}

/** Why a build host's disk is at risk after a prune that ran, or null when it
 *  is fine. The cache over the cap alone is not a risk: the prune stops at
 *  cache unused for 1h, and a busy host refills it with cache in use. It is
 *  one only when BUILDER_PRUNE_STUCK_RUNS prunes in a row each left more than
 *  the one before (the cache keeps growing toward the disk), or the root disk
 *  is at BUILDER_ROOT_PCT_WARN. Only a verdict for a prune that ran (see
 *  builderPruneVerdict). */
export function builderDiskRisk(r: Pick<BuilderPruneResult, 'cacheMb' | 'capMb' | 'rootPct' | 'stuckPrunes'>): string | null {
	// an unreadable size is no verdict either way (the caller posts nothing).
	const why: string[] = []
	if (r.stuckPrunes >= BUILDER_PRUNE_STUCK_RUNS && r.cacheMb > r.capMb)
		why.push(
			`build cache ${Math.round(r.cacheMb / 1000)} GB over the ${Math.round(r.capMb / 1000)} GB cap and larger after each of ${r.stuckPrunes} prunes in a row`,
		)
	if (r.rootPct >= BUILDER_ROOT_PCT_WARN) why.push(`root disk ${r.rootPct}% full`)
	return why.length ? why.join(', ') : null
}

/** What to post for one prune run: nothing (`post: false`), a resolve
 *  (`problem: null`) or a warning. A skipped prune is no "after the prune"
 *  verdict: it warns only for a full root disk or a cache not pruned for
 *  staleSec, and never resolves. */
export type BuilderPruneVerdict = { post: false } | { post: true; problem: string | null; afterPrune: boolean }

const STALE_WHY: Record<BuilderPruneSkip | 'unknown', string> = {
	locked: 'builds never paused',
	busy: 'an image pull was in progress every time',
	failed: 'the prune keeps failing or timing out',
	recent: 'the prune was skipped',
	unknown: 'the prune was skipped',
}

export function builderPruneVerdict(r: BuilderPruneResult, staleSec: number = BUILDER_PRUNE_STALE_SEC): BuilderPruneVerdict {
	// size unreadable: post nothing (neither a warning nor a resolve).
	if (r.cacheMb < 0) return { post: false }
	if (r.pruned) return { post: true, problem: builderDiskRisk(r), afterPrune: true }
	const why: string[] = []
	if (r.lastPruneAgeSec !== null && r.lastPruneAgeSec >= staleSec)
		why.push(
			`the build cache has not been pruned for ${Math.floor(r.lastPruneAgeSec / 3600)}h because ${STALE_WHY[r.skip ?? 'unknown']}; cache ${Math.round(r.cacheMb / 1000)} GB, cap ${Math.round(r.capMb / 1000)} GB`,
		)
	if (r.rootPct >= BUILDER_ROOT_PCT_WARN) why.push(`root disk ${r.rootPct}% full`)
	return why.length ? { post: true, problem: why.join(', '), afterPrune: false } : { post: false }
}

/** The one log line per prune run. */
export function builderPruneLogLine(host: string, r: BuilderPruneResult): string {
	const age = r.lastPruneAgeSec === null ? 'unknown' : `${r.lastPruneAgeSec}s`
	const before = r.beforeMb === null ? '' : ` (found ${r.beforeMb} MB)`
	return `[builder-prune] ${host}: cache ${r.cacheMb} MB${before} cap ${r.capMb} MB root ${r.rootPct}% pruned=${r.pruned ? 1 : 0}${r.skip ? ` skip=${r.skip}` : ''} last_prune_age=${age} stuck=${r.stuckPrunes}`
}
