import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const file = join(__dirname, '../../../../../infra/powder-migrate')
const src = readFileSync(file, 'utf8')

describe('powder-migrate', () => {
	it('parses under bash', () => {
		execFileSync('bash', ['-n', file])
	})
	it('uses a digest-pinned image, not a docker images grep', () => {
		expect(src).toMatch(/postgres:16-alpine@sha256:[0-9a-f]{64}/)
		expect(src).not.toContain("grep -iE 'pgvector|postgres'")
	})
	it('passes the DB URL by env name, never in argv', () => {
		expect(src).toContain('-e DBURL')
		expect(src).not.toMatch(/psql "\$DBURL"[^']*"\$@"; \}/)
		expect(src).not.toMatch(/"\$IMG" psql "\$DBURL"/)
	})
})
