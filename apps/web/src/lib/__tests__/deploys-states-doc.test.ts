// The states table in the Deploys docs lists exactly the deploy and app states the
// code defines (lib/deploy-status.ts, lib/app-health.ts), with the labels it shows.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_HEALTH, APP_STATES, UPTIME_FRESH_MS } from '../app-health'
import { DEPLOY_STATUS } from '../deploy-status'

const md = readFileSync(join(__dirname, '../../../content/docs/deploys.md'), 'utf8')
const section = md.slice(md.indexOf('\n## Deploy and app states'))
const tables = section
	.split(/\n\s*\n/)
	.filter((b) => b.trim().startsWith('|'))
	.map((b) =>
		b
			.trim()
			.split('\n')
			.slice(2)
			.map((l) =>
				l
					.split('|')
					.slice(1, -1)
					.map((c) => c.trim().replace(/^`|`$/g, '')),
			),
	)

describe('deploys.md states tables', () => {
	it('has the two tables', () => {
		expect(tables).toHaveLength(2)
	})
	it('deploy states and labels match DEPLOY_STATUS', () => {
		const rows = tables[0] ?? []
		expect(rows.map((r) => r[0])).toEqual(Object.keys(DEPLOY_STATUS))
		for (const r of rows) expect(r[1]).toBe(DEPLOY_STATUS[r[0] as keyof typeof DEPLOY_STATUS].label)
	})
	it('app states match APP_STATES, and every reason the code shows is named', () => {
		const rows = tables[1] ?? []
		expect(rows.map((r) => r[0])).toEqual([...APP_STATES])
		const text = rows.map((r) => r.join(' ')).join('\n').toLowerCase()
		for (const h of Object.values(APP_HEALTH)) {
			const reason = h.label.split(' · ')[1]
			if (reason === 'server unreachable') expect(section).toContain('unknown · server unreachable')
			else if (reason === 'queued') expect(text).toContain('deploying · queued')
			else if (reason === 'never deployed') expect(text).toContain('never deployed')
			else if (reason === 'docker not answering') expect(text).toContain('docker on it does not answer')
			else expect(reason).toBeUndefined()
		}
		expect(text).toContain(`within ${UPTIME_FRESH_MS / 60_000} minutes`)
	})
})
