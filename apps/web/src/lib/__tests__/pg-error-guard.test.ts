import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// drizzle wraps pg errors in DrizzleQueryError (pg error on .cause), so a direct
// `.code === '23505'` never matches. All SQLSTATE checks go through pg-error.ts.
const ROOT = join(__dirname, '../../../../..')
const SQLSTATE_CMP = /\bcode\b\s*[!=]==?\s*['"][0-9A-Z]{5}['"]|['"][0-9A-Z]{5}['"]\s*[!=]==?\s*[\w.?)]*\.code\b/

function walk(dir: string, out: string[]) {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === '.next' || name === '__tests__') continue
		const p = join(dir, name)
		if (statSync(p).isDirectory()) walk(p, out)
		else if (/\.(ts|tsx)$/.test(name)) out.push(p)
	}
}

describe('pg error code authority', () => {
	it('no file compares .code against a SQLSTATE literal outside pg-error.ts', () => {
		const roots = [join(ROOT, 'apps/web/src')]
		for (const d of readdirSync(join(ROOT, 'packages'))) {
			const src = join(ROOT, 'packages', d, 'src')
			try {
				if (statSync(src).isDirectory()) roots.push(src)
			} catch {}
		}
		const files: string[] = []
		for (const r of roots) walk(r, files)
		expect(files.length).toBeGreaterThan(50)
		const bad: string[] = []
		for (const f of files) {
			if (f.endsWith('/pg-error.ts')) continue
			readFileSync(f, 'utf8')
				.split('\n')
				.forEach((line, i) => {
					if (SQLSTATE_CMP.test(line)) bad.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`)
				})
		}
		expect(bad, `use pgErrorCode/isPgError from lib/pg-error:\n${bad.join('\n')}`).toEqual([])
	})
})
