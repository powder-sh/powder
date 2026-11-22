import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boxWordHits } from './box-word'

// CONTRIBUTING.md: a machine powder manages is a "server", never a "box", in code,
// messages and docs. Scope: the docs, the dashboard source (tests excluded: their
// fixtures may name anything), the db package, the shipped shell scripts, the
// Docker files and the app template. Words that merely contain "box" (checkbox,
// sandbox, inbox, mailbox, textbox), CSS box-shadow / box-sizing / viewBox, "black
// box", the rule's own quote in CONTRIBUTING.md and the lucide `Box` icon component
// are not the word. docker-compose.yml is checked in compose-db-vars.test.ts: powder's
// test gate copy leaves that file out (.powder/test.sh skips the tests that read it).

const REPO = resolve(__dirname, '../../../../..')

const FILES = [
	'README.md',
	'CONTRIBUTING.md',
	'SECURITY.md',
	'CHANGELOG.md',
	'CODE_OF_CONDUCT.md',
	'docs/SELF-HOSTING.md',
	'docs/SECURITY-COMPOSE.md',
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
