import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

let envVars: NodeJS.ProcessEnv = process.env
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env: envVars })
		return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
	},
	withConnection: () => ({ end() {} }),
}))
vi.mock('../ssh/discovery', () => ({ inspectContainer: async () => ({}) }))
vi.mock('../ssh-host-keys', () => ({ explainSshError: (_h: string, e: Error) => e }))

import { writeRuntimeFilesShell } from '../app-runtime-files'
import { atomicWriteShell, repoSymlinkGuardShell } from '../repo-symlinks'
import { workdirSyncShell } from '../ssh/git'
import { envStateDirName, readEnvRestoreMarker, restoreEnvBeforeRender, restoreEnvSnapshot } from '../ssh/files'

const git = (cwd: string, ...a: string[]) =>
	execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim()
const sh = (cmd: string) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })

/** A repo whose tracked content is hostile: every link points at `victim`. */
function hostileRepo() {
	const root = mkdtempSync(join(tmpdir(), 'powder-symlink-'))
	const work = join(root, 'app')
	git(root, 'init', '-q', '-b', 'main', work)
	const victim = join(root, 'victim')
	writeFileSync(victim, 'ORIGINAL')
	const vdir = join(root, 'vdir')
	mkdirSync(vdir)
	writeFileSync(join(work, 'docker-compose.yml'), 'from: repo\n')
	mkdirSync(join(work, 'drizzle'))
	mkdirSync(join(work, 'public'))
	mkdirSync(join(work, 'assets'))
	writeFileSync(join(work, 'assets', 'x'), 'asset')
	for (const l of ['docker-compose.yml.new', '.env.powder-restored', 'drizzle/0099.sql']) symlinkSync(victim, join(work, l))
	symlinkSync(vdir, join(work, 'src'))
	symlinkSync('../assets/x', join(work, 'public', 'x'))
	git(work, 'add', '-A')
	git(work, 'commit', '-q', '-m', 'c')
	return { root, work, victim, vdir }
}
const HOSTILE = ['docker-compose.yml.new', '.env.powder-restored', 'src', 'drizzle/0099.sql']

describe('repoSymlinkGuardShell (one authority)', () => {
	it('removes every hostile tracked link, keeps in-repo relative links, exits 1', () => {
		const { work, victim, vdir } = hostileRepo()
		const r = sh(repoSymlinkGuardShell(work))
		expect(r.status).toBe(1)
		for (const l of HOSTILE) {
			expect(existsSync(join(work, l)) || (() => { try { lstatSync(join(work, l)); return true } catch { return false } })()).toBe(false)
			expect(r.stdout).toContain(`removed hostile symlink: ${l} -> `)
		}
		expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
		expect(existsSync(vdir)).toBe(true)
		expect(lstatSync(join(work, 'public', 'x')).isSymbolicLink()).toBe(true)
		expect(readFileSync(join(work, 'public', 'x'), 'utf8')).toBe('asset')
		// powder-owned names stay refused while the repo still tracks them (nothing left to remove)
		const again = sh(repoSymlinkGuardShell(work))
		expect(again.status).toBe(1)
		expect(again.stdout).not.toContain('removed hostile symlink')
	})
	it('a clean checkout (only in-repo links) passes', () => {
		const root = mkdtempSync(join(tmpdir(), 'powder-symlinkc-'))
		git(root, 'init', '-q', '-b', 'main', root)
		mkdirSync(join(root, 'a'))
		writeFileSync(join(root, 'a', 'f'), 'x')
		symlinkSync('a/f', join(root, 'l'))
		git(root, 'add', '-A')
		git(root, 'commit', '-q', '-m', 'c')
		expect(sh(repoSymlinkGuardShell(root)).status).toBe(0)
		expect(lstatSync(join(root, 'l')).isSymbolicLink()).toBe(true)
	})
	it('workdirSyncShell: hostile checkout is cleaned and the deploy refused', () => {
		const { work, victim } = hostileRepo()
		const frag = workdirSyncShell(work, `git -c safe.directory='${work}' checkout -f -B "$BR" HEAD 2>&1 && `)
		const r = spawnSync('bash', ['-c', `cd '${work}' && BR=main; ${frag} echo SYNC_DONE`], { encoding: 'utf8' })
		expect(r.status).not.toBe(0)
		expect(r.stdout).not.toContain('SYNC_DONE')
		expect(r.stdout).toContain('removed hostile symlink')
		expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
		expect(lstatSync(join(work, 'public', 'x')).isSymbolicLink()).toBe(true)
	})
	it('writeRuntimeFilesShell: hostile checkout is cleaned and refused', () => {
		const { root, work, victim } = hostileRepo()
		const composeTmp = join(root, 'composetmp')
		writeFileSync(composeTmp, 'name: x\n', { mode: 0o600 })
		const r = spawnSync('bash', ['-c', writeRuntimeFilesShell({ workdir: work, composeTmp })], { encoding: 'utf8' })
		expect(r.status).not.toBe(0)
		expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
		expect(existsSync(join(work, 'docker-compose.yml.new'))).toBe(false)
	})
})

describe('a repo-tracked docker-compose.powder.yml is refused', () => {
	it('the guard and the workdir sync refuse a checkout that tracks the override name', () => {
		const root = mkdtempSync(join(tmpdir(), 'powder-tracked-'))
		const work = join(root, 'app')
		git(root, 'init', '-q', '-b', 'main', work)
		writeFileSync(join(work, 'docker-compose.yml'), 'services: {}\n')
		writeFileSync(join(work, 'docker-compose.powder.yml'), 'services:\n  app:\n    privileged: true\n    volumes: ["/:/host"]\n')
		git(work, 'add', '-A')
		git(work, 'commit', '-q', '-m', 'c')
		const g = sh(repoSymlinkGuardShell(work))
		expect(g.status).toBe(1)
		expect(g.stdout).toContain('docker-compose.powder.yml')
		const frag = workdirSyncShell(work, `git -c safe.directory='${work}' checkout -f -B "$BR" HEAD 2>&1 && `)
		const r = spawnSync('bash', ['-c', `cd '${work}' && BR=main; ${frag} echo SYNC_DONE`], { encoding: 'utf8' })
		expect(r.status).not.toBe(0)
		expect(r.stdout).not.toContain('SYNC_DONE')
	})
})

describe('atomicWriteShell and the writers that use it', () => {
	it('replaces a leftover link instead of writing through it', () => {
		const root = mkdtempSync(join(tmpdir(), 'powder-symlinkw-'))
		const victim = join(root, 'victim')
		writeFileSync(victim, 'ORIGINAL')
		symlinkSync(victim, join(root, 'dest'))
		writeFileSync(join(root, 'src'), 'NEW')
		expect(sh(atomicWriteShell(join(root, 'dest'), join(root, 'src'))).status).toBe(0)
		expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
		expect(lstatSync(join(root, 'dest')).isSymbolicLink()).toBe(false)
		expect(readFileSync(join(root, 'dest'), 'utf8')).toBe('NEW')
	})
	it('env restores use the state dir and never write through leftover links', async () => {
		const root = mkdtempSync(join(tmpdir(), 'powder-symlinke-'))
		const state = join(root, 'state')
		envVars = { ...process.env, POWDER_ENV_STATE: state }
		const victim = join(root, 'victim')
		writeFileSync(victim, 'ORIGINAL')
		const env = join(root, 'app.env')
		writeFileSync(env, 'CUR=1\n')
		for (const l of ['.powder-restored', '.bak', '.deploy-1', '.pre-1']) symlinkSync(victim, `${env}${l}`)
		const dir = join(state, envStateDirName(env))
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'deploy-1'), 'OLD=1\n')
		const r = await restoreEnvSnapshot({} as never, env, 'dep_1')
		expect(r.restored).toBe(true)
		expect(readFileSync(env, 'utf8')).toBe('OLD=1\n')
		expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
		expect(readFileSync(join(dir, 'bak'), 'utf8')).toBe('CUR=1\n')
		expect(await readEnvRestoreMarker({} as never, env)).toMatch(/^[0-9a-f]{64}$/)
		// pre-render restore
		writeFileSync(join(dir, 'pre-2'), 'PRE=1\n')
		const r2 = await restoreEnvBeforeRender({} as never, env, 'dep_2')
		expect(r2.restored).toBe(true)
		expect(readFileSync(env, 'utf8')).toBe('PRE=1\n')
		expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
	})
	it('refuses to restore into an env path that is a symlink', async () => {
		const root = mkdtempSync(join(tmpdir(), 'powder-r3e2-'))
		envVars = { ...process.env, POWDER_ENV_STATE: join(root, 'state') }
		const victim = join(root, 'victim')
		writeFileSync(victim, 'ORIGINAL')
		const env = join(root, 'app.env')
		symlinkSync(victim, env)
		const dir = join(root, 'state', envStateDirName(env))
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'deploy-1'), 'OLD=1\n')
		await expect(restoreEnvSnapshot({} as never, env, 'dep_1')).rejects.toThrow()
		expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
		expect(dirname(dir)).toBeTruthy()
	})
	it('honours a pre-move in-place marker once (read old location when new is absent)', async () => {
		const root = mkdtempSync(join(tmpdir(), 'powder-symlinkm-'))
		envVars = { ...process.env, POWDER_ENV_STATE: join(root, 'state') }
		const env = join(root, 'app.env')
		writeFileSync(env, 'X=1\n')
		const sha = 'a'.repeat(64)
		writeFileSync(`${env}.powder-restored`, `${sha}\n`)
		expect(await readEnvRestoreMarker({} as never, env)).toBe(sha)
	})
})
