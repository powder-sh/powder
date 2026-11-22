// Compose-drift state per app, and the one fleet inventory of standing drift.
//
// The deploy script (deploy/script.ts composeDriftShell) marks compose-drift as
// (composeDriftVerdict is the same rule in TypeScript, bound to the shell by a test):
//   drift    - this deploy's commits changed the repo docker-compose.yml and it
//              differs from the runtime compose: the per-app card is raised
//   standing - it differs, but no commit since the last deploy changed it: no
//              per-app card is raised or resolved, the app is listed in the
//              compose-drift inventory (one HQ task, no Discord) instead
//   ok       - both match (or no repo compose): the per-app card is resolved
//
// powder_meta `compose_drift:<server>/<app>` remembers the app's state: `drift`
// while a card raised under this rule may be open, `standing` otherwise. A
// `standing` deploy keeps `drift`, so an unrelated push never closes a card for a
// compose change that is still not applied. A `drift` row is sticky until a deploy
// where both files match (`ok`), also when it came from the no-base fallback (the
// first deploy, or the last deployed commit is gone from the clone and from origin):
// such an app keeps its card until the files match or the card is closed by hand.
//
// One-time retirement: before this rule every differing deploy raised the card,
// so standing-state cards are open. An app's first `standing` result with no row
// yet (no deploy under this rule raised its card) resolves that card once and
// writes the row; later `standing` results never resolve it. Apps that do not
// deploy keep their old card until infra/scripts/compose-drift-retire-old-cards.js
// closes it (same rule: only apps with no row).
//
// Rows of apps no longer in powder (no app_repos row) are dropped by list(), so a
// deleted app leaves the inventory, and an unregistered container never retires a
// card or joins the inventory.

export type ComposeDriftState = 'drift' | 'standing'
export type ComposeDriftEntry = { ref: string; value: ComposeDriftState }

/** Key/value store for the per-app state (powder_meta on the server). */
export type ComposeDriftStore = {
	get(ref: string): Promise<string | null>
	set(ref: string, value: ComposeDriftState): Promise<void>
	del(ref: string): Promise<void>
	/** every row of an app powder still has (rows of removed apps are pruned), sorted by ref */
	list(): Promise<ComposeDriftEntry[]>
}

export const COMPOSE_DRIFT_META_PREFIX = 'compose_drift:'
/** source_ref of the compose-drift inventory task (source powder-deploy-warn). */
export const COMPOSE_DRIFT_INVENTORY_REF = 'compose-drift-standing:fleet'

/** What the deploy found about the repo compose's commit range. `none` = no usable
 *  base (no earlier successful deploy, or that commit cannot be fetched). */
export type ComposeRange = 'changed' | 'unchanged' | 'none'

/** The marker the deploy script prints (deploy/script.ts composeDriftShell), as a pure
 *  function: the replay guard runs real deploy history through it, and a script test
 *  checks the generated shell gives the same answer for every input. */
export function composeDriftVerdict(differs: boolean, range: ComposeRange): 'drift' | 'standing' | 'ok' {
	if (!differs) return 'ok'
	return range === 'unchanged' ? 'standing' : 'drift'
}

export type ComposeDriftStep = {
	/** resolve the per-app card raised under the old every-deploy rule (once per app) */
	retireOld: boolean
	/** the app entered the standing set with this deploy: the inventory may reopen */
	joined: boolean
}

/** Update the app's state for this deploy's marker. Throws on a store error (the
 *  caller then raises and resolves nothing for compose-drift). */
export async function composeDriftStep(
	ref: string,
	value: 'drift' | 'standing' | 'ok',
	store: ComposeDriftStore,
): Promise<ComposeDriftStep> {
	if (value === 'ok') {
		await store.del(ref)
		return { retireOld: false, joined: false }
	}
	if (value === 'drift') {
		await store.set(ref, 'drift')
		return { retireOld: false, joined: false }
	}
	if ((await store.get(ref)) !== null) return { retireOld: false, joined: false }
	await store.set(ref, 'standing')
	// list() prunes rows of apps powder does not have: such a container keeps no row,
	// so it would look new on every deploy. It neither retires nor joins.
	const known = (await store.list()).some((e) => e.ref === ref)
	return { retireOld: known, joined: known }
}

/** The inventory: apps whose repo compose differs from the server's and that no
 *  deploy under this rule raised a card for (state `standing`), sorted. */
export function standingRefs(entries: ComposeDriftEntry[]): string[] {
	return entries
		.filter((e) => e.value === 'standing')
		.map((e) => e.ref)
		.sort()
}

/** powder_meta-backed store. The DB is imported lazily (hq.ts stays DB-free). */
export const powderMetaComposeDriftStore: ComposeDriftStore = {
	async get(ref) {
		const { db, sql } = await import('../db')
		const rows = (await db.execute(
			sql`SELECT value FROM powder_meta WHERE key = ${COMPOSE_DRIFT_META_PREFIX + ref}`,
		)) as unknown as Array<{ value: string }>
		return rows[0]?.value ?? null
	},
	async set(ref, value) {
		const { db, sql } = await import('../db')
		await db.execute(
			sql`INSERT INTO powder_meta (key, value, updated_at) VALUES (${COMPOSE_DRIFT_META_PREFIX + ref}, ${value}, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
		)
	},
	async del(ref) {
		const { db, sql } = await import('../db')
		await db.execute(sql`DELETE FROM powder_meta WHERE key = ${COMPOSE_DRIFT_META_PREFIX + ref}`)
	},
	async list() {
		const { db, sql } = await import('../db')
		// prune the rows of apps no longer in powder (deleted, or never registered)
		await db.execute(
			sql`DELETE FROM powder_meta m WHERE starts_with(m.key, ${COMPOSE_DRIFT_META_PREFIX}) AND NOT EXISTS (SELECT 1 FROM app_repos r WHERE m.key = ${COMPOSE_DRIFT_META_PREFIX} || r.server_id || '/' || r.container_name)`,
		)
		const rows = (await db.execute(
			sql`SELECT key, value FROM powder_meta WHERE starts_with(key, ${COMPOSE_DRIFT_META_PREFIX}) ORDER BY key`,
		)) as unknown as Array<{ key: string; value: string }>
		return rows
			.filter((r) => r.value === 'drift' || r.value === 'standing')
			.map((r) => ({ ref: r.key.slice(COMPOSE_DRIFT_META_PREFIX.length), value: r.value as ComposeDriftState }))
	},
}
