// Static guard: direct reads of the columns that can carry raw secret text
// (deploys.output / error / error_summary, cron run output, cron last error,
// app_repos.repo_url) and whole-row selects of those tables. Every hit outside
// the allowlist fails, and an allowlist entry larger than the real count fails
// too, so the list can only shrink. Moving a reader behind lib/secret-text.ts
// (or deleting it) means lowering its number here in the same commit.
//
// Regenerate the numbers (only ever downward) with:
//   PRINT_RAW_READS=1 npx vitest run src/lib/__tests__/secret-raw-reads-guard.test.ts
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import ALLOW from './secret-raw-reads.allowlist.json'

const SRC = join(__dirname, '..', '..')

const PATTERNS: Record<string, RegExp> = {
	'deploy text column': /\bdeploys\.(?:output|error|errorSummary)\b/g,
	'cron run text column': /\bcronJobRuns\.(?:output|error)\b|\bcronJobs\.lastRunError\b/g,
	'repo_url column': /\bappRepos\.repoUrl\b/g,
	'whole-row deploys select': /select\(\)\s*\.from\(deploys\)/g,
	'whole-row cron runs select': /select\(\)\s*\.from\((?:cronJobRuns|cronJobs)\)/g,
	'whole-row app_repos select': /select\(\)\s*\.from\(appRepos\)/g,
}

function files(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (name === '__tests__' || name === 'node_modules') continue
		if (statSync(p).isDirectory()) out.push(...files(p))
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
	}
	return out
}

function scan(): Record<string, Record<string, number>> {
	const found: Record<string, Record<string, number>> = {}
	for (const f of files(SRC)) {
		const text = readFileSync(f, 'utf8')
		for (const [kind, re] of Object.entries(PATTERNS)) {
			const n = text.match(re)?.length ?? 0
			if (!n) continue
			(found[kind] ??= {})[relative(SRC, f)] = n
		}
	}
	return found
}

describe('raw secret-bearing reads: shrink-only allowlist', () => {
	const found = scan()
	if (process.env.PRINT_RAW_READS === '1') console.log(JSON.stringify(found, null, '\t'))
	const allow = ALLOW as Record<string, Record<string, number>>

	for (const kind of Object.keys(PATTERNS)) {
		it(`${kind}: no new readers`, () => {
			const extra = Object.entries(found[kind] ?? {})
				.filter(([f, n]) => n > (allow[kind]?.[f] ?? 0))
				.map(([f, n]) => `${f} (${n} > ${allow[kind]?.[f] ?? 0})`)
			expect(extra).toEqual([])
		})
		it(`${kind}: allowlist is not larger than reality (shrink it)`, () => {
			const stale = Object.entries(allow[kind] ?? {})
				.filter(([f, n]) => n > (found[kind]?.[f] ?? 0))
				.map(([f, n]) => `${f} (allowed ${n}, found ${found[kind]?.[f] ?? 0})`)
			expect(stale).toEqual([])
		})
	}
})
