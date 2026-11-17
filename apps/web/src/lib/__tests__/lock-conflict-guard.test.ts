import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Postgres logs every unique violation as an ERROR line, and a log
// scraper files those as DB errors (deploys_queued_unique on every push that
// landed mid-deploy). A lock built on a partial unique index
// (deploys_running_unique / deploys_queued_unique, app_backup_restores_running_unique,
// app_backups_in_flight_unique)
// must make its EXPECTED conflict silent at the source: INSERT ... ON CONFLICT DO
// NOTHING, or an UPDATE guarded by NOT EXISTS in the same statement. A 23505 catch
// may stay only as a fallback next to one of those, or for a genuine
// user-input duplicate listed below.

const ROOT = join(__dirname, '../../../../..')

// `file#function` → why a 23505 catch is allowed there. A fallback whose
// guarded statement lives in a helper names it in `guardedIn`.
const ALLOWED_23505: Record<string, { kind: 'fallback' | 'genuine'; why: string; guardedIn?: string }> = {
	'apps/web/src/lib/deploys.ts#startDeploy': { kind: 'fallback', why: 'insert uses onConflictDoNothing' },
	'apps/web/src/lib/deploys.ts#claimNextQueuedDeploy': {
		kind: 'fallback',
		why: 'queued -> running flip guarded by NOT EXISTS',
		guardedIn: 'claimInTx',
	},
	'apps/web/src/lib/deploys.ts#requeueClaimedDeploy': { kind: 'fallback', why: 'update guarded by NOT EXISTS' },
	'apps/web/src/lib/backup-restore.ts#insertRunning': { kind: 'fallback', why: 'insert uses onConflictDoNothing' },
	'apps/web/src/lib/backups.ts#runBackupForApp': { kind: 'fallback', why: 'insert uses onConflictDoNothing' },
	'apps/web/src/lib/app-domains.ts#isUniqueViolation': { kind: 'genuine', why: 'a user adding a hostname that exists' },
	'apps/web/src/app/api/servers/route.ts#POST': { kind: 'genuine', why: 'a user adding a server host that exists' },
}

function walk(dir: string, out: string[]) {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === '.next' || name === '__tests__') continue
		const p = join(dir, name)
		if (statSync(p).isDirectory()) walk(p, out)
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
	}
}

function sourceFiles(): string[] {
	const roots = [join(ROOT, 'apps/web/src')]
	for (const d of readdirSync(join(ROOT, 'packages'))) {
		const src = join(ROOT, 'packages', d, 'src')
		try {
			if (statSync(src).isDirectory()) roots.push(src)
		} catch {}
	}
	const files: string[] = []
	for (const r of roots) walk(r, files)
	return files
}

const TOP_LEVEL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|^(?:export\s+)?(?:const|let)\s+(\w+)/

// Split a file into top-level declarations (column-0 function / const).
function chunks(text: string): { name: string; body: string }[] {
	const out: { name: string; body: string }[] = []
	let cur = { name: '<module>', lines: [] as string[] }
	for (const line of text.split('\n')) {
		const m = TOP_LEVEL.exec(line)
		if (m) {
			out.push({ name: cur.name, body: cur.lines.join('\n') })
			cur = { name: m[1] ?? m[2] ?? '<anon>', lines: [] }
		}
		cur.lines.push(line)
	}
	out.push({ name: cur.name, body: cur.lines.join('\n') })
	return out
}

const CATCHES_23505 = /isPgError\([^)]*['"]23505['"]\)|pgErrorCode\([^)]*\)\s*[!=]==?\s*['"]23505['"]/
const SILENT = /\.onConflictDoNothing\(|\.onConflictDoUpdate\(|NOT EXISTS/
const LOCK_TABLES = /\.insert\((deploys|appBackupRestores|appBackups)\)/
const TERMINAL_ONLY = /status:\s*'(success|failed|download)'/
const LIVE_STATUS_SET = /\.set\(\{[^}]*status:\s*'(running|queued)'/

// One drizzle statement: from `.insert(x)` / `.update(x)` to its `.returning(`,
// the next statement (`await`) or the end of the function. The guard has to sit
// in the statement that writes, not in a sibling SELECT of the same function.
function statements(body: string, start: RegExp): string[] {
	const out: string[] = []
	const re = new RegExp(start.source, 'g')
	for (let m = re.exec(body); m; m = re.exec(body)) {
		const rest = body.slice(m.index + m[0].length)
		const end = /\.returning\(|\bawait\b|\n\}/.exec(rest)
		out.push(m[0] + (end ? rest.slice(0, end.index) : rest))
	}
	return out
}
const unsilentInserts = (body: string) =>
	statements(body, LOCK_TABLES).filter((st) => !SILENT.test(st) && !TERMINAL_ONLY.test(st))
const unguardedFlips = (body: string) =>
	statements(body, /\.update\(deploys\)/).filter((st) => LIVE_STATUS_SET.test(st) && !/NOT EXISTS/.test(st))

describe('lock conflicts are silent at the source', () => {
	const files = sourceFiles()
	const all = files.flatMap((f) => chunks(readFileSync(f, 'utf8')).map((c) => ({ key: `${relative(ROOT, f)}#${c.name}`, ...c })))

	const guardedBody = (key: string, helper?: string) =>
		all.find((x) => x.key === (helper ? `${key.split('#')[0]}#${helper}` : key))?.body

	it('scans the source tree', () => {
		expect(files.length).toBeGreaterThan(50)
		expect(all.some((c) => c.key === 'apps/web/src/lib/deploys.ts#startDeploy')).toBe(true)
	})

	it('every 23505 catch is allowlisted, and a fallback sits next to ON CONFLICT / NOT EXISTS', () => {
		const bad: string[] = []
		for (const c of all) {
			if (!CATCHES_23505.test(c.body)) continue
			const allow = ALLOWED_23505[c.key]
			if (!allow) bad.push(`${c.key}: catches 23505 - use ON CONFLICT DO NOTHING / a NOT EXISTS guard, or allowlist a genuine duplicate`)
			else if (allow.kind === 'fallback' && !SILENT.test(guardedBody(c.key, allow.guardedIn) ?? ''))
				bad.push(`${c.key}: allowlisted as a fallback but has no onConflictDoNothing / NOT EXISTS`)
		}
		expect(bad, bad.join('\n')).toEqual([])
	})

	it('the allowlist has no stale entries', () => {
		const keys = new Set(all.filter((c) => CATCHES_23505.test(c.body)).map((c) => c.key))
		expect(Object.keys(ALLOWED_23505).filter((k) => !keys.has(k))).toEqual([])
	})

	it('inserts into a lock table either cannot conflict (terminal status) or use ON CONFLICT', () => {
		const bad = all.filter((c) => unsilentInserts(c.body).length > 0).map((c) => c.key)
		expect(bad, `insert into a lock table without ON CONFLICT:\n${bad.join('\n')}`).toEqual([])
	})

	it('updates that move a deploy into running / queued are guarded by NOT EXISTS', () => {
		const bad = all.filter((c) => unguardedFlips(c.body).length > 0).map((c) => c.key)
		expect(bad, `unguarded status flip into a locked state:\n${bad.join('\n')}`).toEqual([])
	})

	it('the guard trips on a lock that relies on catching 23505', () => {
		const sample = [
			'export async function lockIt() {',
			'\ttry {',
			"\t\tawait db.insert(deploys).values({ status: 'queued' }).returning()",
			'\t} catch (err) {',
			"\t\tif (isPgError(err, '23505')) throw new Busy()",
			'\t}',
			'}',
			'export async function flip(id: string) {',
			"\tawait db.update(deploys).set({ status: 'queued' }).where(eq(deploys.id, id))",
			'}',
			'export async function claim() {',
			'\tconst [c] = await tx',
			'\t\t.select({ id: deploys.id })',
			'\t\t.from(deploys)',
			"\t\t.where(sql`NOT EXISTS (SELECT 1 FROM deploys r WHERE r.status = 'running')`)",
			'\tconst [row] = await tx',
			'\t\t.update(deploys)',
			"\t\t.set({ status: 'running' })",
			'\t\t.where(eq(deploys.id, c.id))',
			'\t\t.returning()',
			'}',
		].join('\n')
		const [, lockIt, flip, claim] = chunks(sample)
		expect(lockIt?.name).toBe('lockIt')
		expect(CATCHES_23505.test(lockIt?.body ?? '')).toBe(true)
		expect(ALLOWED_23505[`x#${lockIt?.name}`]).toBeUndefined()
		expect(unsilentInserts(lockIt?.body ?? '')).toHaveLength(1)
		expect(unguardedFlips(flip?.body ?? '')).toHaveLength(1)
		// NOT EXISTS only in the sibling SELECT does not cover the flip
		expect(claim?.body).toMatch(/NOT EXISTS/)
		expect(unguardedFlips(claim?.body ?? '')).toHaveLength(1)
		expect(unguardedFlips((claim?.body ?? '').replace('eq(deploys.id, c.id)', 'and(eq(deploys.id, c.id), sql`NOT EXISTS (...)`)'))).toEqual([])
	})
})
