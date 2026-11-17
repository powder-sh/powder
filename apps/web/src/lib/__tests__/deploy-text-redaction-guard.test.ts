// guard: every API route that reads deploy text (deploys.output, deploys.error,
// deploys.error_summary) must pass it through the read-side redactor
// (redactNullable / redactSecrets / SecretStreamRedactor from lib/secret-text). A
// new route that returns deploy text raw fails here.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const APP = join(__dirname, '..', '..', 'app')

function files(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) out.push(...files(p))
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p)
	}
	return out
}

// Reads the deploys table (imports `deploys` from the db module) and touches its text.
const READS_DEPLOYS = /import\s*\{[^}]*\bdeploys\b[^}]*\}\s*from\s*'@\/lib\/db'/
const TOUCHES_TEXT = /deploys\.(output|error|errorSummary)\b|\b(d|row|r|cur|deploy|latest|last)\.(output|error|errorSummary)\b/
const REDACTOR = /\b(redactNullable|redactSecrets|SecretStreamRedactor)\b/
// raw SQL readers (`FROM deploys` in a sql`` / text query) that select the text
// columns: error_summary anywhere, or output / error as a selected column.
const RAW_READS_DEPLOYS = /\bFROM\s+deploys\b/i
const RAW_TOUCHES_TEXT = /\berror_summary\b|\b(?:\w+\.)?(?:output|error)\s*(?:,|\bAS\b|\n\s*FROM\b)/i
const readsDeployText = (src: string) =>
	(READS_DEPLOYS.test(src) && TOUCHES_TEXT.test(src)) ||
	(RAW_READS_DEPLOYS.test(src) && RAW_TOUCHES_TEXT.test(src))

describe('deploy text readers mask secrets', () => {
	const readers = files(APP).filter((f) => {
		const src = readFileSync(f, 'utf8')
		return readsDeployText(src)
	})
	it('finds the known readers (the scan works)', () => {
		const rel = readers.map((f) => relative(APP, f))
		for (const known of [
			'api/deploys/[deployId]/route.ts',
			'api/deploys/[deployId]/stream/route.ts',
			'api/projects/[id]/route.ts',
			'api/logs/search/route.ts',
			'api/internal/deploys/route.ts',
			'api/deploys-list/route.ts',
		])
			expect(rel).toContain(known)
	})
	it.each(files(APP).map((f) => [relative(APP, f), f]))('%s', (_rel, f) => {
		const src = readFileSync(f, 'utf8')
		if (!readsDeployText(src)) return
		expect(REDACTOR.test(src)).toBe(true)
	})
	it('the stream route masks chunks and errors in both modes', () => {
		const src = readFileSync(join(APP, 'api/deploys/[deployId]/stream/route.ts'), 'utf8')
		expect(src).not.toMatch(/send\('chunk', (row\.output|cur\.tail)\)/)
		expect(src).not.toMatch(/send\('error', (row|cur)\.error\)/)
	})
	it('log search cuts snippets from masked text', () => {
		const src = readFileSync(join(APP, 'api/logs/search/route.ts'), 'utf8')
		expect(src).not.toMatch(/extractSnippet\(r\.(error|output)/)
	})
})
