/** text from build output is attacker-shaped. Neutralise mentions
 *  (`@` + zero-width space), strip `<...>` (Discord/Slack <@id>, <!channel>,
 *  <url|text> link markup) and break markdown masked links `[text](url)` by
 *  separating `](`. Lives in a leaf module so hq.ts and notifications.ts share it. */
export function sanitizeNotifyText(text: string): string {
	return text.replace(/<[^>]*>/g, '').replace(/@/g, '@​').replace(/\]\(/g, '] (')
}

/** A step name that is safe to repeat in an HQ/Discord message. */
const SAFE_STEP_RE = /^[a-z0-9 _:-]{1,40}$/

/** Real step names ("git sync (force src/ to GitHub)") contain capitals, parens and
 *  slashes, so the raw name is normalised first (lowercase, anything outside
 *  [a-z0-9 _:-] becomes a space) and must then match SAFE_STEP_RE, else 'unknown'. */
export function safeFailedStep(step: string | null | undefined): string {
	if (!step) return 'unknown'
	const n = step
		.toLowerCase()
		.replace(/[^a-z0-9 _:-]+/g, ' ')
		.replace(/ +/g, ' ')
		.trim()
		.slice(0, 40)
		.trim()
	return SAFE_STEP_RE.test(n) ? n : 'unknown'
}
