/** `tail` for `docker logs --tail`: an integer 1..5000, else the default. */
export function parseLogTail(raw: string | null, fallback = 200): number {
	if (raw == null || !/^\d+$/.test(raw.trim())) return fallback
	const n = Number(raw.trim())
	return Number.isInteger(n) && n >= 1 && n <= 5000 ? n : fallback
}
