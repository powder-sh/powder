import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFakeDocker } from './fixtures/fake-docker'

// Runs infra/powder-migrate under bash with a stub docker. The running container
// still holds the OLD DATABASE_URL (password rotated); the rendered env file has
// the NEW one. The migrate must connect with the new one.

const SCRIPT = resolve(__dirname, '../../../../../infra/powder-migrate')
const OLD = 'postgres://app:oldpass@db:5432/app'
const NEW = 'postgres://app:newpass@db:5432/app'

const DOCKER = `#!/bin/bash
echo "[docker] $*" >> "$CALLS"
case "$1" in
  inspect)
    case "$*" in
      *project.config_files*) [ "$NO_LABELS" = 1 ] || echo "$COMPOSE_FILE";;
      *'com.docker.compose.service'*) [ "$NO_LABELS" = 1 ] || echo app;;
      *Networks*) echo appnet;;
    esac; exit 0;;
  compose)
    # compose -f <file> config --format json
    printf '%s' "$CONFIG_JSON"; exit 0;;
  exec) [ "$NO_EXEC" = 1 ] || echo "$OLD_URL"; exit 0;;
  ps) [ "$DB_CTR" = 1 ] && echo demo-db; exit 0;;
  image) exit 0;;
  run)
    echo "DBURL=$DBURL" >> "$CALLS"
    cat >/dev/null
    case "$*" in *"count(*) from _powder_migrations"*) echo 0;; esac
    exit 0;;
esac
exit 0
`

function run(opts: { config: object; envFile?: string; noExec?: boolean; noLabels?: boolean; composeText?: string; dbContainer?: boolean }) {
	const root = mkdtempSync(join(tmpdir(), 'pm-'))
	const stubs = join(root, 'stubs')
	const apps = join(root, 'apps')
	mkdirSync(stubs)
	mkdirSync(join(apps, 'demo/src/drizzle'), { recursive: true })
	writeFileSync(join(apps, 'demo/src/drizzle/0001.sql'), 'select 1;\n')
	writeFakeDocker(stubs, DOCKER)
	const envPath = join(apps, 'demo.env')
	if (opts.envFile !== undefined) writeFileSync(envPath, opts.envFile)
	if (opts.composeText !== undefined) writeFileSync(join(apps, 'demo/docker-compose.yml'), opts.composeText)
	const cfg = JSON.stringify(opts.config).replaceAll('__ENV__', envPath)
	const calls = join(root, 'calls.log')
	writeFileSync(calls, '')
	const r = spawnSync('bash', [SCRIPT, 'demo', 'status'], {
		env: {
			...process.env,
			PATH: `${stubs}:${process.env.PATH}`,
			CALLS: calls,
			POWDER_APPS_DIR: apps, POWDER_MIGRATE_WORK_DIR: `${apps}-migwork`,
			COMPOSE_FILE: join(apps, 'demo/docker-compose.yml'),
			CONFIG_JSON: cfg,
			OLD_URL: OLD,
			NO_EXEC: opts.noExec ? '1' : '0',
			NO_LABELS: opts.noLabels ? '1' : '0',
			DB_CTR: opts.dbContainer ? '1' : '0',
		},
		encoding: 'utf8',
	})
	return { out: r.stdout, log: readFileSync(calls, 'utf8') }
}

describe('powder-migrate DATABASE_URL source', () => {
	it('uses the rendered env file, not the running container', () => {
		const { out, log } = run({
			config: { services: { app: { env_file: [{ path: '__ENV__' }] } } },
			envFile: `FOO=1\nDATABASE_URL="${NEW}"\n`,
		})
		expect(log).toContain(`DBURL=${NEW}`)
		expect(log).not.toContain(OLD)
		expect(out).toContain('read from the compose env_file/environment')
	})
	it('double-quoted values are unescaped like parseRawEnv (\\$ \\" \\\\ \\`), single quotes are literal', () => {
		const q = run({
			config: { services: { app: { env_file: [{ path: '__ENV__' }] } } },
			envFile: 'DATABASE_URL="postgres://u:p\\$ss\\"q\\\\x@db/x"\n',
		})
		expect(q.log).toContain('DBURL=postgres://u:p$ss"q\\x@db/x')
		const sq = run({
			config: { services: { app: { env_file: [{ path: '__ENV__' }] } } },
			envFile: "DATABASE_URL='postgres://u:p\\$ss@db/x'\n",
		})
		expect(sq.log).toContain('DBURL=postgres://u:p\\$ss@db/x')
	})
	it('last env_file wins, then environment: overrides', () => {
		const a = run({
			config: { services: { app: { env_file: [{ path: '__ENV__' }, { path: '__ENV__' }] } } },
			envFile: `DATABASE_URL=postgres://first\nDATABASE_URL=${NEW}\n`,
		})
		expect(a.log).toContain(`DBURL=${NEW}`)
		const b = run({
			config: { services: { app: { env_file: ['__ENV__'], environment: { DATABASE_URL: 'postgres://override' } } } },
			envFile: `DATABASE_URL=${NEW}\n`,
		})
		expect(b.log).toContain('DBURL=postgres://override')
	})
	it('falls back to the running container, with a log line, when no env file declares it', () => {
		const { out, log } = run({
			config: { services: { app: { env_file: [{ path: '__ENV__' }] } } },
			envFile: 'FOO=1\n',
		})
		expect(log).toContain(`DBURL=${OLD}`)
		expect(out).toContain('falling back to the running container')
	})
	it('skips when nothing declares it and the container has none', () => {
		const { out } = run({ config: { services: { app: {} } }, noExec: true })
		expect(out).toContain('has no DATABASE_URL')
	})
	it('first deploy (container without compose labels): reads the rendered env file, ignoring the empty container', () => {
		const { out, log } = run({
			config: { services: { app: {}, db: {} } },
			composeText: 'services:\n  app: {}\n  db: {}\n',
			envFile: `DATABASE_URL=${NEW}\n`,
			noLabels: true,
			noExec: true,
		})
		expect(log).toContain(`DBURL=${NEW}`)
		expect(out).toContain('read from the compose env_file/environment')
	})
	it('prefers the rendered env file over docker exec when compose declares no env_file', () => {
		const { log } = run({
			config: { services: { app: {} } },
			envFile: `DATABASE_URL=${NEW}\n`,
		})
		expect(log).toContain(`DBURL=${NEW}`)
		expect(log).not.toContain(OLD)
	})
	it('warns LOUDLY (not a silent skip) when no URL is found but the app has a db', () => {
		const { out } = run({
			config: { services: { app: {}, db: {} } },
			composeText: 'services:\n  app: {}\n  db:\n    image: postgres\n',
			noExec: true,
		})
		expect(out).toContain('WARNING')
		expect(out).toContain('MIGRATIONS WERE SKIPPED')
	})
})
