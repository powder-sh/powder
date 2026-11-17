import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { POSTGRES_TOOL_IMAGE_DEFAULT, isDigestPinned, postgresToolImage } from '../tool-images'

const D = '@sha256:' + 'a'.repeat(64)
const env = (v: Record<string, string>) => v as unknown as NodeJS.ProcessEnv
describe('postgres tool image authority', () => {
	it('the default is digest-pinned', () => {
		expect(isDigestPinned(POSTGRES_TOOL_IMAGE_DEFAULT)).toBe(true)
	})
	it('default, override, and unsafe override ignored', () => {
		expect(postgresToolImage(env({}))).toBe(POSTGRES_TOOL_IMAGE_DEFAULT)
		expect(postgresToolImage(env({ POWDER_PG_TOOL_IMAGE: `postgres:17-alpine${D}` }))).toBe(`postgres:17-alpine${D}`)
		expect(postgresToolImage(env({ POWDER_PG_TOOL_IMAGE: 'x; id' }))).toBe(POSTGRES_TOOL_IMAGE_DEFAULT)
		expect(isDigestPinned(`postgres:17-alpine${D}`)).toBe(true)
	})
	it('backups.ts and databases/route.ts take the image from the constant, no inline tag', () => {
		for (const f of ['../backups.ts', '../../app/api/databases/route.ts']) {
			const src = readFileSync(join(__dirname, f), 'utf8')
			expect(src).toContain('postgresToolImage()')
			expect(src).not.toMatch(/entrypoint (pg_dump|psql) postgres:/)
		}
	})
})
