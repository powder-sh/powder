import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Needs a migrated scratch database (every file in packages/db/drizzle applied):
//   createdb powder_test && for f in packages/db/drizzle/*.sql; do psql -d powder_test -f $f; done
//   POWDER_TEST_DATABASE_URL=postgres:///powder_test pnpm -C apps/web test
// Skipped without it. Never point it at a real powder database: it writes rows.
const url = process.env.POWDER_TEST_DATABASE_URL
if (url) {
	process.env.DATABASE_URL = url
	process.env.POWDER_ENCRYPTION_KEY ??= 'ab'.repeat(32)
}

describe.skipIf(!url)('setForProject under concurrency (real postgres)', () => {
	// Imported lazily so DATABASE_URL is set before the pool is created.
	let m: typeof import('../env-vars-db')
	let d: typeof import('../db')
	let c: typeof import('../crypto')
	const repo = `rpo_race_${Date.now()}`
	// an admin session: this file is about concurrency, not the key policy
	const ctx = { userId: null, actorKind: 'system' as const, adminSession: true }

	beforeAll(async () => {
		d = await import('../db')
		m = await import('../env-vars-db')
		c = await import('../crypto')
	})
	afterAll(async () => {
		for (const t of ['app_env_vars', 'app_env_var_versions', 'app_env_var_audit']) {
			await d.db.execute(d.sql.raw(`DELETE FROM ${t} WHERE app_repo_id = '${repo}'`))
		}
	})

	const audit = (key: string) =>
		d.db
			.select()
			.from(d.appEnvVarAudit)
			.where(d.and(d.eq(d.appEnvVarAudit.appRepoId, repo), d.eq(d.appEnvVarAudit.key, key)))
	const versions = (key: string) =>
		d.db
			.select()
			.from(d.appEnvVarVersions)
			.where(d.and(d.eq(d.appEnvVarVersions.appRepoId, repo), d.eq(d.appEnvVarVersions.key, key)))

	it('concurrent first sets: exactly one create, the others are updates with history', async () => {
		const vals = ['a1', 'a2', 'a3', 'a4', 'a5']
		await Promise.all(vals.map((v) => m.setForProject(repo, 'RACE_NEW', v, 'production', ctx)))
		const a = await audit('RACE_NEW')
		expect(a.filter((r) => r.action === 'create')).toHaveLength(1)
		expect(a.filter((r) => r.action === 'update')).toHaveLength(4)
		const hist = (await versions('RACE_NEW')).map((r) => c.decryptSecret(r.valueEncrypted))
		expect(new Set(hist).size).toBe(4)
	})

	it('concurrent updates: every replaced value lands in the version history once', async () => {
		await m.setForProject(repo, 'RACE_UPD', 'v0', 'production', ctx)
		const vals = ['v1', 'v2', 'v3', 'v4', 'v5']
		await Promise.all(vals.map((v) => m.setForProject(repo, 'RACE_UPD', v, 'production', ctx)))
		const [cur] = await d.db
			.select()
			.from(d.appEnvVars)
			.where(d.and(d.eq(d.appEnvVars.appRepoId, repo), d.eq(d.appEnvVars.key, 'RACE_UPD')))
		if (!cur) throw new Error('no row')
		const final = c.decryptSecret(cur.valueEncrypted)
		const hist = (await versions('RACE_UPD')).map((r) => c.decryptSecret(r.valueEncrypted))
		// 5 replaced values (v0 plus four of v1..v5), each once, never the final one.
		expect(hist.sort()).toEqual(['v0', ...vals].filter((v) => v !== final).sort())
	})
})
