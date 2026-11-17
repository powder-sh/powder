// Display-only clean-up of a deploy log. The stored text keeps the
// `__POWDER_FAIL__ step=... code=...` trailer (lib/deploy-failure.ts parses it);
// the page shows the failed step and exit code in its own banner instead.

export function stripFailMarkers(text: string): string {
	return text.replace(/^[ \t]*__POWDER_FAIL__[^\n]*(\n|$)/gm, '')
}
