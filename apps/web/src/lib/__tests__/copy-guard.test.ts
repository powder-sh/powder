import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('databases page copy() never falls back to the masked URL', () => {
	const src = readFileSync(join(__dirname, '../../app/(dashboard)/databases/page.tsx'), 'utf8')
	expect(src).not.toMatch(/writeText\(\(await loadFull\(\)\) \?\? url\)/)
	expect(src).toContain('nothing copied')
})
