import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('node base images', () => {
	it('docker/web.Dockerfile uses node:22 on every FROM node line (node:20 is EOL)', () => {
		const df = readFileSync(join(__dirname, '../../../../../docker/web.Dockerfile'), 'utf8')
		const froms = df.split('\n').filter((l) => /^FROM node:/.test(l))
		expect(froms.length).toBeGreaterThanOrEqual(2)
		for (const l of froms) expect(l).toMatch(/^FROM node:22-/)
	})
})
