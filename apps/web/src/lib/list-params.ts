// query parameters of the list/search APIs, parsed once. Bad input gets a
// default or a 400, never NaN in SQL (a 500).

/** ?limit= of /api/deploys-list: an integer 1..200, default 50 (also for junk). */
export function parseListLimit(raw: string | null, def = 50, max = 200): number {
	const n = raw === null || raw.trim() === '' ? Number.NaN : Number(raw)
	if (!Number.isFinite(n)) return def
	return Math.min(Math.max(Math.floor(n), 1), max)
}

/** ?cursor= of /api/deploys-list: an ISO timestamp, normalised. null = no cursor;
 *  'invalid' = answer 400. */
export function parseListCursor(raw: string | null): string | null | 'invalid' {
	if (raw === null || raw === '') return null
	const ms = Date.parse(raw)
	return Number.isFinite(ms) ? new Date(ms).toISOString() : 'invalid'
}

/** ?sinceDays= of /api/logs/search: an integer 1..90, default 30 (also for junk). */
export function parseSinceDays(raw: string | null): number {
	return parseListLimit(raw, 30, 90)
}

/** Most rows a log search returns, and the most time its query may take. */
export const LOG_SEARCH_LIMIT = 50
export const LOG_SEARCH_TIMEOUT_MS = 10_000
