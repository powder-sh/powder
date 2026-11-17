import { createHash } from 'node:crypto'
import { shq } from './shell'
// One authority for "may this deploy swap the app's containers?".
//
// The race: two deploys of the same app overlap on the target server. If the
// OLDER commit's `docker compose build` finishes last, it writes the shared
// `image:` tag (app:latest) and its `up --force-recreate` swaps the containers
// away from a newer, healthy deploy. The DB lock (deploys_in_flight_unique) only
// guards powder's rows; a reaped row (watchdog) or a deploy-worker restart leaves
// the old remote script running while the next deploy starts, and the server-wide
// build flock covers the build, not the swap. So the ordering lives on the target
// server, where the swap happens, in the deploy script: the only place that
// survives a dead/reaped executor:
//   1. a per-(app, service) flock held for the WHOLE script (build + swap);
//   2. a monotonic ordinal (the deploy row's claim time, ms) compared with a
//      stamp file written at each swap; an older ordinal never builds/swaps;
//   3. builds write a unique `:build-<id>` tag, never the shared `image:` tag;
//      the shared tag is only retagged inside the gate, under the lock.
// The JS side (deploy-runner) additionally skips a deploy whose row is already
// superseded by a newer running/success row, before touching the server.

export const SUPERSEDED_MARKER = '__POWDER_SUPERSEDED__'

/** the marker a deploy script prints, tagged with the run's random nonce
 *  (like the sha marker) so build or test output cannot print it. No nonce: the
 *  plain marker (powder's own runner-side note). */
export function supersededMarkerFor(nonce = ''): string {
	const n = nonce.replace(/[^A-Za-z0-9]/g, '')
	return n ? `__POWDER_SUPERSEDED_${n}__` : SUPERSEDED_MARKER
}

/** A line that starts with the marker (followed by a space or the line end). */
export function hasMarkerLine(out: string, marker: string): boolean {
	return out.split('\n').some((l) => l === marker || l.startsWith(`${marker} `))
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_')

/** per-app deploy locks live in a root-only dir OUTSIDE the app workdir (not
 *  /tmp: protected_regular breaks cross-user opens there). In the workdir layout the
 *  workdir is the git checkout, and a lock file there is something the repo can track. */
export const APP_LOCK_DIR = '/var/lib/powder/locks'

/** Per-(app dir, service) lock file on the target server:
 *  <APP_LOCK_DIR>/<sha256(workingDir|service) first 16 hex>-<service>.lock. The hash is
 *  the identity (same derivation as swapStampPath); the slug is only for humans. Every
 *  caller (deploy, self-deploy, rollback, recreates, health/abort restore) uses this one
 *  function with the same workingDir, so they all take the same flock. */
export function appLockPath(workingDir: string, service: string, dir: string = APP_LOCK_DIR): string {
	const id = createHash('sha256').update(`${workingDir.replace(/\/+$/, '')}|${service}`).digest('hex').slice(0, 16)
	return `${dir.replace(/\/+$/, '')}/${id}-${slug(service)}.lock`
}

/** Shell: create the lock's directory root-only (0700) and refuse a symlinked one.
 *  Ends with `; `. Exits 1 when the dir cannot be made. */
export function appLockDirShell(lock: string): string {
	const d = shq(lock.replace(/\/[^/]*$/, '') || '/')
	return `{ [ ! -L ${d} ] && mkdir -p ${d} && chmod 700 ${d}; } || { echo "per-app lock dir unusable (a symlink or cannot be created), refusing"; exit 1; }; `
}

/** Swap stamps live OUTSIDE the app workdir. In the workdir layout the workdir is
 *  the git checkout, so a repo that tracks `.powder-swap-<svc>` could plant a huge
 *  ordinal and make every later deploy "superseded" (silent no-op). */
const SWAP_STAMP_DIR = '/var/lib/powder/swap'

/** Stamp file holding the ordinal of the last deploy that swapped this service:
 *  <dir>/<sha256(workingDir|service) first 16 hex>-<container>-<service>. The hash is the
 *  identity; the slug is only for humans. A bare `<container>-<service>` join
 *  collided across apps (`foo`+`bar-app` == `foo-bar`+`app`), so one app's stamp made the
 *  other's deploys exit as superseded. `container` defaults to the workdir's basename
 *  (/opt/apps/<container>). Writer (script.ts) and reader (run.ts) both call this. */
export function swapStampPath(workingDir: string, service: string, container?: string, dir: string = SWAP_STAMP_DIR): string {
	const c = container ?? workingDir.replace(/\/+$/, '').split('/').pop() ?? ''
	const id = createHash('sha256').update(`${workingDir.replace(/\/+$/, '')}|${service}`).digest('hex').slice(0, 16)
	return `${dir.replace(/\/+$/, '')}/${id}-${slug(c)}-${slug(service)}`
}

/** Abort record next to the stamp: line 1 = image id that was running before the swap gate
 *  retagged the shared tag, line 2 = the shared `image:` ref. The script removes it on every
 *  clean exit (its EXIT trap restores the tag); it survives only a SIGKILL / dropped session,
 *  and then the JS side restores the tag (deploy/run.ts restoreSharedTagAfterAbort). */
export function swapPrevPath(stamp: string): string {
	return `${stamp}.prev`
}

/** Unique per-deploy tag for the image: `repo/name:tag` -> `repo/name:build-<id>`.
 *  Mirrors the shell derivation in buildDeployScript (registry ports respected). */
export function stageImageTag(image: string, deployId: string): string {
	const last = image.slice(image.lastIndexOf('/') + 1)
	const base = last.includes(':') ? image.slice(0, image.lastIndexOf(':')) : image
	return `${base}:build-${slug(deployId.replace(/^dep_/, ''))}`
}

/** Only deploys that build and ship code count: restart/apply/env/reconcile rows
 *  do not make an older build stale. */
const CODE_DEPLOY_KINDS = ['git_deploy']

/** Pure decision used by the runner before it touches the server: a deploy is
 *  superseded when another deploy of the same app started LATER and is running
 *  or already succeeded. (A merely queued newer deploy does NOT supersede: that
 *  is the normal burst-coalescing case, the queued one runs after this one.) */
export function isSupersededBy(
	me: { id: string; startedAt: Date | string },
	others: Array<{ id: string; status: string; kind: string; startedAt: Date | string }>,
): { id: string } | null {
	const mine = new Date(me.startedAt).getTime()
	for (const o of others) {
		if (o.id === me.id || !CODE_DEPLOY_KINDS.includes(o.kind)) continue
		if (o.status !== 'running' && o.status !== 'success') continue
		if (new Date(o.startedAt).getTime() > mine) return { id: o.id }
	}
	return null
}

/** Shell: exit 0 with the marker if a newer deploy already swapped. */
export function supersedeCheckShell(stamp: string, ordinal: number, nonce = ''): string {
	return (
		`{ SW_LAST=$(cat ${shq(stamp)} 2>/dev/null || echo 0); case "$SW_LAST" in ''|*[!0-9]*) SW_LAST=0;; esac; ` +
		`if [ "$SW_LAST" -gt ${ordinal} ]; then ` +
		`echo "${supersededMarkerFor(nonce)} a newer deploy (ordinal $SW_LAST > ${ordinal}) already swapped this app; this older deploy does NOT build or swap"; exit 0; fi; }`
	)
}

/** Shell: the swap gate. Re-checks the stamp under the lock, records this
 *  deploy as the latest swapper, then (only now) points the shared image tag at
 *  the staged build. Expects IMGREF / STAGE_IMG to be set (either may be empty).
 *  `ordinal` null = no ordering (retag only). */
export function swapGateShell(stamp: string, ordinal: number | null, service: string, nonce = ''): string {
	return (
		`{ ` +
		(ordinal ? `${supersedeCheckShell(stamp, ordinal, nonce)}; ` : '') +
		`if [ -n "$STAGE_IMG" ] && [ -z "$IMGREF" ]; then echo "swap gate: no image: ref for service "${shq(service)}; exit 1; fi; ` +
		(ordinal ? `{ mkdir -p ${shq(stamp.replace(/\/[^/]*$/, ''))} && [ ! -L ${shq(stamp)} ] || { echo "swap gate: stamp dir unusable or stamp path is a symlink, refusing"; exit 1; }; } && echo ${ordinal} > ${shq(stamp)} || { echo "swap gate: cannot write stamp"; exit 1; }; ` : '') +
		`if [ -n "$STAGE_IMG" ] && [ -n "$IMGREF" ]; then ` +
		`docker image inspect "$STAGE_IMG" >/dev/null 2>&1 || { echo "swap gate: staged image $STAGE_IMG is missing"; exit 1; }; ` +
		`docker tag "$STAGE_IMG" "$IMGREF" || { echo "swap gate: could not tag $IMGREF"; exit 1; }; echo "[stage] $IMGREF now -> $STAGE_IMG"; ` +
		`fi; }`
	)
}
