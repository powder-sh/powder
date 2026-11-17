// The delete shell (removeAppShell) run against a stub `docker`: which containers
// it really stops and removes. Invented names only.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeAppShell } from '../app-lifecycle'

interface Ctr {
	id: string
	name: string
	project: string
	dir: string
}

// The stub answers `ps --filter name=...|label=...`, `inspect --format` (name,
// working_dir label), `stop` / `rm` (logged), `network ls` (none).
function run(containers: Ctr[], plan: Parameters<typeof removeAppShell>[0]) {
	const dir = mkdtempSync(join(tmpdir(), 'powder-del-'))
	const db = join(dir, 'containers.tsv')
	const log = join(dir, 'docker.log')
	writeFileSync(db, containers.map((c) => `${c.id}\t${c.name}\t${c.project}\t${c.dir}`).join('\n') + '\n')
	writeFileSync(log, '')
	const docker = String.raw`#!/bin/bash
DB=__DB__; LOG=__LOG__
case "$1" in
ps) F="$5"
  case "$F" in
  name=*) re=$(printf '%s' "$F" | sed -e 's#^name=^/?##' -e 's#[$]$##' -e 's#\[.]#.#g')
    awk -F'	' -v n="$re" '$2==n {print $1}' "$DB";;
  label=com.docker.compose.project=*) p=$(printf '%s' "$F" | sed -e 's#^label=com.docker.compose.project=##')
    awk -F'	' -v p="$p" '$3==p {print $1}' "$DB";;
  esac;;
inspect) fmt="$3"; id="$4"
  case "$fmt" in
  *working_dir*) awk -F'	' -v i="$id" '$1==i {print $4}' "$DB";;
  *) awk -F'	' -v i="$id" '$1==i {print "/"$2}' "$DB";;
  esac;;
stop|rm) echo "$*" >> "$LOG";;
network) ;;
esac
exit 0
`
		.replace('__DB__', `'${db}'`)
		.replace('__LOG__', `'${log}'`)
	writeFileSync(join(dir, 'docker'), docker)
	writeFileSync(join(dir, 'flock'), '#!/bin/sh\nexit 0\n')
	chmodSync(join(dir, 'docker'), 0o755)
	chmodSync(join(dir, 'flock'), 0o755)
	const sh = removeAppShell(plan).replaceAll('/var/lib/powder/locks', join(dir, 'locks'))
	const r = spawnSync('bash', ['-c', sh], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' })
	const removedIds = readFileSync(log, 'utf8')
		.split('\n')
		.filter((l) => l.startsWith('rm '))
		.flatMap((l) => l.split(' ').slice(2))
	const removed = containers.filter((c) => removedIds.includes(c.id)).map((c) => c.name)
	return { code: r.status, out: r.stdout, removed }
}

const base = { protectedNames: ['powder'], service: 'webapp' }

describe('delete shell against a stub docker', () => {
	it('own project: removes the app and its siblings, keeps a project container from another working dir', () => {
		const r = run(
			[
				{ id: 'a1', name: 'webapp', project: 'webapp', dir: '/opt/apps/webapp' },
				{ id: 'a2', name: 'webapp-db', project: 'webapp', dir: '/opt/apps/webapp' },
				{ id: 'b1', name: 'otherdb', project: 'webapp', dir: '/opt/apps/other' },
			],
			{ ...base, app: 'webapp', project: 'webapp', workingDir: '/opt/apps/webapp' },
		)
		expect(r.code).toBe(0)
		expect(r.removed.sort()).toEqual(['webapp', 'webapp-db'])
		expect(r.out).toContain('kept otherdb (compose project webapp from another working dir: /opt/apps/other)')
	})
	it('web.app and webapp share the project name: deleting web.app leaves the sibling of webapp', () => {
		const r = run(
			[
				{ id: 'a1', name: 'web.app', project: 'webapp', dir: '/opt/apps/web.app' },
				{ id: 'b1', name: 'webapp', project: 'webapp', dir: '/opt/apps/webapp' },
				{ id: 'b2', name: 'webapp-db', project: 'webapp', dir: '/opt/apps/webapp' },
			],
			{ ...base, app: 'web.app', project: 'webapp', workingDir: '/opt/apps/web.app', protectedNames: ['powder', 'webapp'] },
		)
		expect(r.code).toBe(0)
		expect(r.removed).toEqual(['web.app'])
		expect(r.out).toContain('webapp uses the same project name, only web.app was removed')
	})
	it('the same sibling, even with a guessed working dir (container already gone)', () => {
		const r = run(
			[
				{ id: 'b1', name: 'webapp', project: 'webapp', dir: '/opt/apps/webapp' },
				{ id: 'b2', name: 'webapp-db', project: 'webapp', dir: '/opt/apps/webapp' },
			],
			{ ...base, app: 'web.app', project: null, workingDir: '/opt/apps/web.app', protectedNames: ['powder', 'webapp'] },
		)
		expect(r.code).toBe(0)
		expect(r.removed).toEqual([])
	})
})
