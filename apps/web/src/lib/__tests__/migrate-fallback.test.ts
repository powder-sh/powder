// powder-migrate's container fallback (no container named <app>)
// only trusts a non-one-off compose container whose config_files are this app's.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFakeDocker } from './fixtures/fake-docker'

const SCRIPT = resolve(__dirname, '../../../../../infra/powder-migrate')

// No container is named `demo`; `docker ps` returns $PS_NAMES only when the filter
// asks for oneoff=False (what a compose-started service container carries);
// config_files of each candidate come from $CF_<name>.
const DOCKER = `#!/bin/bash
echo "[docker] $*" >> "$CALLS"
case "$1" in
  inspect)
    case "$*" in
      *"inspect demo "*|"inspect demo") exit 1;;
      *project.config_files*) n=$(echo "$*" | awk '{print $2}'); v="CF_\${n//-/_}"; echo "\${!v}"; exit 0;;
    esac; exit 0;;
  ps) case "$*" in *"oneoff=False"*) printf '%s\\n' $PS_NAMES;; *) printf '%s\\n' $PS_NAMES $PS_ONEOFF;; esac; exit 0;;
esac
exit 0
`

function run(env: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), 'pm-s3-'))
	const stubs = join(root, 'stubs')
	const apps = join(root, 'apps')
	mkdirSync(stubs)
	mkdirSync(join(apps, 'demo/src/drizzle'), { recursive: true })
	writeFakeDocker(stubs, DOCKER)
	const calls = join(root, 'calls.log')
	writeFileSync(calls, '')
	const r = spawnSync('bash', [SCRIPT, 'demo', 'status'], {
		cwd: root,
		env: {
			...process.env,
			PATH: `${stubs}:${process.env.PATH}`,
			CALLS: calls,
			POWDER_APPS_DIR: apps, POWDER_MIGRATE_WORK_DIR: `${apps}-migwork`,
			...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replaceAll('@APPS@', apps)])),
		},
		encoding: 'utf8',
	})
	return { apps, out: r.stdout, log: readFileSync(calls, 'utf8') }
}

describe('powder-migrate container fallback', () => {
	it('asks docker for non-one-off containers only', () => {
		const r = run({ PS_NAMES: '' })
		expect(r.log).toContain('label=com.docker.compose.oneoff=False')
		expect(r.out).toContain('no running container found')
	})
	it("skips a container that claims the working dir but whose compose files are someone else's", () => {
		const r = run({ PS_NAMES: 'evil', CF_evil: '/opt/apps/evil/docker-compose.yml' })
		expect(r.out).toContain('no running container found')
	})
	it("takes a container whose compose files are the app's own", () => {
		const r = run({ PS_NAMES: 'demo-web', CF_demo_web: '@APPS@/demo/docker-compose.yml' })
		expect(r.out).not.toContain('no running container found')
	})
})
