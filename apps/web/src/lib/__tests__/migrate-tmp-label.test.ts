import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFakeDocker } from './fixtures/fake-docker'

// A container created with a temp override has a config_files label naming deleted
// /tmp/powder-dfr.<x>/override.yml files. infra/powder-migrate reads that label:
// with them resolve_dburl's `compose config` would fail (silent fallback to the
// running container's DATABASE_URL, wrong after a password change), and
// own_compose_ctr would reject the /tmp path (migrations skipped for apps whose
// container name differs from the app name). The script drops them.

const SCRIPT = resolve(__dirname, '../../../../../infra/powder-migrate')
const OLD = 'postgres://app:oldpass@db:5432/app'
const NEW = 'postgres://app:newpass@db:5432/app'
const GONE = '/tmp/powder-dfr.Zq81xY/override.yml'

const DOCKER = `#!/bin/bash
echo "[docker] $*" >> "$CALLS"
args=("$@")
case "$1" in
  inspect)
    if [ "$#" = 2 ] && [ "$2" = demo ] && [ "$NAMED" = 0 ]; then exit 1; fi
    case "$*" in
      *project.config_files*) echo "$COMPOSE_FILE,${GONE}";;
      *'com.docker.compose.service'*) echo app;;
      *Networks*) echo appnet;;
    esac; exit 0;;
  compose)
    i=1; while [ $i -lt $# ]; do if [ "\${args[$i]}" = -f ] && [ ! -e "\${args[$((i+1))]}" ]; then echo "open \${args[$((i+1))]}: no such file or directory" >&2; exit 1; fi; i=$((i+1)); done
    printf '%s' "$CONFIG_JSON"; exit 0;;
  exec) echo "$OLD_URL"; exit 0;;
  ps) case "$*" in *working_dir*) echo demo-web;; esac; exit 0;;
  image) exit 0;;
  run)
    echo "DBURL=$DBURL" >> "$CALLS"
    cat >/dev/null
    case "$*" in *"count(*) from _powder_migrations"*) echo 0;; esac
    exit 0;;
esac
exit 0
`

function run(named: boolean) {
	const root = mkdtempSync(join(tmpdir(), 'pm-tmp-'))
	const stubs = join(root, 'stubs')
	const apps = join(root, 'apps')
	mkdirSync(stubs)
	mkdirSync(join(apps, 'demo/src/drizzle'), { recursive: true })
	writeFileSync(join(apps, 'demo/src/drizzle/0001.sql'), 'select 1;\n')
	writeFileSync(join(apps, 'demo/docker-compose.yml'), 'services: {}\n')
	writeFakeDocker(stubs, DOCKER)
	const envPath = join(apps, 'demo.env')
	writeFileSync(envPath, `DATABASE_URL="${NEW}"\n`)
	const calls = join(root, 'calls.log')
	writeFileSync(calls, '')
	const r = spawnSync('bash', [SCRIPT, 'demo', 'status'], {
		env: {
			...process.env,
			PATH: `${stubs}:${process.env.PATH}`,
			CALLS: calls,
			POWDER_APPS_DIR: apps, POWDER_MIGRATE_WORK_DIR: `${apps}-migwork`,
			COMPOSE_FILE: join(apps, 'demo/docker-compose.yml'),
			CONFIG_JSON: JSON.stringify({ services: { app: { env_file: [{ path: envPath }] } } }),
			OLD_URL: OLD,
			NAMED: named ? '1' : '0',
		},
		encoding: 'utf8',
	})
	return { out: r.stdout + r.stderr, log: readFileSync(calls, 'utf8') }
}

describe('powder-migrate with a label naming a deleted /tmp override', () => {
	it('resolves DATABASE_URL from the compose env_file (not the running container)', () => {
		const { out, log } = run(true)
		expect(log).toContain(`DBURL=${NEW}`)
		expect(log).not.toContain(OLD)
		expect(log).not.toContain(GONE)
		expect(out).toContain('read from the compose env_file/environment')
	})

	it('still finds the app container by its compose label when the name differs', () => {
		const { out, log } = run(false)
		expect(out).not.toContain('no running container found')
		expect(log).toContain(`DBURL=${NEW}`)
	})
})
