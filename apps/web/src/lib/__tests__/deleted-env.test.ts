// Disconnecting an app moves its env files out of /opt/apps into
// a root-only archive when no container of the app is left; while one exists the files
// stay. Nothing else in /opt/apps is touched, another registered app's file never
// moves, and a linked archive dir is refused.
import { spawnSync } from 'node:child_process'
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { appEnvFiles, archiveEnvFilesShell, envFileOwnedByOther, parseArchiveOutput } from '../deleted-env'
import { pathWithout } from './hermetic'
import { writeFakeDocker } from './fixtures/fake-docker'

const root = mkdtempSync(join(tmpdir(), 'deleted-env-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
// the archive script, or a failed test when there is none
function archiveShell(...a: Parameters<typeof archiveEnvFilesShell>): string {
	const s = archiveEnvFilesShell(...a)
	if (s === null) throw new Error('no archive script')
	return s
}
// fake docker: `ps -aq` prints the ids in ps.txt (whatever the filter), and logs the filter
const bin = join(root, 'bin')
mkdirSync(bin)
writeFakeDocker(bin, `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(root, 'docker.log'))}\ncat ${JSON.stringify(join(root, 'ps.txt'))} 2>/dev/null\nexit 0\n`)

const run = (cmd: string, containers = '') => {
	writeFileSync(join(root, 'ps.txt'), containers)
	const r = spawnSync('bash', ['-c', cmd], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
	return { status: r.status ?? 1, out: r.stdout.toString() }
}

describe('archive env files on disconnect', () => {
	it('moves .env, .preview.env and .db.env into a 0700 dir, names it, and leaves other apps alone', () => {
		const apps = join(root, 'apps1')
		const arch = join(root, 'arch1')
		mkdirSync(apps)
		for (const f of ['teashop.env', 'teashop.preview.env', 'teashop.db.env', 'teashop-api.env', 'other.env'])
			writeFileSync(join(apps, f), 'SECRET=1\n')
		const r = run(archiveShell('teashop', '2026-11-09T00-00-00-000Z', { appsBase: apps, archiveDir: arch }))
		expect(r.status).toBe(0)
		const dir = join(arch, 'teashop-2026-11-09T00-00-00-000Z')
		const res = parseArchiveOutput(r.out, r.status)
		expect(res.status).toBe('archived')
		expect(res.dir).toBe(dir)
		expect(res.detail).toContain(`mv ${dir}/* /opt/apps/`)
		expect(readdirSync(dir).sort()).toEqual(['teashop.db.env', 'teashop.env', 'teashop.preview.env'])
		expect(statSync(dir).mode & 0o777).toBe(0o700)
		expect(statSync(arch).mode & 0o777).toBe(0o700)
		expect(readdirSync(apps).sort()).toEqual(['other.env', 'teashop-api.env'])
		expect(readFileSync(join(apps, 'other.env'), 'utf8')).toBe('SECRET=1\n')
		const log = readFileSync(join(root, 'docker.log'), 'utf8')
		expect(log).toContain('label=com.docker.compose.project=teashop')
		expect(log).toContain('name=^/?pv-teashop-')
	})
	it('keeps the files while a container of the app exists (any state)', () => {
		const apps = join(root, 'apps5')
		mkdirSync(apps)
		writeFileSync(join(apps, 'teashop.env'), 'X=1\n')
		const r = run(archiveShell('teashop', 's1', { appsBase: apps, archiveDir: join(root, 'arch5') }), 'abc123\n')
		expect(r.status).toBe(0)
		const res = parseArchiveOutput(r.out, r.status)
		expect(res.status).toBe('kept')
		expect(res.detail).toContain('abc123')
		expect(existsSync(join(apps, 'teashop.env'))).toBe(true)
		expect(existsSync(join(root, 'arch5'))).toBe(false)
	})
	it('a failing docker or no docker CLI keeps the files (never read as "no containers")', () => {
		const failBin = join(root, 'failbin')
		mkdirSync(failBin)
		writeFakeDocker(failBin, '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n')
		const noBin = join(root, 'nobin')
		mkdirSync(noBin)
		for (const [i, path] of [`${failBin}:${process.env.PATH}`, `${noBin}:${pathWithout(['docker'])}`].entries()) {
			const apps = join(root, `apps-dk${i}`)
			mkdirSync(apps)
			writeFileSync(join(apps, 'teashop.env'), 'X=1\n')
			const env = { ...process.env, PATH: path }
			if (i === 1) expect(spawnSync('bash', ['-c', 'command -v docker'], { env }).status).not.toBe(0)
			const r = spawnSync('bash', ['-c', archiveShell('teashop', 's1', { appsBase: apps, archiveDir: join(root, `arch-dk${i}`) })], { env })
			expect(r.status).toBe(2)
			const res = parseArchiveOutput(r.stdout.toString(), r.status ?? 1)
			expect(res.status).toBe('kept')
			expect(res.detail).toContain('could not list')
			expect(existsSync(join(apps, 'teashop.env'))).toBe(true)
			expect(existsSync(join(root, `arch-dk${i}`))).toBe(false)
		}
	})
	it('moves a link itself, never its target', () => {
		const apps = join(root, 'apps2')
		const arch = join(root, 'arch2')
		mkdirSync(apps)
		writeFileSync(join(apps, 'other.env'), 'X=1\n')
		symlinkSync(join(apps, 'other.env'), join(apps, 'teashop.env'))
		expect(run(archiveShell('teashop', 's1', { appsBase: apps, archiveDir: arch })).status).toBe(0)
		expect(lstatSync(join(arch, 'teashop-s1', 'teashop.env')).isSymbolicLink()).toBe(true)
		expect(existsSync(join(apps, 'other.env'))).toBe(true)
	})
	it('refuses a linked archive dir and leaves the files; nothing to move is fine', () => {
		const apps = join(root, 'apps3')
		mkdirSync(apps)
		writeFileSync(join(apps, 'teashop.env'), 'X=1\n')
		mkdirSync(join(root, 'elsewhere'))
		symlinkSync(join(root, 'elsewhere'), join(root, 'arch3'))
		const r = run(archiveShell('teashop', 's1', { appsBase: apps, archiveDir: join(root, 'arch3') }))
		expect(r.status).toBe(1)
		expect(parseArchiveOutput(r.out, r.status).status).toBe('failed')
		expect(existsSync(join(apps, 'teashop.env'))).toBe(true)
		const n = run(archiveShell('nothing', 's1', { appsBase: apps, archiveDir: join(root, 'arch4') }))
		expect(parseArchiveOutput(n.out, n.status).status).toBe('none')
		expect(existsSync(join(root, 'arch4'))).toBe(false)
	})
	it('never moves another registered app file', () => {
		// app `teashop.db` is registered: teashop's .db.env is its .env
		expect(appEnvFiles('teashop', ['teashop.db'], '/a')).toEqual(['/a/teashop.env', '/a/teashop.preview.env'])
		expect(appEnvFiles('teashop', ['teashop.preview', 'teashop.db'], '/a')).toEqual(['/a/teashop.env'])
		// disconnecting `teashop.db` must not move teashop's DB env file
		expect(envFileOwnedByOther('teashop.db', ['teashop'])).toBe('teashop')
		expect(envFileOwnedByOther('teashop-db', ['teashop'])).toBeUndefined()
		const apps = join(root, 'apps6')
		mkdirSync(apps)
		writeFileSync(join(apps, 'teashop.env'), 'X=1\n')
		writeFileSync(join(apps, 'teashop.db.env'), 'Y=1\n')
		run(archiveShell('teashop', 's1', { appsBase: apps, archiveDir: join(root, 'arch6'), otherApps: ['teashop.db'] }))
		expect(readdirSync(apps)).toEqual(['teashop.db.env'])
	})
	it('refuses names that are not plain container names', () => {
		expect(archiveEnvFilesShell('../etc', 's')).toBeNull()
		expect(archiveEnvFilesShell('a b', 's')).toBeNull()
		expect(archiveEnvFilesShell('ok', 'bad;stamp')).toBeNull()
	})
	it('the disconnect route archives after deleting the row, passes the other apps, and the dialog says where', () => {
		const src = readFileSync(join(__dirname, '..', '..', 'app', 'api', 'servers', '[id]', 'containers', '[name]', 'repo', 'route.ts'), 'utf8')
		expect(src.indexOf('archiveAppEnvFiles(server, name, otherApps)')).toBeGreaterThan(src.indexOf('await deleteRepo(existing.id)'))
		const card = readFileSync(join(__dirname, '..', '..', 'components', 'repo-card.tsx'), 'utf8')
		expect(card).toContain('/var/lib/powder/deleted-env/')
		expect(card).toContain('envArchive')
	})
})
