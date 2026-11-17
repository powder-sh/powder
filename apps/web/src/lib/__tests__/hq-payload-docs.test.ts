import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// docs/SELF-HOSTING.md "Ops endpoint reporting" documents the POWDER_HQ_* payloads so
// anyone can write a receiver. Every fixed value lib/hq.ts sends must be in it.
const ROOT = resolve(__dirname, '../../../../..')
const hq = readFileSync(join(ROOT, 'apps/web/src/lib/hq.ts'), 'utf8')
const doc = readFileSync(join(ROOT, 'docs/SELF-HOSTING.md'), 'utf8')
const section = doc.slice(doc.indexOf('### Ops endpoint reporting'), doc.indexOf('## Special cases'))

describe('ops endpoint payload docs', () => {
	it('names every source, source_ref prefix and fixed value the code sends', () => {
		const sources = [...hq.matchAll(/const source = '([^']+)'/g)].map((m) => m[1])
		const refs = [
			...[...hq.matchAll(/ref\('([a-z-]+)'\)/g)].map((m) => m[1]),
			...[...hq.matchAll(/source_ref = `([a-z-]+):/g)].map((m) => m[1]),
		]
		const fixed = [...hq.matchAll(/\b(env|kind|channel|severity): '([^']+)'/g)].map((m) => `"${m[2]}"`)
		expect(sources.length).toBeGreaterThanOrEqual(3)
		expect(refs.length).toBeGreaterThanOrEqual(5)
		expect(fixed).toEqual(expect.arrayContaining(['"production"', '"deploy"', '"cron"', '"general"', '"warn"']))
		for (const v of [...sources, ...fixed]) expect(section, v).toContain(v as string)
		for (const r of refs) expect(section, r).toContain(`\`${r}:`)
	})

	it('lists every DeployEvent and CronEvent field', () => {
		for (const type of ['DeployEvent', 'CronEvent']) {
			const body = hq.slice(hq.indexOf(`export type ${type} = {`), hq.indexOf('\n}', hq.indexOf(`export type ${type} = {`)))
			const fields = [...body.matchAll(/^\t(\w+)\??:/gm)].map((m) => m[1])
			expect(fields.length).toBeGreaterThan(3)
			for (const f of fields) expect(section, `${type}.${f}`).toContain(`\`${f}\``)
		}
	})
})
