// Disk cap on every dedicated build host (servers.build_host).
//
// The builder keeps BuildKit cache from every app's build. A size cap given as
// `docker builder prune --max-used-space` counts only the cache's PRIVATE bytes:
// with shared records the `docker buildx du` total can be several times the
// private bytes, so such a cap never bites while the snapshots fill the disk.
// So the cap here is checked against the `docker buildx du` Total (shared
// records included) and, while it is over, the cache is pruned by age in
// steps (24h, 12h, 6h, 3h, 1h), never below 1h.
//
// It measures first, with no lock: a host under its cap takes no build slot.
// Over the cap, no prune runs while a build is in progress on the host: the
// prune takes every build slot lock (the flock files builds hold through plock
// in builder.ts), so no powder build or test gate runs during it and none starts
// until it ends (at most bodyTimeoutSec). It waits for the slots (a blocked flock
// wins a freed slot over plock's 2s poll), so a host that never goes idle still
// gets pruned between builds. Image pulls run outside the slots, so a pull-only
// process check (PULL_BUSY_CHECK: docker pull/load/import, compose pull) is asked
// before and while holding them; builds and test gates are already kept out by
// the slots, so a `docker build` in ps never blocks the prune. Once the prune has
// held the slots (done, failed, or stopped by a pull it saw there), it does not
// run again for 1h, whatever the cache or root disk say, so a host far over its
// cap does not drain the build slots after every build; a timed-out slot wait
// (which may have held the first slots) waits 15 min. When it cannot prune it only measures, says so in the
// marker (pruned=0 skip=<why>) and powder gives no "after the prune" verdict for
// it; the age of the last real prune (a state file on the host) turns a host
// whose cache is never pruned into a warning of its own. The reclaimed totals
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
// projection from two points would be noise. At a refill rate of ~13 points of
// disk per hour, 85% is about an hour from full, so the card warns at 75% and
// from 85% the prune skips its 1h gate.
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
 *  waits for pulls and takes the build slots). */
export const BUILDER_ROOT_PCT_ALERT = 85

/** Prunes in a row that each left the cache over the cap and larger than the
 *  prune before, at which a build host is reported (with the 1h gate: 3h+ of
 *  growth). */
export const BUILDER_PRUNE_STUCK_RUNS = 3

/** Where the cap prune keeps its run lock and state on the build host: under /run
 *  and /var/lib/powder as root, under the ssh user's $HOME otherwise (the same choice
 *  as the build lock, rootOrHomePathShell). `last`: the time (epoch s) of the last
 *  completed cache prune; `attempt`: when a prune last held the build slots (the 1h
 *  gate); `stuck`: the count of prunes in a row that left the cache over the cap and
 *  larger than the prune before; `after`: the cache the last prune left (MB). */
export const BUILDER_PRUNE_PATHS = {
	lock: { root: '/run/powder-builder-prune.lock', user: '$HOME/.powder-builder-prune.lock' },
	last: { root: '/var/lib/powder/builder-prune.last', user: '$HOME/.powder-builder-prune.last' },
	attempt: { root: '/var/lib/powder/builder-prune.attempt', user: '$HOME/.powder-builder-prune.attempt' },
	stuck: { root: '/var/lib/powder/builder-prune.stuck', user: '$HOME/.powder-builder-prune.stuck' },
	after: { root: '/var/lib/powder/builder-prune.after', user: '$HOME/.powder-builder-prune.after' },
} as const

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

/** A skipped prune is reported once the last real one is this old (seconds). */
export const BUILDER_PRUNE_STALE_SEC = 6 * 3600

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
	 *  BUILDER_PRUNE_PATHS). With stateFile set, the attempt, stuck and after files
	 *  default to builder-prune.attempt / .stuck / .after next to it. */
	lockPath?: string
	slotLockPrefix?: string
	stateFile?: string
	attemptFile?: string
	stuckFile?: string
	afterFile?: string
}

const SAFE_PATH = (p: string, what: string): string => {
	if (!/^\/[A-Za-z0-9._/-]+$/.test(p) || /(^|\/)\.\.?(\/|$)/.test(p)) throw new Error(`builder-prune: bad ${what} ${p}`)
	return p
}

/** Why a prune that was needed did not run: `locked` builds held the build
 *  slots, `busy` an image pull was in progress, `failed` the prune failed or
 *  timed out, `recent` a prune held the slots under 1h ago. */
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
 *  slots (done or failed) gates the next one for 1h (over the cap, root disk
 *  at 75%), except with the root disk at 85%. Every completed prune,
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
	const defs = `CAP_MB=${capMb}; cache_mb() { ${BUILD_CACHE_TOTAL_MB_SHELL}; }; busy() { ${PULL_BUSY_CHECK}; }; ${wr}${wstate}${dp}`
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
		// unknown size (-1): stop, never prune blind down to 1h.
		`for A in 24h 12h 6h 3h 1h; do if [ "$C" -lt 0 ] || [ "$C" -le "$CAP_MB" ]; then break; fi; ` +
		`if busy; then echo "[builder-prune] build cache \${C}MB over the \${CAP_MB}MB cap, but an image pull is in progress: age prune stopped"; exit 215; fi; ` +
		`echo "[builder-prune] build cache \${C}MB over the \${CAP_MB}MB cap, pruning cache unused for $A"; ` +
		`dp builder prune -af --filter "until=$A" || true; C=$(cache_mb); C=\${C:--1}; done; ` +
		`wstate; exit 0`
	// -o: the slot fds stay with the flock processes, never with the prune's
	// children, so the slots are free the moment timeout kills the prune.
	const holdSlots = Array.from({ length: slots }, (_, i) => `flock -o -w ${perSlot} -E 213 ${slotLock(i)} `).join('')
	const runBody = `timeout -k 10 ${bodyT} sh -c ${shq(body)}`
	const rootPct = `df -P / 2>/dev/null | awk 'NR==2{gsub(/%/, "", $5); print $5 + 0}'`
	return (
		`( __PL=${lock}; __ST=${st}; __AT=${at}; __SK=${sk}; __AF=${af}; export __ST __AT __SK __AF; ` +
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
		// no record yet: start counting now, so a host whose prune never runs
		// still turns stale.
		`if [ "$(last)" -eq 0 ]; then wstate; if [ "$(last)" -eq 0 ]; then echo "[builder-prune] \${__ST:-(refused path)} is not writable: the last prune age is unknown"; fi; fi; ` +
		`C=$(cache_mb); C=\${C:--1}; C0=$C; P=$(${rootPct}); P=\${P:--1}; GA=$(gage); PR=0; SKIP=none; NEED=0; ` +
		`if [ "$P" -ge ${BUILDER_ROOT_PCT_WARN} ] || [ "$C" -gt "$CAP_MB" ]; then NEED=1; fi; ` +
		// the 1h gate holds over the cap and with the root disk at
		// ${BUILDER_ROOT_PCT_WARN}%; from ${BUILDER_ROOT_PCT_ALERT}% (about an hour from full) the prune runs anyway.
		`if [ "$NEED" -eq 1 ] && { [ "$GA" -lt 0 ] || [ "$GA" -ge ${BUILDER_PRUNE_MIN_GAP_SEC} ] || [ "$P" -ge ${BUILDER_ROOT_PCT_ALERT} ]; }; then ` +
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
		`C=$(cache_mb); C=\${C:--1}; P=$(${rootPct}); P=\${P:--1}; ` +
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
