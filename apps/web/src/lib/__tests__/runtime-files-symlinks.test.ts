import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeRuntimeFilesShell } from '../app-runtime-files'

const COMPOSE = 'name: x\nservices: {}\n'

function setup() {
	const root = mkdtempSync(join(tmpdir(), 'powder-sym-'))
	const work = join(root, 'app')
	mkdirSync(work)
	const victim = join(root, 'victim')
	writeFileSync(victim, 'ORIGINAL')
	const key = join(root, 'tmpkey')
	writeFileSync(key, 'KEY')
	return { root, work, victim, key }
}
const run = (work: string, key: string) => {
	const composeTmp = join(dirname(work), 'composetmp')
	writeFileSync(composeTmp, COMPOSE, { mode: 0o600 })
	return spawnSync('bash', ['-c', writeRuntimeFilesShell({ workdir: work, composeTmp, keyTmp: key })], { encoding: 'utf8' })
}

describe('writeRuntimeFilesShell', () => {
	it('installs key, compose and .dockerignore on a clean workdir', () => {
		const { work, key } = setup()
		const r = run(work, key)
		expect(r.status).toBe(0)
		expect(readFileSync(join(work, 'docker-compose.yml'), 'utf8')).toBe(COMPOSE)
		expect(readFileSync(join(work, '.deploy-key'), 'utf8')).toBe('KEY')
		expect(existsSync(join(work, '.dockerignore'))).toBe(true)
		expect(existsSync(join(work, '.powder-compose.tmp'))).toBe(false)
		// the compose carries DB passwords: 0600, staged file removed.
		expect(statSync(join(work, 'docker-compose.yml')).mode & 0o777).toBe(0o600)
		expect(existsSync(join(dirname(work), 'composetmp'))).toBe(false)
	})
	for (const name of ['docker-compose.yml', 'powder.json', '.deploy-key', '.dockerignore', '.powder-app-x.lock']) {
		it(`refuses a repo-planted symlink at ${name} and never writes through it`, () => {
			const { work, victim, key } = setup()
			symlinkSync(victim, join(work, name))
			const r = run(work, key)
			expect(r.status).not.toBe(0)
			expect(r.stderr).toContain('symlink')
			expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
		})
	}
	it('a symlinked compose tmp name is replaced, not followed', () => {
		const { work, victim, key } = setup()
		// .powder-* symlinks are refused outright; this covers the tmp name too.
		symlinkSync(victim, join(work, '.powder-compose.tmp'))
		expect(run(work, key).status).not.toBe(0)
		expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
	})
	it('replaces a regular tracked docker-compose.yml via rename', () => {
		const { work, key } = setup()
		writeFileSync(join(work, 'docker-compose.yml'), 'from: repo\n')
		expect(run(work, key).status).toBe(0)
		expect(readFileSync(join(work, 'docker-compose.yml'), 'utf8')).toBe(COMPOSE)
	})
})
