// Global daily cap on model calls (POWDER_LLM_DAILY_MAX, default 50). The
// counter lives in powder_meta under `llm_calls:<UTC date>`; the increment is
// one atomic upsert, so concurrent callers cannot overshoot the cap.

import { db, sql } from './db'

export const DEFAULT_LLM_DAILY_MAX = 50

export function llmDailyMax(env: NodeJS.ProcessEnv = process.env): number {
	const n = Number(env.POWDER_LLM_DAILY_MAX)
	return Number.isInteger(n) && n >= 0 ? n : DEFAULT_LLM_DAILY_MAX
}

class LlmQuotaError extends Error {}

/** Reserve one call for today, or throw LlmQuotaError when the cap is reached. */
export async function reserveLlmCall(now: Date = new Date()): Promise<void> {
	const max = llmDailyMax()
	if (max === 0) throw new LlmQuotaError('model calls are disabled (POWDER_LLM_DAILY_MAX=0)')
	const key = `llm_calls:${now.toISOString().slice(0, 10)}`
	const rows = (await db.execute(sql`
		INSERT INTO powder_meta (key, value, updated_at) VALUES (${key}, '1', now())
		ON CONFLICT (key) DO UPDATE
			SET value = (powder_meta.value::int + 1)::text, updated_at = now()
			WHERE powder_meta.value::int < ${max}
		RETURNING value
	`)) as unknown as unknown[]
	if (rows.length === 0) {
		throw new LlmQuotaError(`daily model-call limit reached (${max}); raise POWDER_LLM_DAILY_MAX`)
	}
}
