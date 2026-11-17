import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFakeDocker } from './fixtures/fake-docker'

const SCRIPT = resolve(__dirname, '../../../../../infra/powder-migrate')

const DOCKER = `#!/bin/bash
echo "[docker] $*" >> "$CALLS"
case "$1" in
  inspect)
    case "$*" in
      *project.config_files*) echo "";;
      *Networks*) echo appnet;;
    esac; exit 0;;
  exec) echo "postgres://u:p@db/app"; exit 0;;
  image) exit 0;;
  run) cat >/dev/null
    case "$*" in *"count(*) from _powder_migrations"*) echo 0;; *"information_schema.tables"*) echo 0;; esac
    exit 0;;
esac
exit 0
`

function run(files: string[]) {
	const root = mkdtempSync(join(tmpdir(), 'pm-s6-'))
	const stubs = join(root, 'stubs')
	const apps = join(root, 'apps')
	mkdirSync(stubs)
	mkdirSync(join(apps, 'demo/src/drizzle'), { recursive: true })
	for (const f of files) writeFileSync(join(apps, 'demo/src/drizzle', f), 'select 1;\n')
	writeFakeDocker(stubs, DOCKER)
	const calls = join(root, 'calls.log')
	writeFileSync(calls, '')
	const r = spawnSync('bash', [SCRIPT, 'demo', 'apply'], {
		cwd: root,
		env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, CALLS: calls, POWDER_APPS_DIR: apps, POWDER_MIGRATE_WORK_DIR: `${apps}-migwork` },
		encoding: 'utf8',
	})
	return { root, out: r.stdout, status: r.status, log: readFileSync(calls, 'utf8') }
}

describe('powder-migrate filenames', () => {
	for (const bad of ["x'; select 1; --.sql", 'has space.sql', '$(touch pwned).sql', 'semi;colon.sql']) {
		it(`refuses ${JSON.stringify(bad)} before any SQL runs`, () => {
			const r = run(['0001.sql', bad])
			expect(r.status).toBe(1)
			expect(r.out).toContain('REFUSING migration filename')
			expect(r.log).not.toContain('insert into _powder_migrations')
			expect(r.log).not.toContain('-f -')
			expect(existsSync(join(r.root, 'pwned'))).toBe(false)
		})
	}
	it('a normal name is applied and recorded through psql -v b=... (never spliced into SQL)', () => {
		const r = run(['0001_init.sql', '0002.add-col.sql'])
		expect(r.status).toBe(0)
		expect(r.log).toContain('-v b=0001_init.sql')
		expect(r.log).toContain('-v b=0002.add-col.sql')
		expect(r.log).not.toMatch(/values \('0001/)
		expect(r.out).toContain('ran=2')
	})
})
