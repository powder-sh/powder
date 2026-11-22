// The "server", never "box" matcher (CONTRIBUTING.md), shared by server-wording.test.ts
// and compose-db-vars.test.ts (docker-compose.yml, which powder's test gate copy leaves out).

/** Lines that use "box" / "boxes" as a word, after the allowed forms are removed. */
export function boxWordHits(text: string): number[] {
	let t = text
		.replace(/\bbox-(?:shadow|sizing|decoration-break)\b|\b(?:border|content|padding)-box\b/gi, '')
		.replace(/\bblack box(?:es)?\b/gi, '')
		.replace('never "box"', '')
	if (/import\s*\{[^}]*\bBox\b[^}]*\}\s*from 'lucide-react'/.test(t)) {
		t = t
			.replace(/import\s*\{[^}]*\}\s*from 'lucide-react'/g, (m) => m.replace(/\bBox\b/g, ''))
			.replace(/icon=\{Box\}|icon: Box\b|<Box\b/g, '')
	}
	const hits: number[] = []
	t.split('\n').forEach((line, i) => {
		if (/\bbox(?:es)?\b/i.test(line)) hits.push(i + 1)
	})
	return hits
}
