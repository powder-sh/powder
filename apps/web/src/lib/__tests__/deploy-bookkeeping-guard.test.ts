import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Class guard: after the swap in executeDeploy,
// every read or write to powder's own DB goes through recordAfterSwap (bounded retry,
// never throws), so a slow powder DB can not flip a live deploy to failed. A bare
// `await db.` or `await finishDeploy(` in the post-swap section fails this test.
const src = readFileSync(join(__dirname, '..', 'deploy-runner.ts'), 'utf8')
const START = '// ── post-swap: rebuildDeploy returned, the new container is live ──'
const END = '\n\t} finally {'

function postSwapSection(): string {
	const start = src.indexOf(START)
	expect(start, 'post-swap marker comment missing in deploy-runner.ts').toBeGreaterThan(0)
	const end = src.indexOf(END, start)
	expect(end).toBeGreaterThan(start)
	return src.slice(start, end)
}

describe('deploy-runner post-swap DB calls go through recordAfterSwap', () => {
	it('has no bare await on db or finishDeploy after the swap', () => {
		const section = postSwapSection()
		expect(section.match(/await\s+db\s*\./g) ?? []).toEqual([])
		expect(section.match(/await\s+finishDeploy\s*\(/g) ?? []).toEqual([])
	})
	it('every db./finishDeploy( call after the swap sits inside a recordAfterSwap callback', () => {
		const section = postSwapSection()
		const offenders: string[] = []
		for (const m of section.matchAll(/\b(db\s*\.\s*(select|update|insert|delete|execute|transaction)|finishDeploy\s*\()/g)) {
			// the call must be the callback of the nearest helper call (lateSuccessRetry wraps recordAfterSwap)
			const before = section.slice(Math.max(0, (m.index ?? 0) - 200), m.index)
			const helper = Math.max(before.lastIndexOf('recordAfterSwap('), before.lastIndexOf('lateSuccessRetry('))
			if (helper < 0 || !/^[^;]*=>\s*$/.test(before.slice(helper).replace(/\n/g, ' ').replace(/\{[^}]*\}\s*,?\s*$/, '')))
				offenders.push(section.slice(m.index, (m.index ?? 0) + 60))
		}
		expect(offenders).toEqual([])
	})
	it('the success-despite-DB-error branch requires the gate verdict', () => {
		expect(src).toMatch(/if \(gatePassed && server && isPowderDbError\(err\)/)
		expect(src).not.toMatch(/\bswapped && server && isPowderDbError/)
	})
})
