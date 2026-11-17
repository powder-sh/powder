import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
	DROP_STALE_MS,
	type DbTarget,
	assertDroppable,
	assertRestoreTarget,
	buildDownloadCommands,
	buildDropCommand,
	buildRestorePollCommand,
	buildRestoreScript,
	dbNameFromUrl,
	isRestoreDbName,
	isStaleDrop,
	parseRestoreStatus,
	psqlCmd,
	restoreDatabaseUrl,
	restoreDbName,
	splitRestorePoll,
} from '../backup-restore-logic'

const AT = new Date('2026-11-04T09:07:00Z')
const DB: DbTarget = { container: 'shop-db', user: 'app', liveDb: 'app', withPassword: false }

function bashSyntaxOk(script: string) {
	const f = join(mkdtempSync(join(tmpdir(), 'powder-rst-')), 's.sh')
	writeFileSync(f, script)
	execFileSync('bash', ['-n', f]) // throws on a syntax error
}

describe('restore db names', () => {
	it('generates <db>_restore_<yyyymmdd_hhmm> in UTC', () => {
		expect(restoreDbName('app', AT)).toBe('app_restore_20261104_0907')
		expect(restoreDbName('app', AT, true)).toBe('app_restore_20261104_0907_verify')
	})

	it('lowercases and strips anything outside [a-z0-9_]', () => {
		expect(restoreDbName('My-App"; DROP', AT)).toBe('my_app___drop_restore_20261104_0907')
		expect(restoreDbName('---', AT)).toBe('____restore_20261104_0907')
		expect(restoreDbName('', AT)).toBe('db_restore_20261104_0907')
	})

	it('stays within the 63-char postgres identifier limit', () => {
		const n = restoreDbName('x'.repeat(200), AT, true)
		expect(n.length).toBeLessThanOrEqual(63)
		expect(n.endsWith('_restore_20261104_0907_verify')).toBe(true)
		expect(isRestoreDbName(n)).toBe(true)
	})

	it('generated names always validate', () => {
		for (const src of ['app', 'Shop-Prod', 'a'.repeat(80), 'é', "o'brien"]) {
			expect(isRestoreDbName(restoreDbName(src, AT))).toBe(true)
			expect(isRestoreDbName(restoreDbName(src, AT, true))).toBe(true)
		}
	})

	it('rejects anything that is not the restore pattern', () => {
		for (const bad of [
			'app',
			'postgres',
			'template1',
			'app_restore',
			'app_restore_2026110_0907',
			'app_restore_20261104_0907_x',
			'App_restore_20261104_0907',
			'app_restore_20261104_0907;drop',
			'app"_restore_20261104_0907',
			"app'_restore_20261104_0907",
			'app restore_20261104_0907',
			`${'a'.repeat(60)}_restore_20261104_0907`,
		]) {
			expect(isRestoreDbName(bad), bad).toBe(false)
		}
	})
})

describe('refusal guards', () => {
	it('never targets the live database', () => {
		expect(() => assertRestoreTarget('app', 'app')).toThrow(/not a restore database/)
		// A live db that itself matches the pattern (someone switched to a restore db).
		const live = 'app_restore_20261104_0907'
		expect(() => assertRestoreTarget(live, live)).toThrow(/live database/)
		expect(() => assertRestoreTarget(live.toUpperCase(), live)).toThrow()
		expect(assertRestoreTarget('app_restore_20261104_0907', 'app')).toBe(
			'app_restore_20261104_0907',
		)
	})

	it('drop needs the pattern, not the live db, not the DATABASE_URL db', () => {
		expect(() => assertDroppable('app', 'app', null)).toThrow()
		expect(() => assertDroppable('postgres', 'app', null)).toThrow()
		const r = 'app_restore_20261104_0907'
		expect(() => assertDroppable(r, r, null)).toThrow(/live database/)
		expect(() => assertDroppable(r, 'app', r)).toThrow(/DATABASE_URL/)
		expect(assertDroppable(r, 'app', 'app')).toBe(r)
		expect(() => buildDropCommand(DB, 'app', null)).toThrow()
		expect(() => buildDropCommand(DB, r, r)).toThrow()
	})

	it('restore script builder refuses a non-pattern or live target', () => {
		const base = {
			id: 'rst_1',
			mode: 'restore' as const,
			db: DB,
			passB64: 'cGFzcw==',
			urlB64: 'dXJs',
			sha256: null,
			preLines: [],
			statusFile: '/var/tmp/s',
			lockFile: '/var/tmp/l',
		}
		expect(() => buildRestoreScript({ ...base, target: 'app' })).toThrow()
		expect(() =>
			buildRestoreScript({
				...base,
				db: { ...DB, liveDb: 'app_restore_20261104_0907' },
				target: 'app_restore_20261104_0907',
			}),
		).toThrow()
		expect(() =>
			buildRestoreScript({
				...base,
				target: 'app_restore_20261104_0907',
				passB64: "x';rm -rf /;'",
			}),
		).toThrow(/base64/)
	})
})

describe('command builders quote everything', () => {
	const hostile: DbTarget = {
		container: 'shop-db',
		user: "u'; rm -rf / #",
		liveDb: 'a b$(id)',
		withPassword: true,
	}

	it('psqlCmd single-quotes container, user and db; password via env-file only', () => {
		const c = psqlCmd(hostile, "x'y", true)
		expect(c).toBe(
			`docker exec -i --env-file "$PGPASS_FILE" 'shop-db' psql -X -U 'u'\\''; rm -rf / #' -d 'x'\\''y' -v ON_ERROR_STOP=1`,
		)
		expect(() => psqlCmd({ ...DB, container: 'a;b' }, 'app')).toThrow(/unsafe/)
	})

	it('restore + drop + poll scripts parse, with hostile values quoted', () => {
		const target = restoreDbName(hostile.liveDb, AT)
		const s = buildRestoreScript({
			id: 'rst_x',
			mode: 'verify',
			db: hostile,
			target: restoreDbName(hostile.liveDb, AT, true),
			passB64: Buffer.from("p'a$s").toString('base64'),
			urlB64: Buffer.from('https://s3/x?a=1&b=2').toString('base64'),
			sha256: null,
			preLines: ['PGPASS_FILE=$(mktemp)'],
			statusFile: "/var/tmp/st'atus",
			lockFile: '/var/tmp/powder-restore-shop-db.lock',
		})
		bashSyntaxOk(s)
		expect(s).toContain(`STATUS_FILE='/var/tmp/st'\\''atus'`)
		expect(s).toContain(`LIVE='a b$(id)'`)
		expect(s).not.toContain('https://s3') // URL only travels base64'd into a 0600 file
		bashSyntaxOk(buildDropCommand(hostile, target, null))
		expect(buildDropCommand(hostile, target, null)).toContain(
			`'DROP DATABASE IF EXISTS "${target}"'`,
		)
		bashSyntaxOk(buildRestorePollCommand('rst_x'))
	})

	it('download commands quote the URL and use the real format (openssl -pbkdf2 | gunzip | psql)', () => {
		const url = "https://s3.example/b/shop/2026.sql.gz.enc?X-Amz-Signature=ab'c&x=1"
		const c = buildDownloadCommands({
			url,
			s3Key: 'shop/2026-11-04T09-07-00Z.sql.gz.enc',
			containerName: 'shop',
			sha256: 'f'.repeat(64),
			dbUser: 'app',
			dbContainer: 'shop-db',
			newDb: 'app_restore_20261104_0907',
		})
		expect(c).toContain(
			`curl -fSL -o 'shop-2026-11-04T09-07-00Z.sql.gz.enc' 'https://s3.example/b/shop/2026.sql.gz.enc?X-Amz-Signature=ab'\\''c&x=1'`,
		)
		expect(c).toContain('openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/root/backup.key')
		expect(c).toContain("| gunzip > 'shop-2026-11-04T09-07-00Z.sql'")
		expect(c).toContain('f'.repeat(64))
		expect(c).not.toContain('pg_restore -')
		bashSyntaxOk(c)
	})

	it('the dump is never loaded with psql on the host, only in a no-network throwaway container', () => {
		const c = buildDownloadCommands({
			url: 'https://s3.example/x',
			s3Key: 'shop/2026-11-04T09-07-00Z.sql.gz.enc',
			containerName: 'shop',
			sha256: null,
			dbUser: 'app',
			dbContainer: 'shop-db',
			newDb: 'app_restore_20261104_0907',
		})
		const cmds = c.split('\n').filter((l) => !l.startsWith('#'))
		// every psql / createdb line runs through docker (a throwaway or the app's db container)
		for (const l of cmds.filter((x) => /\b(psql|createdb)\b/.test(x))) expect(l).toMatch(/^docker (exec|run) /)
		expect(c).toContain('docker run -d --rm --name powder-dump-check --network none')
		expect(c).toContain(`-v "$PWD/"'shop-2026-11-04T09-07-00Z.sql':/w/dump.sql:ro`)
		expect(c).toContain('may contain psql')
		expect(c).toContain("powder's restore")
		bashSyntaxOk(c)
	})
})

describe('restore script behaviour (stubbed docker/curl/openssl)', () => {
	// Fake bin dir: docker logs every call; psql answers EXISTS for the
	// pg_database probe and fails when PSQL_FAIL is set on the restore stream.
	function run(
		mode: 'restore' | 'verify',
		env: Record<string, string> = {},
		sha: 'match' | 'mismatch' | 'none' = 'match',
		objectSize: number | null = null,
	) {
		const dir = mkdtempSync(join(tmpdir(), 'powder-rst-run-'))
		const log = join(dir, 'calls.log')
		const stub = (name: string, body: string) => {
			writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`)
			chmodSync(join(dir, name), 0o755)
		}
		stub(
			'docker',
			`echo "docker $*" >> ${JSON.stringify(log)}
case "$*" in
  *"FROM pg_database"*) [ -n "$EXISTS" ] && echo 1; exit 0 ;;
  *" -i "*) cat > /dev/null; [ -n "$PSQL_FAIL" ] && { echo "ERROR: boom" >&2; exit 3; }; exit 0 ;;
  *"count(*)"*) echo 12 ;;
  *"pg_database_size(current_database())"*) echo 4096 ;;
esac
exit 0`,
		)
		// The "encrypted" object (openssl is stubbed to cat): a fixed gzip of
		// SQL, written to curl's -o target.
		const obj = join(dir, 'object.bin')
		writeFileSync(obj, gzipSync(Buffer.from('SELECT 1;')))
		const objSha = createHash('sha256').update(readFileSync(obj)).digest('hex')
		stub(
			'curl',
			`echo "curl $*" >> ${JSON.stringify(log)}
cfg=; for a in "$@"; do [ "$prev" = -K ] && cfg=$a; prev=$a; done
[ -n "$cfg" ] && cat "$cfg" >> ${JSON.stringify(join(dir, 'curlcfg.log'))}
out=; while [ $# -gt 0 ]; do [ "$1" = -o ] && { out=$2; shift; }; shift; done
[ -n "$CURL_FAIL" ] && exit 22
if [ -n "$out" ]; then cat ${JSON.stringify(obj)} > "$out"; else cat ${JSON.stringify(obj)}; fi`,
		)
		stub('openssl', 'cat')
		stub('flock', 'exit 0')
		// df -Pk: free KiB from DF_FREE_KB (default plenty).
		stub(
			'df',
			'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/sda1 100000000 1 ${DF_FREE_KB:-99999999} 1% /var/tmp"',
		)
		const target = restoreDbName('app', AT, mode === 'verify')
		const statusFile = join(dir, 'status')
		const script = buildRestoreScript({
			id: 'rst_t',
			mode,
			db: DB,
			target,
			passB64: Buffer.from('k').toString('base64'),
			urlB64: Buffer.from('https://x').toString('base64'),
			sha256: sha === 'match' ? objSha : sha === 'mismatch' ? 'b'.repeat(64) : null,
			preLines: [],
			statusFile,
			lockFile: join(dir, 'lock'),
			objectSize,
		})
		const r = spawnSync('bash', ['-c', script], {
			encoding: 'utf8',
			timeout: 20_000,
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
		})
		const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
		const cfgLog = join(dir, 'curlcfg.log')
		const curlCfg = existsSync(cfgLog) ? readFileSync(cfgLog, 'utf8') : ''
		return {
			r,
			calls,
			curlCfg,
			status: parseRestoreStatus(readFileSync(statusFile, 'utf8')),
			target,
		}
	}

	it('restore: creates the new db, streams into it, keeps it, reports tables', () => {
		const { status, calls, target } = run('restore')
		expect(status).toMatchObject({ status: 'success', tables: 12, size: 4096 })
		expect(calls).toContain(`CREATE DATABASE "${target}"`)
		expect(calls).toContain(`-i shop-db psql -X -U app -d ${target} `)
		expect(calls).not.toContain('DROP DATABASE')
		// The live db is only the connection for CREATE/probe; nothing streams into it.
		expect(calls).not.toContain('-i shop-db psql -X -U app -d app ')
	})

	it('a sha256 mismatch fails before anything streams into psql', () => {
		const { status, calls, target } = run('restore', {}, 'mismatch')
		expect(status).toMatchObject({ status: 'failed', error: 'sha256_mismatch' })
		expect(calls).not.toContain(' -i ')
		// The db it created is dropped again.
		expect(calls).toContain(`DROP DATABASE IF EXISTS "${target}"`)
	})

	it('a matching sha256 restores', () => {
		const { status, r } = run('restore', {}, 'match')
		expect(status.status).toBe('success')
		expect(r.stdout).toContain('sha256 ok')
	})

	it('a row without sha256 still restores and says the check was skipped', () => {
		const { status, r } = run('restore', {}, 'none')
		expect(status.status).toBe('success')
		expect(r.stdout).toContain('integrity check skipped')
	})

	it('the presigned URL reaches curl through a -K config file, never argv', () => {
		const { status, calls, curlCfg } = run('restore')
		expect(status.status).toBe('success')
		const curlLine = calls.split('\n').find((l) => l.startsWith('curl ')) ?? ''
		expect(curlLine).toContain('-K')
		expect(curlLine).not.toContain('https://')
		expect(curlCfg).toBe('url = "https://x"\n')
	})

	it('a failed download fails clearly', () => {
		const { status, calls } = run('restore', { CURL_FAIL: '1' })
		expect(status).toMatchObject({ status: 'failed', error: 'download_failed' })
		expect(calls).not.toContain(' -i ')
	})

	it('not enough space on /var/tmp refuses before creating the db or downloading', () => {
		for (const mode of ['restore', 'verify'] as const) {
			// 10 MiB object needs 11264 KiB with headroom; 11000 KiB free is short.
			const { status, calls, r } = run(mode, { DF_FREE_KB: '11000' }, 'match', 10 * 1024 * 1024)
			expect(status).toMatchObject({ status: 'failed', error: 'not_enough_disk_space_on_var_tmp' })
			expect(r.stdout).toContain('not enough free space on /var/tmp')
			expect(calls).not.toContain('CREATE DATABASE')
			expect(calls).not.toMatch(/^curl /m)
		}
	})
	it('enough space (size + 10%) restores; unknown size skips the check', () => {
		const ok = run('restore', { DF_FREE_KB: '11300' }, 'match', 10 * 1024 * 1024)
		expect(ok.status.status).toBe('success')
		expect(ok.r.stdout).toContain('free space ok')
		const unknown = run('restore', { DF_FREE_KB: '1' }, 'match', null)
		expect(unknown.status.status).toBe('success')
		expect(unknown.r.stdout).toContain('free-space check skipped')
	})

	it('verify: drops the throwaway db before reporting success', () => {
		const { status, calls, target } = run('verify')
		expect(status.status).toBe('success')
		expect(calls).toContain(`DROP DATABASE "${target}"`)
	})

	it('refuses an existing target and drops nothing', () => {
		const { status, calls } = run('restore', { EXISTS: '1' })
		expect(status).toMatchObject({ status: 'failed', error: 'target_db_exists' })
		expect(calls).not.toContain('CREATE DATABASE')
		expect(calls).not.toContain('DROP DATABASE')
	})

	it('a failed stream fails the job and drops only the db it created', () => {
		const { status, calls, target } = run('restore', { PSQL_FAIL: '1' })
		expect(status).toMatchObject({ status: 'failed', error: 'decrypt_or_psql_failed' })
		const drops = calls.split('\n').filter((l) => l.includes('DROP DATABASE'))
		expect(drops).toHaveLength(1)
		expect(drops[0]).toContain(`"${target}"`)
	})
})

describe('restore download file', () => {
	const base = {
		id: 'rst_t',
		mode: 'restore' as const,
		db: DB,
		target: restoreDbName('app', AT),
		passB64: '',
		urlB64: '',
		preLines: [],
		statusFile: '/var/tmp/s',
		lockFile: '/var/tmp/l',
	}
	it('is a 0600 temp file, removed on exit', () => {
		const s = buildRestoreScript({ ...base, sha256: 'c'.repeat(64) })
		expect(s).toContain('DLFILE=$(mktemp -p /var/tmp')
		expect(s).toMatch(/chmod 600 [^\n]*"\$DLFILE"/)
		expect(s).toMatch(/rm -f [^\n]*"\$DLFILE"/)
	})
	it('rejects a sha256 that is not 64 hex', () => {
		expect(() => buildRestoreScript({ ...base, sha256: "x'; touch pwned" })).toThrow()
	})
})

describe('poll + status parsing', () => {
	it('splits liveness, status and log', () => {
		const out =
			'DEAD\n---powder-status---\nstatus=success\ntables=3\nsize=10\n---powder-log---\nline1\nline2\n'
		const p = splitRestorePoll(out)
		expect(p.alive).toBe(false)
		expect(parseRestoreStatus(p.status)).toMatchObject({ status: 'success', tables: 3, size: 10 })
		expect(p.log).toBe('line1\nline2\n')
	})

	it('ignores junk values', () => {
		expect(parseRestoreStatus('status=weird\ntables=abc\n')).toEqual({ status: null })
	})
})

describe('DATABASE_URL variant', () => {
	it('swaps only the database name', () => {
		expect(
			restoreDatabaseUrl(
				'postgres://app:s3cr@t@shop-db:5432/app?sslmode=disable',
				'app_restore_20261104_0907',
			),
		).toBe('postgres://app:s3cr%40t@shop-db:5432/app_restore_20261104_0907?sslmode=disable')
		expect(restoreDatabaseUrl(null, 'x')).toBeNull()
		expect(restoreDatabaseUrl('not a url', 'x')).toBeNull()
		expect(dbNameFromUrl('postgres://a:b@h:5432/app_restore_20261104_0907')).toBe(
			'app_restore_20261104_0907',
		)
		expect(dbNameFromUrl('postgres://a:b@h:5432')).toBeNull()
	})
})

describe('orphaned drop rows', () => {
	const now = Date.parse('2026-11-04T12:00:00Z')
	const row = (kind: string, status: string, msAgo: number) => ({
		kind,
		status,
		startedAt: new Date(now - msAgo),
	})

	it('a running drop past the stale limit is orphaned (powder restarted mid-call)', () => {
		expect(isStaleDrop(row('drop', 'running', DROP_STALE_MS + 1), now)).toBe(true)
	})

	it('leaves fresh drops, finished drops and restore/verify rows alone', () => {
		expect(isStaleDrop(row('drop', 'running', 60_000), now)).toBe(false)
		expect(isStaleDrop(row('drop', 'success', 3_600_000), now)).toBe(false)
		expect(isStaleDrop(row('drop', 'failed', 3_600_000), now)).toBe(false)
		expect(isStaleDrop(row('restore', 'running', 3_600_000), now)).toBe(false)
		expect(isStaleDrop(row('verify', 'running', 3_600_000), now)).toBe(false)
	})

	it('the stale limit stays well above the 60s inline drop SSH cap', () => {
		expect(DROP_STALE_MS).toBeGreaterThanOrEqual(5 * 60_000)
	})

	it('pollRestore fails stale drops before its restore/verify-only early return', () => {
		const src = readFileSync(join(__dirname, '../backup-restore.ts'), 'utf8')
		const body = src.slice(src.indexOf('export async function pollRestore'))
		const stale = body.indexOf('isStaleDrop(row')
		const early = body.indexOf("row.kind !== 'restore' && row.kind !== 'verify'")
		expect(stale).toBeGreaterThan(-1)
		expect(stale).toBeLessThan(early)
		expect(body.slice(stale, early)).toContain('failRow(')
	})
})
