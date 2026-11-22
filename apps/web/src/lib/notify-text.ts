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

/** What a failure summary says beyond the step it failed at, for every place that shows
 *  both (a "failed at <step>" line, the GitHub status, the ops event): '' when the
 *  summary is only `failed during: <step>` (the step as it is, or as safeFailedStep
 *  normalised it in older rows), the text after that when the summary starts with it
 *  (`(exit 124: ...)`), else the whole summary. Pure; no imports beyond this file, so
 *  client pages can use it. */
export function summaryBeyondStep(step: string | null | undefined, summary: string | null | undefined): string {
	const s = (summary ?? '').trim()
	if (!step || !s) return s
	for (const head of [`failed during: ${step}`, `failed during: ${safeFailedStep(step)}`]) {
		if (s === head) return ''
		if (s.startsWith(`${head} `)) return s.slice(head.length).trim()
	}
	return s
}
