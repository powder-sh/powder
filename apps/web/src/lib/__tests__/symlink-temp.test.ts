import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workdirSyncShell } from '../ssh/git'

const git = (cwd: string, ...a: string[]) =>
	execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim()

function repo(link: string | null) {
	const root = mkdtempSync(join(tmpdir(), 'powder-s1-'))
	const work = join(root, 'app')
	git(root, 'init', '-q', '-b', 'main', work)
	const victim = join(root, 'victim')
	writeFileSync(victim, 'ORIGINAL')
	writeFileSync(join(work, 'docker-compose.yml'), 'from: repo\n')
	if (link) symlinkSync('../victim', join(work, link))
	git(work, 'add', '-A', '-f')
	git(work, 'commit', '-q', '-m', 'c')
	return { work, victim }
}
const run = (work: string) => {
	const frag = workdirSyncShell(work, `git -c safe.directory='${work}' checkout -f -B "$BR" HEAD 2>&1 && `)
	return spawnSync('bash', ['-c', `cd '${work}' && BR=main; ${frag} echo SYNC_DONE`], { encoding: 'utf8' })
}

describe('workdir sync symlink guard', () => {
	for (const name of ['docker-compose.yml.powder-tmp', '.powder-swap-web', '.env.local', '.deploy-key.bak']) {
		it(`refuses a repo symlink at ${name} and leaves the victim untouched`, () => {
			const { work, victim } = repo(name)
			writeFileSync(join(work, 'docker-compose.yml'), 'runtime: compose\n')
			const r = run(work)
			expect(r.status).not.toBe(0)
			expect(r.stdout).toContain('symlink')
			expect(r.stdout).not.toContain('SYNC_DONE')
			expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
			// the runtime compose is restored even when the deploy is refused
			expect(readFileSync(join(work, 'docker-compose.yml'), 'utf8')).toBe('runtime: compose\n')
		})
	}
	it('tracked docker-compose.yml -> dir: runtime compose becomes a regular file, nothing lands in the dir', () => {
		const { work, victim } = repo(null)
		const vdir = join(victim, '..', 'vdir')
		mkdirSync(vdir)
		git(work, 'rm', '-q', '--cached', 'docker-compose.yml')
		rmSync(join(work, 'docker-compose.yml'))
		symlinkSync('../vdir', join(work, 'docker-compose.yml'))
		git(work, 'add', '-A', '-f')
		git(work, 'commit', '-q', '-m', 'link')
		// runtime compose is kept from before the sync: put it back as the pre-sync file
		rmSync(join(work, 'docker-compose.yml'))
		writeFileSync(join(work, 'docker-compose.yml'), 'runtime: compose\n')
		const r = run(work)
		expect(readdirSync(vdir)).toEqual([])
		expect(lstatSync(join(work, 'docker-compose.yml')).isSymbolicLink()).toBe(false)
		expect(readFileSync(join(work, 'docker-compose.yml'), 'utf8')).toBe('runtime: compose\n')
		expect(r.status).not.toBe(0) // tracked link is still refused
	})
	it('an untracked operator symlink (.env -> /opt/apps/x.env) does not refuse', () => {
		const { work } = repo(null)
		symlinkSync('/opt/apps/x.env', join(work, '.env'))
		const r = run(work)
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('SYNC_DONE')
	})
	it('clean repo: restores the runtime compose and leaves no temp file', () => {
		const { work } = repo(null)
		writeFileSync(join(work, 'docker-compose.yml'), 'runtime: compose\n')
		const r = run(work)
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('SYNC_DONE')
		expect(readFileSync(join(work, 'docker-compose.yml'), 'utf8')).toBe('runtime: compose\n')
		expect(existsSync(join(work, 'docker-compose.yml.powder-tmp'))).toBe(false)
	})
})
