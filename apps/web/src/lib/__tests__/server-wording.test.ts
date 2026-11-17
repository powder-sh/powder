import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// CONTRIBUTING.md: a machine powder manages is a "server", never a "box", in code,
// messages and docs. Scope: the docs, the dashboard source (tests excluded: their
// fixtures may name anything), the db package, the shipped shell scripts, the
// Docker files and the app template. Words that merely contain "box" (checkbox,
// sandbox, inbox, mailbox, textbox), CSS box-shadow / box-sizing / viewBox, "black
// box", the rule's own quote in CONTRIBUTING.md and the lucide `Box` icon component
// are not the word.

const REPO = resolve(__dirname, '../../../../..')

const FILES = [
	'README.md',
	'CONTRIBUTING.md',
	'SECURITY.md',
	'CHANGELOG.md',
	'CODE_OF_CONDUCT.md',
	'docs/SELF-HOSTING.md',
	'docs/SECURITY-COMPOSE.md',
	'docker-compose.yml',
	'docker-compose.dev.yml',
	'docker-compose.pin-report.yml',
	'docker-compose.shared-db.yml',
	'docker-compose.unharden.yml',
	'docker-compose.web-readonly.yml',
	'bin/install.sh',
	'bin/self-deploy.sh',
	'bin/server-bootstrap.sh',
	'bin/fleet-check.sh',
	'bin/db-init.sh',
	'bin/lib-migrations.sh',
	'infra/powder-image-prune.sh',
	'infra/powder-migrate',
	'infra/powder-resource-guard.sh',
]
const DIRS = ['apps/web/src', 'apps/web/content', 'apps/web/public', 'packages/db/src', 'packages/db/drizzle', 'docker', 'templates']
const TEXT = /\.(?:ts|tsx|mts|js|mjs|css|md|mdx|txt|sh|sql|ya?ml|json|example)$|Dockerfile$/

function walk(dir: string, out: string[]) {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === '.next' || name === '__tests__') continue
		const p = join(dir, name)
		if (statSync(p).isDirectory()) walk(p, out)
		else if (TEXT.test(name)) out.push(p)
	}
}

/** Lines that use "box" / "boxes" as a word, after the allowed forms are removed. */
function boxWordHits(text: string): number[] {
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

describe('"server", never "box"', () => {
	it('the matcher flags the word and passes the allowed forms', () => {
		for (const bad of ['ssh to the box', 'on every Box.', 'two boxes', 'BOX unreachable', 'the box-wide lock', "the box's disk"]) {
			expect(boxWordHits(bad), bad).toEqual([1])
		}
		for (const ok of [
			'a checkbox, a sandbox, an inbox, a mailbox, a textbox',
			'box-shadow: none; box-sizing: border-box;',
			'<svg viewBox="0 0 24 24">',
			'a black box to the user',
			"import { Box, Plus } from 'lucide-react'\n<EmptyState icon={Box} />\n{ icon: Box }\n<Box className=\"h-3\" />",
		]) {
			expect(boxWordHits(ok), ok).toEqual([])
		}
		// the lucide forms are allowed only where Box comes from lucide-react
		expect(boxWordHits('<EmptyState icon={Box} />')).toEqual([1])
	})

	it('no docs, source, script or Docker file uses the word', () => {
		const files = FILES.map((f) => join(REPO, f))
		for (const f of files) expect(existsSync(f), f).toBe(true)
		for (const d of DIRS) walk(join(REPO, d), files)
		expect(files.length).toBeGreaterThan(300)
		const bad: string[] = []
		for (const f of files) {
			for (const n of boxWordHits(readFileSync(f, 'utf8'))) bad.push(`${relative(REPO, f)}:${n}`)
		}
		expect(bad).toEqual([])
	})
})
