// The worker waits for powder's pre-phase migrations before it starts its
// scheduler and claim loop. Both containers start together (docker-compose up,
// bin/self-deploy.sh and the dashboard self-deploy recreate both), but only the
// powder container applies the schema (docker/powder-entrypoint.sh, pre phase
// before it serves), so a new worker could otherwise run new code against the
// old schema for as long as that takes.
//
// Ready = the ledger (public.powder_deploy_migrations, bin/lib-migrations.sh)
// records every pre-phase file shipped in the worker's own image (every
// packages/db/drizzle/*.sql with the exact line `-- idempotent` and without
// `-- post-deploy`: the files the pre phase applies) and no fresh install is
// half done. Files without `-- idempotent` are never applied on boot, only
// recorded by hand or by --baseline; an install missing one of those does not
// boot powder at all, so they are not waited for. /api/health is not used: it answers 503 until the
// worker's own claim heartbeat is fresh, so waiting on it would never end.
// Bounded (POWDER_WORKER_MIGRATION_WAIT seconds, default 600): after that the
// worker logs the missing files and starts anyway, as it did before.

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { db, sql } from './db'

// Kept equal to bin/lib-migrations.sh (POWDER_LEDGER, POWDER_FRESH_MARKER,
// is_idempotent_file, is_post_deploy_file); a test compares them.
const FRESH_MARKER = '_fresh_install_in_progress'

const hasLine = (content: string, line: string) => content.split('\n').includes(line)

/** A file the pre phase applies: `-- idempotent` and not `-- post-deploy`. */
export function isPrePhaseMigration(content: string): boolean {
	return hasLine(content, '-- idempotent') && !hasLine(content, '-- post-deploy')
}

/** Pre-phase files of the image that the ledger does not record yet, in order. */
export function pendingPreMigrations(files: { name: string; content: string }[], recorded: Set<string>): string[] {
	return files
		.filter((f) => isPrePhaseMigration(f.content) && !recorded.has(f.name))
		.map((f) => f.name)
		.sort()
}

/** packages/db/drizzle of this image (the worker runs with cwd apps/web). */
function migrationsDir(): string {
	return resolve(process.cwd(), '../../packages/db/drizzle')
}

export function readMigrationFiles(dir: string): { name: string; content: string }[] {
	return readdirSync(dir)
		.filter((n) => n.endsWith('.sql'))
		.sort()
		.map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8') }))
}

/** The ledger's file names, or null when it cannot be read (no table yet, DB down). */
async function readLedger(): Promise<Set<string> | null> {
	try {
		const rows = (await db.execute(sql`SELECT file FROM public.powder_deploy_migrations`)) as unknown as Array<{ file: string }>
		return new Set(rows.map((r) => r.file))
	} catch {
		return null
	}
}

export interface WaitDeps {
	files: { name: string; content: string }[]
	readLedger: () => Promise<Set<string> | null>
	sleep: (ms: number) => Promise<void>
	now: () => number
	log: (msg: string) => void
}

/** Resolves true once the schema is ready, false when the bound ran out. */
export async function waitForPreMigrations(timeoutMs: number, intervalMs: number, deps: WaitDeps): Promise<boolean> {
	const start = deps.now()
	let lastLogged = Number.NEGATIVE_INFINITY
	let pending: string[] = []
	for (;;) {
		const ledger = await deps.readLedger()
		pending = ledger ? pendingPreMigrations(deps.files, ledger) : ['(migration ledger not readable yet)']
		if (ledger && !ledger.has(FRESH_MARKER) && pending.length === 0) {
			if (deps.now() - start > 0) deps.log(`[worker] schema ready after ${Math.round((deps.now() - start) / 1000)}s`)
			return true
		}
		if (ledger?.has(FRESH_MARKER)) pending = ['(fresh install in progress)', ...pending]
		const waited = deps.now() - start
		if (waited >= timeoutMs) {
			deps.log(
				`[worker] WARNING: gave up waiting for powder's pre-deploy migrations after ${Math.round(waited / 1000)}s; still missing: ${pending.slice(0, 10).join(', ')}${pending.length > 10 ? ` (+${pending.length - 10} more)` : ''}. Starting anyway: check docker logs powder.`,
			)
			return false
		}
		if (waited - lastLogged >= 30_000) {
			deps.log(
				`[worker] waiting for powder to apply pre-deploy migrations (${pending.length} pending: ${pending.slice(0, 5).join(', ')}${pending.length > 5 ? ', ...' : ''}); up to ${Math.round(timeoutMs / 1000)}s`,
			)
			lastLogged = waited
		}
		await deps.sleep(intervalMs)
	}
}

/** The worker's startup call: reads its image's files and the real ledger. */
export async function waitForSchema(): Promise<boolean> {
	const raw = Number(process.env.POWDER_WORKER_MIGRATION_WAIT)
	const timeoutMs = (Number.isFinite(raw) && raw >= 0 ? raw : 600) * 1000
	let files: { name: string; content: string }[]
	try {
		files = readMigrationFiles(migrationsDir())
	} catch (err) {
		console.warn(`[worker] no migration files at ${migrationsDir()}, not waiting for the schema:`, err instanceof Error ? err.message : err)
		return true
	}
	return waitForPreMigrations(timeoutMs, 2_000, {
		files,
		readLedger,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		now: Date.now,
		log: (m) => console.log(m),
	})
}
