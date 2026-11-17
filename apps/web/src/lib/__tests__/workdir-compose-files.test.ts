// the workdir-layout sync preserves EVERY runtime compose file under
// the workdir and refuses an extra compose file the repo tracks.
import { gitHardenShellFunctions } from '../git-harden'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workdirComposeFiles, workdirSyncShell } from '../ssh/git'

const git = (cwd: string, ...a: string[]) =>
	execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
		cwd,
		encoding: 'utf8',
	}).trim()

function repo(tracked: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), 'powder-s3-5-'))
	const work = join(root, 'app')
	git(root, 'init', '-q', '-b', 'main', work)
	for (const [f, c] of Object.entries(tracked)) {
		mkdirSync(join(work, f, '..'), { recursive: true })
		writeFileSync(join(work, f), c)
	}
	git(work, 'add', '-A')
	git(work, 'commit', '-q', '-m', 'c')
	return work
}
const run = (work: string, files: string[], enforce = false) => {
	const frag = workdirSyncShell(
		work,
		`git -c safe.directory='${work}' checkout -f -B "$BR" HEAD 2>&1 && git -c safe.directory='${work}' reset --hard HEAD 2>&1 && `,
		files.map((f) => join(work, f)),
		{ enforce, app: 'demo' },
	)
	return spawnSync('bash', ['-c', `set -e; ${gitHardenShellFunctions()}cd '${work}' && BR=main; ${frag} echo SYNC_DONE`], {
		encoding: 'utf8',
	})
}

describe('workdir layout: runtime compose files', () => {
	it('preserves an untracked extra compose file and the tracked docker-compose.yml across the reset', () => {
		const work = repo({ 'docker-compose.yml': 'from: repo\n' })
		writeFileSync(join(work, 'docker-compose.yml'), 'from: runtime\n')
		mkdirSync(join(work, 'deploy'))
		writeFileSync(join(work, 'deploy/prod.yml'), 'runtime: extra\n')
		const r = run(work, ['docker-compose.yml', 'deploy/prod.yml'])
		expect(r.stdout).toContain('SYNC_DONE')
		expect(readFileSync(join(work, 'docker-compose.yml'), 'utf8')).toBe('from: runtime\n')
		expect(readFileSync(join(work, 'deploy/prod.yml'), 'utf8')).toBe('runtime: extra\n')
	})
	it('a tracked extra compose file: WARN line, the repo copy wins, the deploy goes on (default)', () => {
		const work = repo({
			'docker-compose.yml': 'from: repo\n',
			'docker/docker-compose.prod.yml': 'from: repo prod\n',
		})
		writeFileSync(join(work, 'docker/docker-compose.prod.yml'), 'local edit\n')
		const r = run(work, ['docker-compose.yml', 'docker/docker-compose.prod.yml'])
		expect(r.status).toBe(0)
		expect(r.stdout).toContain(
			'[compose-guard] WARN demo tracked_compose docker/docker-compose.prod.yml',
		)
		expect(r.stdout).toContain('SYNC_DONE')
		expect(readFileSync(join(work, 'docker/docker-compose.prod.yml'), 'utf8')).toBe(
			'from: repo prod\n',
		)
	})
	it('enforce mode refuses a tracked extra compose file', () => {
		const work = repo({
			'docker-compose.yml': 'from: repo\n',
			'docker-compose.prod.yml': 'services: { a: { privileged: true } }\n',
		})
		const r = run(work, ['docker-compose.yml', 'docker-compose.prod.yml'], true)
		expect(r.status).toBe(1)
		expect(r.stdout).toContain('docker-compose.prod.yml is tracked by the repo')
		expect(r.stdout).not.toContain('SYNC_DONE')
	})
	it('only files under the workdir, never the powder override or traversal', () => {
		expect(
			workdirComposeFiles('/opt/apps/x', [
				'/opt/apps/x/docker-compose.yml',
				'/opt/apps/x/a/b.yml',
				'/var/lib/powder/compose/k/docker-compose.powder.yml',
				'/opt/apps/y/c.yml',
				'/opt/apps/x/../y/d.yml',
			]),
		).toEqual(['docker-compose.yml', 'a/b.yml'])
	})
})
