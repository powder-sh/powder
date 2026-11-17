import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Server-component pages under (dashboard) run in parallel with the layout's
// redirect, so any that do work must call requirePageUser() before anything
// else. Client pages are fine: their data comes from gated API routes.
const root = join(__dirname, '../../app/(dashboard)')

function pages(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n)
		if (statSync(p).isDirectory()) return pages(p)
		return n === 'page.tsx' ? [p] : []
	})
}

describe('dashboard server pages gate before any work', () => {
	const server = pages(root).filter((f) => !/['"]use client['"]/.test(readFileSync(f, 'utf8')))
	it('finds the known server pages', () => {
		expect(server.length).toBeGreaterThanOrEqual(2)
	})
	for (const f of server) {
		it(`${f.slice(root.length)} calls requirePageUser first`, () => {
			const src = readFileSync(f, 'utf8')
			const gate = src.indexOf('await requirePageUser()')
			expect(gate).toBeGreaterThan(-1)
			const body = src.slice(src.indexOf('export default'))
			const bodyGate = body.indexOf('requirePageUser()')
			// No other await/db/redirect/query before the gate inside the component.
			const before = body.slice(0, bodyGate).replace(/await\s*$/, '')
			expect(before).not.toMatch(/await |db\.|redirect\(|listRepos/)
		})
	}
})
