// The worker waits until the ledger records every pre-phase migration of its
// image (lib/migration-wait.ts), bounded, before it schedules or claims.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	isPrePhaseMigration,
	pendingPreMigrations,
	readMigrationFiles,
	waitForPreMigrations,
} from '../migration-wait'

const REPO = join(__dirname, '../../../../..')
const files = [
	{ name: '0001_old.sql', content: 'create table a();\n' },
	{ name: '0002_add.sql', content: '-- idempotent\nalter table a add column if not exists b int;\n' },
	{ name: '0003_drop.sql', content: '-- idempotent\n-- post-deploy\ndrop table if exists z;\n' },
	{ name: '0004_add.sql', content: '-- idempotent\ncreate table if not exists c();\n' },
]

function fakeClock(ledgers: Array<Set<string> | null>) {
	let t = 0
	let i = 0
	const logs: string[] = []
	return {
		logs,
		deps: {
			files,
			readLedger: async () => ledgers[Math.min(i++, ledgers.length - 1)] ?? null,
			sleep: async (ms: number) => {
				t += ms
			},
			now: () => t,
			log: (m: string) => logs.push(m),
		},
		reads: () => i,
	}
}

describe('pre-phase files', () => {
	it('idempotent and not post-deploy only', () => {
		expect(files.map((f) => isPrePhaseMigration(f.content))).toEqual([false, true, false, true])
		expect(pendingPreMigrations(files, new Set(['0002_add.sql']))).toEqual(['0004_add.sql'])
	})
	it('the markers match bin/lib-migrations.sh', () => {
		const lib = readFileSync(join(REPO, 'bin/lib-migrations.sh'), 'utf8')
		expect(lib).toContain("is_idempotent_file() { grep -qx -- '-- idempotent' \"$1\"; }")
		expect(lib).toContain("is_post_deploy_file() { grep -qx -- '-- post-deploy' \"$1\"; }")
		expect(lib).toContain('POWDER_FRESH_MARKER=_fresh_install_in_progress')
		expect(lib).toContain('POWDER_LEDGER=public.powder_deploy_migrations')
	})
	it("reads the repo's migrations, 0065 a pre-phase file", () => {
		const real = readMigrationFiles(join(REPO, 'packages/db/drizzle'))
		const f = real.find((x) => x.name.startsWith('0065_'))
		expect(f && isPrePhaseMigration(f.content)).toBe(true)
	})
})

describe('waitForPreMigrations', () => {
	it('waits while the table is missing and files are pending, then starts', async () => {
		const c = fakeClock([null, new Set(['0002_add.sql']), new Set(['0002_add.sql', '0004_add.sql'])])
		expect(await waitForPreMigrations(60_000, 2_000, c.deps)).toBe(true)
		expect(c.reads()).toBe(3)
		expect(c.logs[0]).toMatch(/waiting for powder to apply pre-deploy migrations/)
		expect(c.logs.at(-1)).toMatch(/schema ready after 4s/)
	})
	it('a half-done fresh install is not ready even with every file recorded', async () => {
		const all = new Set(['0002_add.sql', '0004_add.sql'])
		const c = fakeClock([new Set([...all, '_fresh_install_in_progress']), all])
		expect(await waitForPreMigrations(60_000, 2_000, c.deps)).toBe(true)
		expect(c.reads()).toBe(2)
	})
	it('bounded: gives up after the timeout, names what is missing, and starts', async () => {
		const c = fakeClock([new Set(['0002_add.sql'])])
		expect(await waitForPreMigrations(10_000, 2_000, c.deps)).toBe(false)
		expect(c.logs.at(-1)).toMatch(/gave up waiting .* after 10s; still missing: 0004_add\.sql/)
	})
	it('no wait and no log when the schema is already there', async () => {
		const c = fakeClock([new Set(['0002_add.sql', '0004_add.sql'])])
		expect(await waitForPreMigrations(10_000, 2_000, c.deps)).toBe(true)
		expect(c.logs).toEqual([])
	})
	it('the worker waits before the scheduler and the claim loop', () => {
		const src = readFileSync(join(__dirname, '../../worker.ts'), 'utf8')
		const wait = src.indexOf('await waitForSchema()')
		expect(wait).toBeGreaterThan(0)
		expect(wait).toBeLessThan(src.indexOf("startCronScheduler('worker')"))
		expect(wait).toBeLessThan(src.indexOf('\tscheduleClaim()\n\tselfHealTimer = setInterval'))
	})
})
