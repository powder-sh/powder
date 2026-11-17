// powder-resource-guard must not skip the memory cap for any container whose name or
// image CONTAINS postgres / redis / nginx / ...: an app could name itself out of the cap.
// Only an image whose repo is exactly an infra repo (digest-pinned pgvector included,
// with or without RepoDigests) or powder's own database container by name is skipped.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFakeDocker } from './fixtures/fake-docker'

const SCRIPT = resolve(__dirname, '../../../../../infra/powder-resource-guard.sh')

// name|image ref|image id|RepoDigests count
const SRV = [
	'shop-db|pgvector/pgvector:pg16|sha256:a1|1',
	'cache|redis:7-alpine|sha256:a2|1',
	'edge|docker.io/library/traefik:v3.6|sha256:a3|1',
	'feeds|nginx:1.27-alpine|sha256:a4|1',
	'billing-db|postgres:17-alpine@sha256:abc|sha256:a5|2',
	'shop|shop:latest|sha256:b1|0',
	'shop-redis-ui|shop-redis-ui:latest|sha256:b2|0',
	'postgres-admin|acme/postgres-admin:1|sha256:b3|1',
	'pinned-db|pgvector/pgvector:pg17@sha256:abc|sha256:a6|0',
	'postgres|pgvector/pgvector:pg16|sha256:a7|0',
	'powder-postgres|acme/pg-custom:1|sha256:a8|0',
	'nginx-app|acme/nginx:2|sha256:b5|1',
]

const DOCKER = `#!/bin/bash
SRV="$SRVFILE"
row() { grep -E "^$1\\|" "$SRV" || grep -E "^[^|]*\\|[^|]*\\|$1\\|" "$SRV"; }
case "$1" in
  ps) cut -d'|' -f1 "$SRV"; exit 0;;
  inspect)
    f="$3"; c="$4"
    case "$f" in
      *Config.Image*) row "$c" | cut -d'|' -f2;;
      '{{.Image}}') row "$c" | cut -d'|' -f3;;
      *HostConfig.Memory*) echo 0;;
      *State.Pid*) exit 1;;
    esac; exit 0;;
  image) row "$5" | cut -d'|' -f4; exit 0;;
  update) echo "$*" >> "$CALLS"; exit 0;;
esac
exit 0
`

describe('resource guard skips only infra repos by exact name', () => {
	it('caps apps whose name or image only contains an infra word', () => {
		const root = mkdtempSync(join(tmpdir(), 'rg24-'))
		const stubs = join(root, 'stubs')
		mkdirSync(stubs)
		writeFakeDocker(stubs, DOCKER)
		writeFileSync(join(root, 'server'), `${SRV.join('\n')}\n`)
		const calls = join(root, 'calls')
		writeFileSync(calls, '')
		const r = spawnSync('bash', [SCRIPT], {
			env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, SRVFILE: join(root, 'server'), CALLS: calls },
			encoding: 'utf8',
		})
		expect(r.status).toBe(0)
		const capped = readFileSync(calls, 'utf8')
			.trim()
			.split('\n')
			.map((l) => l.split(' ').pop())
			.sort()
		expect(capped).toEqual(['nginx-app', 'postgres-admin', 'shop', 'shop-redis-ui'])
	})
})
