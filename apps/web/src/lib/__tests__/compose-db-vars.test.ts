import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('docker-compose.yml requires the DB credentials', () => {
	const yml = readFileSync(join(__dirname, '../../../../../docker-compose.yml'), 'utf8')
	for (const v of ['POWDER_DB_USER', 'POWDER_DB_PASSWORD', 'POWDER_DB_NAME']) {
		it(`${v} has a :? guard`, () => {
			expect(yml).toContain(`\${${v}:?`)
			expect(yml).not.toContain(`\${${v}}`)
		})
	}
})
