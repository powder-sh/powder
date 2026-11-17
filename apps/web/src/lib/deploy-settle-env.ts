import { db, powderMeta } from './db'
import { DEPLOY_SETTLE_META_KEY, parseSettleSeconds } from './deploy-settle'

// The install-wide settle window comes from POWDER_DEPLOY_SETTLE_SECONDS in the env file.
// Every reader of the window (the push path in deploys.ts and heldSql, which the scripts
// copy) reads the powder_meta row, so at boot the env value is written into that row:
// one place to read, and the SQL and the JS never disagree. Unset or empty leaves the
// row as it is; an unreadable value is logged and leaves it as it is too.

export type SettleEnvPlan = { write: string } | { skip: 'unset' } | { warn: string }

/** What boot does with POWDER_DEPLOY_SETTLE_SECONDS. Pure. */
export function settleEnvPlan(env: Record<string, string | undefined> = process.env): SettleEnvPlan {
	const raw = (env.POWDER_DEPLOY_SETTLE_SECONDS ?? '').trim()
	if (raw === '') return { skip: 'unset' }
	const seconds = parseSettleSeconds(raw)
	if (seconds === null)
		return { warn: `POWDER_DEPLOY_SETTLE_SECONDS must be a number of seconds (0 = off), got: ${raw.slice(0, 40)}; the install default is unchanged` }
	return { write: String(seconds) }
}

/** Boot: write the env default into powder_meta (never throws). */
export async function syncSettleDefaultFromEnv(env: Record<string, string | undefined> = process.env): Promise<void> {
	const plan = settleEnvPlan(env)
	if ('skip' in plan) return
	if ('warn' in plan) {
		console.warn(`[settle] ${plan.warn}`)
		return
	}
	try {
		await db
			.insert(powderMeta)
			.values({ key: DEPLOY_SETTLE_META_KEY, value: plan.write })
			.onConflictDoUpdate({ target: powderMeta.key, set: { value: plan.write, updatedAt: new Date() } })
	} catch (err) {
		console.error('[settle] could not store POWDER_DEPLOY_SETTLE_SECONDS:', err instanceof Error ? err.message : err)
	}
}
