// powder's DB layout detection (bin/self-deploy.sh and the in-app
// self-deploy) runs for real under bash against a stub `docker`:
//   - `docker inspect powder-postgres` also matches an IMAGE (or volume/network) of
//     that name, which would read a shared-network server as "private": it must be
//     `docker container inspect`;
//   - a shared-network server whose DB keeps its data somewhere other than powder-pgdata
//     is not "fresh": the powder container on `internal` means `legacy`.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { selfDbLayoutShell } from '../deploy/self-deploy'
import { writeFakeDocker } from './fixtures/fake-docker'

const BIN = resolve(__dirname, '../../../../../bin')

const DOCKER = `#!/bin/bash
args="$*"
case "$args" in
  "container inspect -f ok powder-postgres") [ "$PG_NEW" = 1 ] && { echo ok; exit 0; }; exit 1;;
  "inspect -f ok powder-postgres") [ "$PG_NEW" = 1 ] || [ "$IMAGE_NAMED" = 1 ] && { echo ok; exit 0; }; exit 1;;
  *".Mounts"*" postgres") echo "$PG_MOUNTS"; exit 0;;
  *"NetworkSettings.Networks"*" powder") [ -n "$POWDER_NETS" ] && { echo "$POWDER_NETS"; exit 0; }; exit 1;;
esac
exit 1
`

function stubDir(): string {
	const d = mkdtempSync(join(tmpdir(), 'layout-'))
	writeFakeDocker(d, DOCKER)
	return d
}

/** The DB_LAYOUT line of bin/self-deploy.sh, with `ssh` running the command locally. */
function binLayout(env: Record<string, string>): string {
	const line = readFileSync(join(BIN, 'self-deploy.sh'), 'utf8')
		.split('\n')
		.find((l) => l.startsWith('DB_LAYOUT=$(ssh'))
	expect(line).toBeTruthy()
	const script = `HOST=x; DATA_DIR=/nonexistent-layout; ENVF=/nonexistent-layout/powder.env; . ${join(BIN, 'lib-db-layout.sh')}; ssh() { bash -c "$2"; }\n${line}\necho "$DB_LAYOUT"`
	const d = stubDir()
	const r = spawnSync('bash', ['-c', script], {
		env: { ...process.env, PATH: `${d}:${process.env.PATH}`, ...env },
		encoding: 'utf8',
	})
	return r.stdout.trim()
}

function tsLayout(env: Record<string, string>): string {
	const d = stubDir()
	const r = spawnSync('bash', ['-c', selfDbLayoutShell('/nonexistent-layout')], {
		env: { ...process.env, PATH: `${d}:${process.env.PATH}`, ...env },
		encoding: 'utf8',
	})
	return r.stdout.trim()
}

describe.each([
	['bin/self-deploy.sh', binLayout],
	['selfDbLayoutShell', tsLayout],
])('%s DB layout detection', (_name, layout) => {
	it('an image named powder-postgres does not make a shared-network server private', () => {
		expect(
			layout({ IMAGE_NAMED: '1', PG_MOUNTS: '/opt/apps/powder-pgdata ', POWDER_NETS: '' }),
		).toBe('legacy')
	})
	it('powder on the internal network is the shared-network layout wherever the DB keeps its data', () => {
		expect(
			layout({
				PG_MOUNTS: '/var/lib/docker/volumes/pg/_data ',
				POWDER_NETS: '{"internal":{},"web":{}}',
			}),
		).toBe('legacy')
	})
	it('a powder-postgres container is private; nothing at all is fresh', () => {
		expect(layout({ PG_NEW: '1' })).toBe('private')
		expect(layout({ POWDER_NETS: '{"web":{},"powder-db":{}}' })).toBe('fresh')
	})
})
