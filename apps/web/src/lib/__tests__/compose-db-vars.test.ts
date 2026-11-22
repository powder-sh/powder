import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boxWordHits } from './box-word'

// Every check on docker-compose.yml content. powder's test gate copy leaves that file out
// (TEST_GATE_PROTECTED in lib/deploy/fragments.ts), so .powder/test.sh skips this file
// there; a full checkout and bin/self-deploy.sh run it, and a missing file fails it.
const yml = readFileSync(join(__dirname, '../../../../../docker-compose.yml'), 'utf8')

describe('docker-compose.yml requires the DB credentials', () => {
	for (const v of ['POWDER_DB_USER', 'POWDER_DB_PASSWORD', 'POWDER_DB_NAME']) {
		it(`${v} has a :? guard`, () => {
			expect(yml).toContain(`\${${v}:?`)
			expect(yml).not.toContain(`\${${v}}`)
		})
	}
})

describe('docker-compose.yml passes the PostHog build-time variables', () => {
	it('both compose builds pass each as a build arg', () => {
		for (const v of ['NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_POSTHOG_HOST', 'NEXT_PUBLIC_POSTHOG_UI_HOST']) {
			expect(yml.split(`${v}: \${${v}:-}`).length - 1, v).toBe(2)
		}
	})
})

describe('docker-compose.yml says "server", never "box"', () => {
	it('no line uses the word (server-wording.test.ts covers the other files)', () => {
		expect(boxWordHits(yml)).toEqual([])
	})
})
