import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathWithout } from './hermetic'
import { writeFakeDocker } from './fixtures/fake-docker'

const SCRIPT = resolve(__dirname, '../../../../../infra/powder-migrate')
const text = readFileSync(SCRIPT, 'utf8')
const SYS_PATH = pathWithout([])

const DOCKER = `#!/bin/bash
echo "[docker] $*" >> "$CALLS"
case "$1" in
  inspect)
    case "$*" in
      *project.config_files*) exit 0;;
      *'com.docker.compose.service'*) exit 0;;
      *Networks*) echo appnet;;
    esac; exit 0;;
  exec) echo "postgres://app:pw@db:5432/app"; exit 0;;
  image) exit 0;;
  run) echo "PSQL_RUN" >> "$CALLS"; cat >/dev/null; case "$*" in *"count(*) from _powder_migrations"*) echo 0;; esac; exit 0;;
esac
exit 0
`

function setup(layout: (apps: string, root: string) => void) {
	const root = mkdtempSync(join(tmpdir(), 'pm3-'))
	const stubs = join(root, 'stubs')
	const apps = join(root, 'apps')
	mkdirSync(stubs)
	mkdirSync(join(apps, 'demo'), { recursive: true })
	writeFakeDocker(stubs, DOCKER)
	layout(apps, root)
	const calls = join(root, 'calls.log')
	writeFileSync(calls, '')
	const r = spawnSync('bash', [SCRIPT, 'demo', 'status'], {
		env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, CALLS: calls, POWDER_APPS_DIR: apps, POWDER_MIGRATE_WORK_DIR: `${apps}-migwork` },
		encoding: 'utf8',
	})
	return { r, log: readFileSync(calls, 'utf8') }
}

describe('powder-migrate symlink refusal', () => {
	it('a symlinked .sql exits 1 and psql never runs', () => {
		const { r, log } = setup((apps, root) => {
			mkdirSync(join(apps, 'demo/src/drizzle'), { recursive: true })
			writeFileSync(join(root, 'secret'), 'SECRET')
			symlinkSync(join(root, 'secret'), join(apps, 'demo/src/drizzle/0099_x.sql'))
			writeFileSync(join(apps, 'demo/src/drizzle/0001.sql'), 'select 1;\n')
		})
		expect(r.status).toBe(1)
		expect(r.stdout).toContain('REFUSING')
		expect(log).not.toContain('PSQL_RUN')
	})
	it('a symlinked migrations dir exits 1 and psql never runs', () => {
		const { r, log } = setup((apps, root) => {
			mkdirSync(join(apps, 'demo/src'), { recursive: true })
			mkdirSync(join(root, 'elsewhere'))
			writeFileSync(join(root, 'elsewhere/0001.sql'), 'select 1;\n')
			symlinkSync(join(root, 'elsewhere'), join(apps, 'demo/src/drizzle'))
		})
		expect(r.status).toBe(1)
		expect(log).not.toContain('PSQL_RUN')
	})
	it('a symlinked src exits 1 and psql never runs', () => {
		const { r, log } = setup((apps, root) => {
			mkdirSync(join(root, 'victim/drizzle'), { recursive: true })
			writeFileSync(join(root, 'victim/drizzle/0001.sql'), 'select 1;\n')
			symlinkSync(join(root, 'victim'), join(apps, 'demo/src'))
		})
		expect(r.status).toBe(1)
		expect(r.stdout).toContain('symlink')
		expect(log).not.toContain('PSQL_RUN')
	})
	it('regular files still run', () => {
		const { r, log } = setup((apps) => {
			mkdirSync(join(apps, 'demo/src/drizzle'), { recursive: true })
			writeFileSync(join(apps, 'demo/src/drizzle/0001.sql'), 'select 1;\n')
		})
		expect(r.status).toBe(0)
		expect(log).toContain('PSQL_RUN')
		expect(r.stdout).toContain('PENDING: 0001.sql')
	})
})

describe('psql never sees the URL in argv', () => {
	it('the script text never passes the URL to psql', () => {
		expect(text).not.toContain('psql "$DBURL"')
		expect(text).toContain('exec psql -X -v ON_ERROR_STOP=1')
	})
	const prog = text.match(/<<'EOS' \|\| true\n([\s\S]*?)\nEOS\n/)?.[1] ?? ''
	function runProg(url: string) {
		const root = mkdtempSync(join(tmpdir(), 'pm3p-'))
		writeFileSync(join(root, 'psql'), '#!/bin/sh\nenv | grep -E "^PG" | sort\necho "ARGV:$*"\nenv | grep -c DBURL || true\n')
		chmodSync(join(root, 'psql'), 0o755)
		// The prog runs under busybox sh in postgres:16-alpine, whose printf %b decodes
		// \xHH. Host `sh` differs per server (bash on macOS, dash on Debian/Ubuntu, where %b
		// has no \x and the percent-decoding test failed): run it under bash everywhere.
		return spawnSync('bash', ['-c', prog, 'sh', '-tAc', 'select 1'] as string[], {
			env: { PATH: `${root}:${SYS_PATH}`, DBURL: url } as unknown as NodeJS.ProcessEnv,
			encoding: 'utf8',
		})
	}
	it('splits a plain URL into PG* vars', () => {
		const r = runProg('postgres://app:s3cret@db:5433/mydb?sslmode=require')
		expect(r.stdout).toContain('PGHOST=db')
		expect(r.stdout).toContain('PGPORT=5433')
		expect(r.stdout).toContain('PGUSER=app')
		expect(r.stdout).toContain('PGPASSWORD=s3cret')
		expect(r.stdout).toContain('PGDATABASE=mydb')
		expect(r.stdout).toContain('PGSSLMODE=require')
		expect(r.stdout).toContain('ARGV:-X -v ON_ERROR_STOP=1 -tAc select 1')
		expect(r.stdout).not.toContain('postgres://')
	})
	it('handles @ and percent-escapes in the password', () => {
		const r = runProg('postgresql://app:p%40ss%3Aw@rd@db.internal/app')
		expect(r.stdout).toContain('PGPASSWORD=p@ss:w@rd')
		expect(r.stdout).toContain('PGHOST=db.internal')
		expect(r.stdout).toContain('PGDATABASE=app')
	})
	it('rejects a non-postgres URL', () => {
		expect(runProg('mysql://a:b@h/d').status).toBe(1)
	})
})
