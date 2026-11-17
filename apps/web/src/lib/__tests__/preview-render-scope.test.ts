// a preview render holds only preview-scoped values, never production ones.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const rows = [
		{ key: 'DATABASE_URL', scope: 'production', valueEncrypted: 'postgres://prod' },
		{ key: 'API_KEY', scope: 'production', valueEncrypted: 'live_key' },
		{ key: 'API_KEY', scope: 'preview', valueEncrypted: 'test_key' },
		{ key: 'PREVIEW_ONLY', scope: 'preview', valueEncrypted: 'p' },
	]
	return { ...real, db: { select: () => ({ from: () => ({ where: async () => rows }) }) } }
})
vi.mock('../crypto', async (orig) => ({ ...((await orig()) as object), decryptSecret: (v: string) => v }))

import { renderEnvFile } from '../env-vars-db'

const body = (t: string) => t.split('\n').filter((l) => l && !l.startsWith('#'))

describe('renderEnvFile scopes', () => {
	it('preview renders only preview values', async () => {
		expect(body(await renderEnvFile('r1', 'preview'))).toEqual(['API_KEY=test_key', 'PREVIEW_ONLY=p'])
	})
	it('production renders only production values', async () => {
		expect(body(await renderEnvFile('r1', 'production'))).toEqual(['API_KEY=live_key', 'DATABASE_URL=postgres://prod'])
	})
	it('no deploy path renders the preview scope', () => {
		const runner = readFileSync(join(__dirname, '..', 'deploy-runner.ts'), 'utf8')
		expect(runner).toMatch(/prepareEnvFileForDeploy\(server, repo, 'production'/)
		expect(runner).not.toMatch(/prepareEnvFileForDeploy\([^)]*'preview'/)
	})
})
