import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOOT_SCHEMA_PUSH_ERE, RELEASE_SCHEMA_PUSH_ERE, SCHEMA_TOOL_ERE } from '../deploy/fragments'
import { migratePathScanShell, parseStabilityMarkers, stabilityMarkerFor } from '../deploy/stability'
import { writeFakeDocker } from './fixtures/fake-docker'

// The migrate-path scan runs right before powder-migrate: read-only, in a subshell
// behind `|| true`. It reports schema changes that bypass powder-migrate (stray
// *.sql files, a schema tool in the image command, the release label or the start
// script) and prints nothing it cannot finish. Run against fixture trees with a
// fake docker on PATH.

const NONCE = 'scan42'
const M = stabilityMarkerFor(NONCE)

type Opts = {
	files?: Record<string, string>
	/** image Cmd/Entrypoint JSON the fake docker prints; null = inspect fails */
	cmd?: string | null
	release?: string
	img?: string | null
	/** a `timeout` stub that reports a timeout (124) for find */
	findTimesOut?: boolean
	links?: Record<string, string>
	/** workdir layout: files go in the app dir itself, there is no src/ */
	workdir?: boolean
	/** body of a `find` stub that wraps the real find (the tree-walk call only) */
	find?: string
	/** extra shell run by the fake docker for `image inspect` before its answer */
	inspectHook?: string
	/** a `timeout` stub that enforces a 1 s cap (exit 124), standing in for GNU timeout */
	realTimeout?: boolean
}

// GNU-timeout stand-in (macOS has none): like GNU timeout it signals the command's
// whole process group, after 1 s here, and exits 124 on expiry.
const TIMEOUT_1S = `#!/bin/bash
shift
set -m
"$@" & p=$!
( sleep 1; kill -KILL -- -$p ) >/dev/null 2>&1 & w=$!
wait $p; rc=$?
kill $w 2>/dev/null
[ "$rc" = 137 ] && exit 124
exit "$rc"
`
const REAL_FIND = spawnSync('sh', ['-c', 'command -v find'], { encoding: 'utf8' }).stdout.trim()

function scan(o: Opts = {}) {
	const d = mkdtempSync(join(tmpdir(), 'mig-scan-'))
	const wd = join(d, 'app')
	const root = o.workdir ? wd : join(wd, 'src')
	mkdirSync(root, { recursive: true })
	for (const [f, body] of Object.entries(o.files ?? {})) {
		mkdirSync(dirname(join(root, f)), { recursive: true })
		writeFileSync(join(root, f), body)
	}
	for (const [f, to] of Object.entries(o.links ?? {})) {
		mkdirSync(dirname(join(wd, 'src', f)), { recursive: true })
		symlinkSync(to, join(wd, 'src', f))
	}
	const bin = join(d, 'bin')
	mkdirSync(bin)
	const cmd = o.cmd === undefined ? '["node","server.js"] null' : o.cmd
	writeFakeDocker(
		bin,
		`#!/bin/bash
case "$*" in "image inspect"*) ${o.inspectHook ?? ':'};; esac
case "$*" in
 *"json .Config.Cmd"*) ${cmd === null ? 'exit 1' : `printf '%s' '${cmd}'`};;
 *powder.release.cmd*) ${cmd === null ? 'exit 1' : `printf '%s' '${o.release ?? '<no value>'}'`};;
esac
exit 0
`,
	)
	if (o.find)
		writeFileSync(join(bin, 'find'), `#!/bin/bash\ncase "$*" in *"-maxdepth 6"*) ${o.find};; esac\nexec ${REAL_FIND} "$@"\n`, { mode: 0o755 })
	if (o.realTimeout) writeFileSync(join(bin, 'timeout'), TIMEOUT_1S, { mode: 0o755 })
	if (o.findTimesOut)
		writeFileSync(join(bin, 'timeout'), '#!/bin/bash\nshift\n[ "$1" = find ] && exit 124\nexec "$@"\n', { mode: 0o755 })
	const img = o.img === undefined ? 'demo:latest' : o.img
	const body = `set -e; IMGREF=${img === null ? '' : `'${img}'`}; S=keep; F=keep; ${migratePathScanShell(NONCE, wd)}echo "after S=$S F=$F rc=$?"`
	const r = spawnSync('bash', ['-c', body], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
	return { rc: r.status, out: r.stdout, d, m: parseStabilityMarkers(r.stdout, NONCE).migratePath }
}

describe('migrate-path scan', () => {
	it('clean app (migrations in a powder-migrate folder): ok', () => {
		const r = scan({ files: { 'drizzle/0001_init.sql': 'x', 'package.json': '{"scripts":{"start":"next start"}}' } })
		expect(r.m).toEqual([])
		expect(r.out).toContain(`${M} migrate-path ok`)
		expect(r.out).not.toContain('WARNING')
	})
	it('no migrations at all: ok', () => {
		expect(scan().m).toEqual([])
	})
	it('numbered *.sql outside the folders, none inside: stray-sql, with the path', () => {
		const r = scan({ files: { 'sql/0001_init.sql': 'x' } })
		expect(r.m).toEqual(['stray-sql'])
		expect(r.out).toContain('[migrate-path] WARNING: *.sql migration files (e.g. sql/0001_init.sql)')
	})
	it('prisma migrations are stray-sql too (powder-migrate does not read them)', () => {
		expect(scan({ files: { 'prisma/migrations/20240101_init/migration.sql': 'x' } }).m).toEqual(['stray-sql'])
	})
	it('a powder-migrate folder with *.sql wins over stray files', () => {
		expect(scan({ files: { 'sql/0001_init.sql': 'x', 'db/migrations/0001.sql': 'x' } }).m).toEqual([])
	})
	it('dependencies, build output, test fixtures, non-migration names and deep files do not count', () => {
		const r = scan({
			files: {
				'node_modules/pkg/migrations/0001.sql': 'x',
				'dist/migrations/0001.sql': 'x',
				'test/fixtures/0001_x.sql': 'x',
				'packages/db/__tests__/migrations/0001.sql': 'x',
				'docker/init.sql': 'x',
				'seed.sql': 'x',
				'a/b/c/d/e/f/migrations/0001.sql': 'x',
			},
		})
		expect(r.m).toEqual([])
	})
	it('schema tool in the image command: boot-cmd', () => {
		for (const cmd of [
			'["sh","-c","npx drizzle-kit push && node server.js"] null',
			'["npx","prisma","migrate","deploy"] null',
			'null ["sh","-c","npm run db:migrate && node server.js"]',
			'["sh","-c","node scripts/migrate.mjs && node server.js"] null',
			'["sh","-c","npx drizzle-kit push --force"] null',
		]) {
			expect(scan({ cmd }).m).toEqual(['boot-cmd'])
		}
	})
	it('schema push in powder.release.cmd: release-cmd', () => {
		for (const release of [
			'npx drizzle-kit push --force',
			'npx drizzle-kit push',
			'./node_modules/.bin/drizzle-kit push --force',
			'npx prisma db push',
			'prisma db push --accept-data-loss',
			'npm run db:push',
		]) {
			const r = scan({ release })
			expect(r.m, release).toEqual(['release-cmd'])
			expect(r.out).toContain('[migrate-path] WARNING: the powder.release.cmd label runs a schema push')
		}
	})
	it('a ledgered migrator in powder.release.cmd is the supported path: no case, ok', () => {
		for (const release of [
			'npx knex migrate:latest',
			'knex migrate:latest --knexfile dist/knexfile.js',
			'npx prisma migrate deploy',
			'node node_modules/prisma/build/index.js migrate deploy',
			'yarn migrate',
			'npm run db:migrate',
			'node dist/scripts/migrate.js',
			'npx drizzle-kit migrate',
		]) {
			const r = scan({ release })
			expect(r.m, release).toEqual([])
			expect(r.out).toContain(`${M} migrate-path ok`)
			expect(r.out).not.toContain('WARNING')
		}
	})
	it('a ledgered migrator in powder.release.cmd owns the app SQL: stray *.sql files are no stray-sql', () => {
		// common shapes: a node script, prisma in a workspace package, a tsx script, knex
		for (const [release, f] of [
			['node scripts/migrate.mjs', 'supabase/migrations/086_x.sql'],
			['cd packages/db && pnpm exec prisma migrate deploy', 'packages/db/prisma/migrations/20260620160000_x/migration.sql'],
			['npx tsx src/scripts/migrate.ts', 'src/db/migrations-x/0001_x.sql'],
			['npx knex migrate:latest', 'sql/0001_init.sql'],
		] as const) {
			const r = scan({ release, files: { [f]: 'x' } })
			expect(r.m, release).toEqual([])
			expect(r.out).toContain(`${M} migrate-path ok`)
			expect(r.out).not.toContain('WARNING')
		}
	})
	it('stray *.sql still warns when the release label is a push, no migrator, absent or unreadable', () => {
		const files = { 'sql/0001_init.sql': 'x' }
		for (const release of ['npx drizzle-kit push --force', 'npx prisma db push', 'npm run db:push'])
			expect(scan({ release, files }).m, release).toEqual(['stray-sql', 'release-cmd'])
		for (const release of ['node scripts/warm-cache.js', '<no value>', ''])
			expect(scan({ release, files }).m, release).toEqual(['stray-sql'])
		// a migrator at boot instead of in the label does not own the SQL either
		expect(scan({ cmd: '["sh","-c","node scripts/migrate.mjs && node server.js"] null', files }).m).toEqual(['stray-sql', 'boot-cmd'])
		expect(scan({ cmd: null, files }).m).toEqual(['stray-sql'])
		expect(scan({ img: null, files }).m).toEqual(['stray-sql'])
	})
	it('the same migrator at container start still warns (boot-cmd, start-script)', () => {
		expect(scan({ cmd: '["sh","-c","npx knex migrate:latest && node server.js"] null' }).m).toEqual(['boot-cmd'])
		const pkg = '{"scripts":{"start":"tsx src/scripts/migrate.ts && next start"}}'
		expect(scan({ files: { 'package.json': pkg }, release: 'npx knex migrate:latest' }).m).toEqual(['start-script'])
	})
	it('schema tool in package.json start: start-script; several cases at once', () => {
		const pkg = '{\n  "scripts": {\n    "start": "drizzle-kit migrate && next start"\n  }\n}\n'
		expect(scan({ files: { 'package.json': pkg } }).m).toEqual(['start-script'])
		const all = scan({ files: { 'package.json': pkg, 'sql/0002_x.sql': 'x' }, release: 'yarn db:push' })
		expect(all.m).toEqual(['stray-sql', 'release-cmd', 'start-script'])
	})
	it('plain commands are not schema tools', () => {
		const r = scan({
			cmd: '["node","server.js"] ["docker-entrypoint.sh"]',
			release: 'node scripts/warm-cache.js',
			files: { 'package.json': '{"scripts":{"start":"node server.js","migrate":"x"}}' },
		})
		expect(r.m).toEqual([])
	})
	it('docker inspect failing or no image: unknown (no marker), unless something was found', () => {
		expect(scan({ cmd: null }).m).toBeNull()
		expect(scan({ img: null }).m).toBeNull()
		expect(scan({ cmd: null, files: { 'sql/0001_init.sql': 'x' } }).m).toEqual(['stray-sql'])
		expect(scan({ cmd: null }).out).not.toContain(M)
	})
	it('find timing out: unknown', () => {
		const r = scan({ findTimesOut: true, files: { 'sql/0001_init.sql': 'x' } })
		expect(r.m).toBeNull()
		expect(r.rc).toBe(0)
	})
	it('find failing for another reason (permission denied, I/O error): unknown, never ok', () => {
		const r = scan({ find: 'echo "find: ./x: Permission denied" >&2; exit 1' })
		expect(r.m).toBeNull()
		expect(r.out).not.toContain(M)
		expect(r.rc).toBe(0)
		// a hit it printed before failing still counts
		expect(scan({ find: 'echo "$3/sql/0001_init.sql"; exit 1' }).m).toEqual(['stray-sql'])
	})
	it('workdir layout (no src/): the app dir is not walked, a dated dump is no stray-sql, result unknown', () => {
		const r = scan({ workdir: true, files: { 'backups/20240101-dump.sql': 'x', 'data/0001_x.sql': 'x' } })
		expect(r.m).toBeNull()
		expect(r.out).not.toContain('WARNING')
		// the image checks still report what they find
		expect(scan({ workdir: true, release: 'npx prisma db push' }).m).toEqual(['release-cmd'])
	})
	it('a hanging find is cut off by timeout: unknown, rc=0, fast', () => {
		const t = Date.now()
		const r = scan({ realTimeout: true, find: 'sleep 30', files: { 'sql/0001_init.sql': 'x' } })
		expect(r.m).toBeNull()
		expect(r.rc).toBe(0)
		expect(Date.now() - t).toBeLessThan(15_000)
	})
	it('a failing or hanging docker image inspect: unknown, rc=0', () => {
		expect(scan({ inspectHook: 'echo boom >&2; exit 1' }).m).toBeNull()
		const t = Date.now()
		const r = scan({ realTimeout: true, inspectHook: 'sleep 30' })
		expect(r.m).toBeNull()
		expect(r.rc).toBe(0)
		expect(Date.now() - t).toBeLessThan(15_000)
	})
	it('200k lines of find output: handled, one finding, rc=0', () => {
		const r = scan({ find: 'for i in $(seq 1 200000); do echo "/x/y/file$i.sql"; done; echo "$3/sql/0001_x.sql"; exit 0' })
		expect(r.rc).toBe(0)
		expect(r.m).toEqual(['stray-sql'])
	})
	it('a path with shell syntax is data: nothing runs, the logged path is sanitised', () => {
		const r = scan({ files: { 'we ird$(touch PWNED)/0001_x.sql': 'x' } })
		expect(r.m).toEqual(['stray-sql'])
		expect(existsSync(join(r.d, 'PWNED'))).toBe(false)
		expect(spawnSync('find', [r.d, '-name', 'PWNED'], { encoding: 'utf8' }).stdout.trim()).toBe('')
		expect(r.out).toContain('(e.g. weirdtouchPWNED/0001_x.sql)')
	})
	it('a symlinked migrations folder (powder-migrate refuses it) or package.json: unknown', () => {
		expect(scan({ links: { drizzle: '/etc' } }).m).toBeNull()
		expect(scan({ links: { 'package.json': '/etc/hosts' } }).m).toBeNull()
	})
	it('never fails the script and leaks no variable', () => {
		for (const o of [{}, { cmd: null }, { findTimesOut: true }, { files: { 'sql/0001_init.sql': 'x' } }] as Opts[]) {
			const r = scan(o)
			expect(r.rc).toBe(0)
			expect(r.out).toContain('after S=keep F=keep rc=0')
		}
	})
	it('no nonce: no scan at all; generated shell passes bash -n', () => {
		expect(migratePathScanShell('', '/opt/apps/demo')).toBe('')
		execFileSync('bash', ['-n'], { input: `${migratePathScanShell(NONCE, "/opt/apps/de'mo")} true` })
	})
})

describe('RELEASE_SCHEMA_PUSH_ERE (push-style tools only)', () => {
	const hit = (s: string) => spawnSync('grep', ['-qE', RELEASE_SCHEMA_PUSH_ERE], { input: s }).status === 0
	it('extends the boot-push pattern; boot-cmd still sees the drizzle and prisma pushes', () => {
		expect(RELEASE_SCHEMA_PUSH_ERE.startsWith(`${BOOT_SCHEMA_PUSH_ERE}|`)).toBe(true)
		for (const s of ['drizzle-kit push', 'drizzle-kit push --force', 'prisma db push'])
			expect(spawnSync('grep', ['-qE', SCHEMA_TOOL_ERE], { input: s }).status, s).toBe(0)
	})
	it('matches pushes, not ledgered migrators', () => {
		for (const s of ['drizzle-kit push', '"drizzle-kit","push"', 'prisma db push', 'prisma db push --accept-data-loss', 'npm run db:push'])
			expect(hit(s), s).toBe(true)
		for (const s of ['knex migrate:latest', 'prisma migrate deploy', 'drizzle-kit migrate', 'yarn migrate', 'node ./migrate.js', 'sequelize db:migrate'])
			expect(hit(s), s).toBe(false)
	})
})

describe('SCHEMA_TOOL_ERE (one authority with the bridge boot-push check)', () => {
	const hit = (s: string, ere = SCHEMA_TOOL_ERE) => spawnSync('grep', ['-qE', ere], { input: s }).status === 0
	it('extends the boot-push pattern', () => {
		expect(SCHEMA_TOOL_ERE.startsWith(`${BOOT_SCHEMA_PUSH_ERE}|`)).toBe(true)
		for (const s of ['drizzle-kit push --force', 'prisma db push --accept-data-loss']) {
			expect(hit(s, BOOT_SCHEMA_PUSH_ERE)).toBe(true)
			expect(hit(s)).toBe(true)
		}
	})
	it('matches migrate-style commands only', () => {
		for (const s of [
			'"drizzle-kit","migrate"',
			'prisma migrate deploy',
			'knex migrate:latest',
			'typeorm migration:run',
			'sequelize db:migrate',
			'pnpm run db:migrate',
			'yarn migrate',
			'bun run migrate:prod',
			'node ./migrate.js',
			'sh /app/migrations.sh',
		])
			expect(hit(s), s).toBe(true)
		for (const s of ['next start', 'node server.js', 'prisma generate', 'drizzle-kit generate', 'npm run build', 'node dist/index.js'])
			expect(hit(s), s).toBe(false)
	})
})
