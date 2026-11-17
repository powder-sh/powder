// Guard: a dialog or action handler that sets a busy flag, awaits a request and then
// clears the flag must clear it on every path. Without try/finally (or a catch that
// clears it) a network failure throws past the reset: the flag stays set, buttons stay
// disabled and a confirm dialog cannot be closed.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const BUSY =
	/busy|saving|loading|pending|working|submitting|deleting|running|applying|removing|sending|testing|checking|connecting|refreshing|redirecting|restarting|deploying|importing|rollingback|searching/i

const indent = (l: string) => (l.match(/^\t*/) ?? [''])[0].length

/** `file:line setter` for every busy flag set before an await and cleared after it
 *  outside a finally (try/finally, .finally(), or a catch that clears it). Pure. */
function unguardedBusyResets(src: string, file = 'x.tsx'): string[] {
	const lines = src.split('\n')
	const out: string[] = []
	lines.forEach((line, i) => {
		const m = line.match(/\b(set[A-Z]\w*)\(([^()]*)\)\s*$/)
		if (!m) return
		const [, setter, value] = m as unknown as [string, string, string]
		if (/^(false|null|''|undefined)$/.test(value.trim())) return
		if (value.trim() !== 'true' && !BUSY.test(setter)) return
		const reset = new RegExp(`\\b${setter}\\((false|null)\\)`)
		let end = i + 1
		while (end < lines.length && ((lines[end] ?? '').trim() === '' || indent(lines[end] ?? '') >= indent(line))) end++
		const region = lines.slice(i + 1, end)
		const r = region.findIndex((l) => reset.test(l))
		if (r === -1) return
		const a = region.findIndex((l) => /\bawait\b/.test(l))
		if (a === -1 || a > r) return
		// a promise chain that clears it in .finally() is fine too
		if (region.some((l) => /\.finally\(/.test(l))) return
		const tried = region.slice(0, a + 1).some((l) => /\btry\s*\{/.test(l))
		const fin = region.some((l) => /\bfinally\b/.test(l))
		const c = region.findIndex((l) => /\bcatch\b/.test(l) && !/\.catch\(/.test(l))
		const caught = c !== -1 && region.slice(c).some((l) => reset.test(l))
		if (!(tried && (fin || caught))) out.push(`${file}:${i + 1} ${setter}`)
	})
	return out
}

describe('busy flags are cleared on every path', () => {
	it('flags an unguarded delete-server handler, passes a guarded one', () => {
		const old = [
			'\tasync function remove() {',
			'\t\tsetBusy(true)',
			"\t\tconst res = await fetch('/api/servers/s1', { method: 'DELETE' })",
			'\t\tsetBusy(false)',
			'\t\tif (!res.ok) return',
			'\t}',
		].join('\n')
		expect(unguardedBusyResets(old)).toEqual(['x.tsx:2 setBusy'])
		const fixed = [
			'\tasync function remove() {',
			'\t\tsetBusy(true)',
			'\t\ttry {',
			"\t\t\tconst res = await fetch('/api/servers/s1', { method: 'DELETE' })",
			'\t\t\tif (!res.ok) return',
			'\t\t} catch {',
			"\t\t\ttoast.error('delete failed: network error')",
			'\t\t} finally {',
			'\t\t\tsetBusy(false)',
			'\t\t}',
			'\t}',
		].join('\n')
		expect(unguardedBusyResets(fixed)).toEqual([])
	})

	it('no handler in app/ or components/ leaves a busy flag set when a request throws', () => {
		const root = join(__dirname, '..', '..')
		const files: string[] = []
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const p = join(dir, name)
				if (statSync(p).isDirectory()) walk(p)
				else if (/\.tsx$/.test(name)) files.push(p)
			}
		}
		walk(join(root, 'app'))
		walk(join(root, 'components'))
		const hits = files.flatMap((f) => unguardedBusyResets(readFileSync(f, 'utf8'), relative(root, f)))
		expect(hits).toEqual([])
	})
})
