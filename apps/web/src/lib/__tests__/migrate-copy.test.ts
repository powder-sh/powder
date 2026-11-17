// powder-migrate checks the *.sql files, then (seconds of docker run psql
// calls later) runs them as root. A container with a writable bind over the
// migrations dir could swap a checked .sql for a link to another app's env file in
// between, so the script copies every .sql (never dereferenced) into a
// root-only work dir right after the checks and reads only the copies.
import { spawnSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeViolations, migrationDirPaths } from '../compose-safety'
import { writeFakeDocker } from './fixtures/fake-docker'

const SCRIPT = resolve(__dirname, '../../../../../infra/powder-migrate')

// The first `docker run` (the ledger create, after the checks) swaps the checked
// migration for a link to the secret, as a container with a writable bind could.
// Every psql run appends its stdin to the log, so the log holds what was fed to psql.
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
  run)
    if [ ! -e "$SWAPPED" ]; then
      : > "$SWAPPED"
      rm -f "$MIGDIR/0002_b.sql" && ln -s "$SECRET" "$MIGDIR/0002_b.sql"
    fi
    echo "PSQL_RUN" >> "$CALLS"; cat >> "$CALLS"
    case "$*" in *"count(*)"*) echo 0;; esac; exit 0;;
esac
exit 0
`

function run(mode: string) {
	const root = mkdtempSync(join(tmpdir(), 'pm12-'))
	const stubs = join(root, 'stubs')
	const apps = join(root, 'apps')
	const mig = join(apps, 'demo/src/drizzle')
	mkdirSync(stubs)
	mkdirSync(mig, { recursive: true })
	writeFakeDocker(stubs, DOCKER)
	writeFileSync(join(mig, '0001_a.sql'), 'select 1; -- A\n')
	writeFileSync(join(mig, '0002_b.sql'), 'select 2; -- B\n')
	const secret = join(root, 'victim.env')
	writeFileSync(secret, 'DATABASE_URL=SECRET_VICTIM_VALUE\n')
	const calls = join(root, 'calls.log')
	writeFileSync(calls, '')
	const work = join(root, 'migwork')
	const r = spawnSync('bash', [SCRIPT, 'demo', mode], {
		env: {
			...process.env,
			PATH: `${stubs}:${process.env.PATH}`,
			CALLS: calls,
			POWDER_APPS_DIR: apps,
			POWDER_MIGRATE_WORK_DIR: work,
			MIGDIR: mig,
			SECRET: secret,
			SWAPPED: join(root, 'swapped'),
		},
		encoding: 'utf8',
	})
	return { r, log: readFileSync(calls, 'utf8'), work }
}

describe('powder-migrate reads only copies', () => {
	it('a .sql swapped for a link after the check is never read', () => {
		const { r, log, work } = run('apply')
		expect(r.status, r.stdout + r.stderr).toBe(0)
		// the link really was planted during the run
		expect(log).toContain('PSQL_RUN')
		expect(log).not.toContain('SECRET_VICTIM_VALUE')
		// both checked migrations were applied from their copies, in order
		expect(log).toContain('select 1; -- A')
		expect(log).toContain('select 2; -- B')
		expect(log.indexOf('-- A')).toBeLessThan(log.indexOf('-- B'))
		expect(r.stdout).toContain('applying: 0001_a.sql')
		expect(r.stdout).toContain('applying: 0002_b.sql')
		// the work copy is removed on exit, the base stays root-only
		expect(readdirSync(work)).toEqual([])
		expect(existsSync(work)).toBe(true)
	})

	it('status mode lists the copies by their original names', () => {
		const { r } = run('status')
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('PENDING: 0001_a.sql')
		expect(r.stdout).toContain('PENDING: 0002_b.sql')
	})
})

describe('writable binds over a migrations dir', () => {
	const ctx = {
		appName: 'demo',
		projectDir: '/opt/apps/demo',
		migrationPaths: migrationDirPaths('/opt/apps/demo'),
		resolved: true,
	}
	const v = (vol: string) =>
		composeViolations(
			{ name: 'demo', services: { demo: { image: 'demo:latest', volumes: [vol] } } },
			ctx,
		).filter((x) => x.code === 'bind')
	it('refuses writable binds at or above a candidate dir', () => {
		expect(v('/opt/apps/demo/src/drizzle:/app/drizzle').length).toBe(1)
		expect(v('/opt/apps/demo/src/db:/app/db').length).toBe(1)
		expect(v('/opt/apps/demo/supabase:/x').length).toBe(1)
	})
	it('passes :ro, single files and unrelated folders', () => {
		expect(v('/opt/apps/demo/src/drizzle:/app/drizzle:ro')).toEqual([])
		expect(v('/opt/apps/demo/db/init.sql:/docker-entrypoint-initdb.d/init.sql')).toEqual([])
		expect(v('/opt/apps/demo/src/public:/app/public')).toEqual([])
		expect(v('/opt/apps/demo/pgdata:/var/lib/postgresql/data')).toEqual([])
	})
})
