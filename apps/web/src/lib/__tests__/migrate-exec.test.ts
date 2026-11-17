// powder-migrate refuses a pending migration with a psql meta-command that runs a
// program (`\!`, `\o |`, `\g |`, `\w |`, `\copy ... program`, `\e`, a backquote) before
// any migration runs. Plain SQL passes.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
      *project.config_files*) exit 0;;
      *'com.docker.compose.service'*) exit 0;;
      *Networks*) echo appnet;;
    esac; exit 0;;
  exec) echo "postgres://app:pw@db:5432/app"; exit 0;;
  image) exit 0;;
  run) echo "PSQL_RUN" >> "$CALLS"; cat >> "$CALLS"; case "$*" in *"count(*)"*) echo 0;; esac; exit 0;;
esac
exit 0
`

function run(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), 'pm24-'))
	const stubs = join(root, 'stubs')
	const mig = join(root, 'apps/shopfront/src/drizzle')
	mkdirSync(stubs)
	mkdirSync(mig, { recursive: true })
	writeFakeDocker(stubs, DOCKER)
	for (const [n, body] of Object.entries(files)) writeFileSync(join(mig, n), body)
	const calls = join(root, 'calls.log')
	writeFileSync(calls, '')
	const r = spawnSync('bash', [SCRIPT, 'shopfront', 'apply'], {
		env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, CALLS: calls, POWDER_APPS_DIR: join(root, 'apps'), POWDER_MIGRATE_WORK_DIR: join(root, 'w') },
		encoding: 'utf8',
	})
	return { r, log: readFileSync(calls, 'utf8') }
}

describe('powder-migrate refuses psql exec meta-commands', () => {
	const bad = [
		'select 1;\n\\! id > /tmp/x\n',
		'select 1; \\! id\n',
		'\\o | sh\nselect 1;\n',
		'select 1 \\g |sh\n',
		'\\w |sh\n',
		"\\copy t to program 'id'\n",
		'\\e\n',
		'\\set x `id`\n',
		// a command built from a psql variable (no literal exec meta-command)
		"\\set x '|touch /tmp/zorb-pwn1'\n\\o :x\nselect 1;\n\\o\n",
		"\\set y '\\134\\041 touch /tmp/zorb-pwn2'\n:y\nselect 2;\n",
		'select 3 \\g :x\n',
		'select 4;\n:y\n',
		"select :'v';\n",
		'select 1 \\gset\n',
		'\\i other.sql\n',
		'\\SETENV PAGER x\n',
		// non-standard strings make psql read \' as a quote and end the string
		// elsewhere than the check does
		"select 0;\nset standard_conforming_strings = off;\nselect 'a\\' , ' ; \\set x '|touch /tmp/zorb-pwn5'\n\\o :x\nselect 5;\n\\o\n",
		'SET Backslash_Quote = on;\nselect 1;\n',
	]
	for (const body of bad)
		it(`refuses ${JSON.stringify(body)} before running anything`, () => {
			const { r, log } = run({ '0001_ok.sql': 'create table a(x int);\n', '0002_bad.sql': body })
			expect(r.status).toBe(1)
			expect(r.stdout).toMatch(/REFUSING migration 0002_bad\.sql: line \d+:? (has a )?psql (meta-command|variable)|sets standard_conforming_strings/)
			expect(r.stdout).not.toContain('applying:')
			expect(log).not.toContain('create table a')
		})

	it('plain SQL (backslashes and colons in strings, casts, dollar quotes, comments, \\echo) is applied', () => {
		const { r, log } = run({
			'0001_ok.sql':
				"create table a(x int);\n--> statement-breakpoint\nselect E'\\\\n', regexp_replace('a', E'\\\\d+', ' '), x::text, '{\"k\":1}'::jsonb, 'at 10:30 :v' from a;\n" +
				'create function f() returns int as $$ declare y int; begin y := 1; return y; end $$ language plpgsql;\n' +
				'-- note: :x and \\o in a comment\n/* :y */ select 1;\n\\echo done\n',
		})
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('applying: 0001_ok.sql')
		expect(log).toContain('create table a')
	})

	it('runs psql with the hardened flags', () => {
		const { log } = run({ '0001_ok.sql': 'select 1;\n' })
		expect(log).toMatch(/\[docker\] run --rm -i --network container:shopfront --cap-drop ALL --security-opt no-new-privileges --user 70:70 --read-only --tmpfs \/tmp/)
	})
})
