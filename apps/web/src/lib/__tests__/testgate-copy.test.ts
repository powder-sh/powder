// the test gate mounts a filtered COPY of the build context: in a git
// checkout only the committed files, and never powder's protected names (.deploy-key,
// the runtime compose, rendered env files, DB/KV data, .powder-* runtime files).
import { gitHardenShellFunctions } from '../git-harden'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testGateShell } from '../deploy/fragments'
import { writeFakeDocker } from './fixtures/fake-docker'

const DIGEST = `docker.io/library/node@sha256:${'c'.repeat(64)}`

function gate(ctx: string) {
	const d = mkdtempSync(join(tmpdir(), 'tgc-'))
	// Stub docker: `run` lists what the container would see at /src (the -v source).
	writeFakeDocker(d, `#!/bin/bash
if [ "$1 $2" = "image inspect" ]; then case "$*" in *RepoDigests*) echo '${DIGEST}';; *) echo '{}';; esac; exit 0; fi
if [ "$1" = run ]; then
  while [ $# -gt 0 ]; do if [ "$1" = -v ]; then SRC=\${2%%:/src:ro}; fi; shift; done
  (cd "$SRC" && find . -mindepth 1 | LC_ALL=C sort) > '${join(d, 'seen')}'
  echo "$SRC" > '${join(d, 'srcdir')}'
fi
exit 0
`)
	const frag = testGateShell({ dir: `'${ctx}'`, label: 'l', run: '', tag: '[tg]', app: 'x' })
	const r = spawnSync('bash', ['-c', `set -e; ${gitHardenShellFunctions()}${frag}`], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${d}:${process.env.PATH}` },
	})
	const seen = existsSync(join(d, 'seen'))
		? readFileSync(join(d, 'seen'), 'utf8').trim().split('\n')
		: []
	const srcdir = existsSync(join(d, 'srcdir')) ? readFileSync(join(d, 'srcdir'), 'utf8').trim() : ''
	return { r, seen, srcdir }
}

function tree(root: string) {
	mkdirSync(join(root, '.powder'), { recursive: true })
	mkdirSync(join(root, 'lib'), { recursive: true })
	writeFileSync(join(root, '.powder/test.sh'), 'echo ok\n')
	writeFileSync(join(root, 'lib/a.ts'), 'export {}\n')
	writeFileSync(join(root, 'package.json'), '{}\n')
}

describe('test gate copy', () => {
	it('git checkout: only committed files, never the untracked server-side ones', () => {
		const root = mkdtempSync(join(tmpdir(), 'tgr-'))
		tree(root)
		const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' })
		git('init', '-q')
		git('add', '.')
		git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x')
		// Untracked, as powder or the server leaves them next to the code.
		writeFileSync(join(root, '.deploy-key'), 'KEY')
		writeFileSync(join(root, 'docker-compose.yml'), 'services: {}')
		writeFileSync(join(root, 'myapp.env'), 'SECRET=1')
		writeFileSync(join(root, '.env'), 'SECRET=1')
		writeFileSync(join(root, '.powder-swap'), 'x')
		mkdirSync(join(root, 'pgdata'))
		writeFileSync(join(root, 'pgdata/PG_VERSION'), '16')
		writeFileSync(join(root, 'untracked.txt'), 'x')
		const { r, seen, srcdir } = gate(root)
		expect(r.status, r.stdout + r.stderr).toBe(0)
		expect(seen).toEqual([
			'./.powder',
			'./.powder/test.sh',
			'./lib',
			'./lib/a.ts',
			'./package.json',
		])
		expect(srcdir).not.toBe(root)
		expect(existsSync(srcdir)).toBe(false) // removed after the run
		expect(r.stdout).toContain('test copy: committed files of the build context')
	})
	it('a tracked protected name is dropped too; a monorepo subdir context copies that subtree', () => {
		const root = mkdtempSync(join(tmpdir(), 'tgm-'))
		tree(join(root, 'app'))
		writeFileSync(join(root, 'app/docker-compose.yml'), 'services: {}')
		writeFileSync(join(root, 'app/prod.env'), 'X=1')
		writeFileSync(join(root, 'top.txt'), 'x')
		const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' })
		git('init', '-q')
		git('add', '.')
		git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x')
		const { r, seen } = gate(join(root, 'app'))
		expect(r.status, r.stdout + r.stderr).toBe(0)
		expect(seen).toEqual([
			'./.powder',
			'./.powder/test.sh',
			'./lib',
			'./lib/a.ts',
			'./package.json',
		])
	})
	it('no git checkout: a copy without the protected names', () => {
		const root = mkdtempSync(join(tmpdir(), 'tgn-'))
		tree(root)
		writeFileSync(join(root, '.deploy-key'), 'KEY')
		mkdirSync(join(root, 'kvdata'))
		writeFileSync(join(root, 'kvdata/dump.rdb'), 'x')
		writeFileSync(join(root, '.env.local'), 'S=1')
		const { r, seen } = gate(root)
		expect(r.status, r.stdout + r.stderr).toBe(0)
		expect(seen).toEqual([
			'./.powder',
			'./.powder/test.sh',
			'./lib',
			'./lib/a.ts',
			'./package.json',
		])
		expect(r.stdout).toContain('test copy: files in the build context')
	})
})
