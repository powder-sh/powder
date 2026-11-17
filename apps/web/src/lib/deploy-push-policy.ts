// may a deploy push its rollback tag (`<repo>:deploy-<id>`) to the image's
// registry repo? The push runs as root with root's registry logins (a server is often
// logged in to a registry such as ghcr.io), and the repo comes from the app's compose, so without this an
// app could push into another org's package or over another app's repo.
//
// One rule (pure, no I/O):
//   (a) the app pushed this repo on a successful deploy before the cutoff (migration
//       0058, powder_meta `deploy_push_cutoff`): allowed, unless another registered app
//       pushed the same repo MORE RECENTLY (then that app is the owner). Rows after the
//       cutoff are not evidence: image_tag is recorded when the push is skipped too, so
//       counting them would let a skipped push license the next one.
//   (b) the app has no push history: allowed only when the repo's last path segment is
//       the app name and no other registered app ever pushed it.
//   Anything else: the push is skipped with a WARN; the tag stays local and the deploy
//   still succeeds. A local image (no `/`) is never pushed.

export const DEPLOY_PUSH_CUTOFF_KEY = 'deploy_push_cutoff'

/** The registry repo of an image ref or a rollback tag: lowercase, no digest, no tag,
 *  Docker Hub's `docker.io/` / `index.docker.io/` and `library/` dropped. */
export function pushRepoOf(ref: string): string {
	let r = ref.trim().toLowerCase()
	const at = r.indexOf('@')
	if (at >= 0) r = r.slice(0, at)
	const slash = r.lastIndexOf('/')
	const colon = r.lastIndexOf(':')
	if (colon > slash) r = r.slice(0, colon)
	r = r.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '')
	if (r.startsWith('library/') && r.split('/').length === 2) r = r.slice('library/'.length)
	return r
}

export interface PushHistoryRow {
	/** deploys.container_name */
	app: string
	/** pushRepoOf(deploys.image_tag) */
	repo: string
	/** the latest started_at of a successful deploy of that app with that repo */
	last: Date
}

// a decision is branded so withRegistryCreds (docker-env.ts) can tell one this module
// issued from a literal. Symbol.for keeps the brand if the module is bundled twice.
const ISSUED: unique symbol = Symbol.for('powder.deployPushDecision') as never

export interface PushDecision {
	readonly allow: boolean
	readonly reason: string
	readonly [ISSUED]: true
}

function decided(allow: boolean, reason: string): PushDecision {
	return { allow, reason, [ISSUED]: true }
}

/** A refusal for a caller that cannot ask deployPushDecision (no registry repo, no
 *  owning app, a DB error). It never grants anything. */
export function refusedPush(reason: string): PushDecision {
	return decided(false, reason)
}

/** True for a decision deployPushDecision or refusedPush made. */
export function isIssuedPushDecision(d: unknown): d is PushDecision {
	return typeof d === 'object' && d !== null && (d as Record<symbol, unknown>)[ISSUED] === true
}

export function deployPushDecision(
	app: string,
	image: string,
	history: readonly PushHistoryRow[],
	registeredApps: readonly string[],
): PushDecision {
	const repo = pushRepoOf(image)
	if (!repo.includes('/')) return decided(false, 'a local image (no registry repo)')
	const self = app.toLowerCase()
	const registered = new Set(registeredApps.map((a) => a.toLowerCase()))
	const mineRows = history.filter((h) => h.app.toLowerCase() === self)
	const myLast = mineRows
		.filter((h) => h.repo === repo)
		.reduce<number | null>(
			(m, h) => (m === null || h.last.getTime() > m ? h.last.getTime() : m),
			null,
		)
	const others = history.filter(
		(h) => h.app.toLowerCase() !== self && registered.has(h.app.toLowerCase()) && h.repo === repo,
	)
	if (myLast !== null) {
		const newer = others
			.filter((h) => h.last.getTime() > myLast)
			.sort((x, y) => y.last.getTime() - x.last.getTime())[0]
		if (newer)
			return decided(false, `the app ${newer.app} pushed ${repo} more recently than ${app}`)
		return decided(true, `${app} pushed ${repo} before`)
	}
	if (mineRows.length > 0)
		return decided(false, `${app} never pushed ${repo} (it pushed ${[...new Set(mineRows.map((h) => h.repo))].sort().join(', ')})`)
	const last = repo.split('/').pop() ?? repo
	if (last !== self)
		return decided(false, `${repo} is not named after ${app} and ${app} has no push history`)
	const other = others[0]
	if (other) return decided(false, `the app ${other.app} pushed ${repo}`)
	return decided(true, `${repo} is named after ${app}`)
}
