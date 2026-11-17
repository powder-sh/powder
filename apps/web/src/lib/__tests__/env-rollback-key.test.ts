// a rollback refuses a version of another key than the one in the URL.
// the history route uses the (already decoded) key as-is.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const decrypted: string[] = []
vi.mock('../db', () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: async () => [
			{
				id: 'v1',
				appRepoId: 'r1',
				key: 'OTHER_SECRET',
				scope: 'production',
				valueEncrypted: 'x',
				valuePreview: 'x',
			},
		],
	}
	const t = {}
	return {
		db: chain,
		and: () => 0,
		eq: () => 0,
		desc: () => 0,
		inArray: () => 0,
		sql: () => 0,
		createId: () => 'id',
		appEnvVarAudit: t,
		appEnvVarVersions: t,
		appEnvVars: t,
		appRepos: t,
		deploys: t,
		powderMeta: t,
		prefixes: t,
	}
})
vi.mock('../crypto', () => ({
	decryptSecret: (v: string) => {
		decrypted.push(v)
		return 'plain'
	},
	encryptSecret: (v: string) => v,
}))
import { rollbackToVersion } from '../env-vars-db'

describe('env rollback key check', () => {
	it('refuses a version of another key before decrypting it', async () => {
		await expect(rollbackToVersion('r1', 'v1', {} as never, 'API_KEY')).rejects.toThrow(
			'version not found for this key',
		)
		expect(decrypted).toEqual([])
	})
	it('the rollback route passes the URL key, the history route does not decode it again', () => {
		const dir = join(__dirname, '..', '..', 'app', 'api', 'projects', '[id]', 'env', '[key]')
		expect(readFileSync(join(dir, 'rollback', 'route.ts'), 'utf8')).toMatch(
			/rollbackToVersion\(id, body\.versionId, envWriteCtx\(req, user\), key\)/,
		)
		const history = readFileSync(join(dir, 'history', 'route.ts'), 'utf8')
		expect(history).toContain('listVersions(id, key, scope)')
		expect(history).not.toContain('decodeURIComponent')
	})
})
