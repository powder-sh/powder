// Guard: a fire-and-forget promise chain (`void p.finally(...)` or a bare
// `p.finally(...)` statement) must handle its rejection. `.finally()` passes a
// rejection through, so without a `.catch(` in the chain the derived promise
// rejects unhandled. That is how every failed deploy logged an unhandledRejection
// with its whole output (deploy-queue.ts runOnServer cleanup).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const indent = (l: string) => (l.match(/^\s*/) ?? [''])[0].length

/** `file:line` for every `.finally(` in a statement that is neither awaited,
 *  returned nor assigned, and has no `.catch(` in its chain. Pure. */
function floatingFinallies(src: string, file = 'x.ts'): string[] {
	const lines = src.split('\n')
	const out: string[] = []
	lines.forEach((line, i) => {
		if (!/\.finally\(/.test(line) || /^\s*(\/\/|\*)/.test(line)) return
		// a chained `.finally(` line: the statement starts at the nearest line above
		// it with a smaller indent
		let s = i
		if (/^\s*\./.test(line)) while (s > 0 && indent(lines[s] ?? '') >= indent(line)) s--
		const head = (lines[s] ?? '').trim()
		if (
			/^(await|return|yield)\b|^(const|let|var)\s|^[\w.[\]$]+\s*[+\-*/|&?]?=[^=>]|^export\s/.test(
				head,
			)
		)
			return
		// the statement runs to the line back at the start indent, plus trailing `.x` lines
		let e = i
		const base = indent(lines[s] ?? '')
		if (!/\)\s*;?\s*$/.test(line) || /\{\s*$/.test(line)) {
			while (e + 1 < lines.length && indent(lines[e + 1] ?? '') > base) e++
			if (e + 1 < lines.length) e++
		}
		while (e + 1 < lines.length && /^\s*\./.test(lines[e + 1] ?? '')) e++
		const stmt = lines.slice(s, e + 1).join('\n')
		if (!/\.catch\(/.test(stmt)) out.push(`${file}:${i + 1}`)
	})
	return out
}

describe('fire-and-forget .finally() chains handle their rejection', () => {
	it('flags an unhandled deploy-queue cleanup, passes handled chains', () => {
		const old = [
			'\tqueues.set(serverId, next)',
			'\tvoid next.finally(() => {',
			'\t\tif (queues.get(serverId) === next) queues.delete(serverId)',
			'\t})',
			'\treturn result',
		].join('\n')
		expect(floatingFinallies(old)).toEqual(['x.ts:2'])
		expect(floatingFinallies('\tload().finally(() => setBusy(false))')).toEqual(['x.ts:1'])
		const fixed = [
			'\tvoid next',
			'\t\t.finally(() => {',
			'\t\t\tcleanup()',
			'\t\t})',
			'\t\t.catch(() => {})',
			'\tvoid work()',
			"\t\t.catch((err) => console.error('x', err))",
			'\t\t.finally(() => rearm())',
			'\tvoid p.finally(() => done()).catch(() => {})',
			'\tconst q = p.finally(() => done())',
			'\tawait p.finally(() => done())',
			'\treturn p.finally(() => done())',
		].join('\n')
		expect(floatingFinallies(fixed)).toEqual([])
	})

	it('no source file floats a .finally() chain without a catch', () => {
		const webSrc = join(__dirname, '..', '..')
		const repo = join(webSrc, '..', '..', '..')
		const files: string[] = []
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				if (name === 'node_modules' || name === '__tests__') continue
				const p = join(dir, name)
				if (statSync(p).isDirectory()) walk(p)
				else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p)
			}
		}
		walk(webSrc)
		walk(join(repo, 'packages', 'db', 'src'))
		expect(files.length).toBeGreaterThan(100)
		const hits = files.flatMap((f) => floatingFinallies(readFileSync(f, 'utf8'), relative(repo, f)))
		expect(hits).toEqual([])
	})
})
