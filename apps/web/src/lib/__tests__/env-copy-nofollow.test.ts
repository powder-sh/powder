// every env file copy (pre-render copy, deploy snapshot, .bak, restore) copies
// only a regular file and never through a link: a container that can write next to the
// env file could swap it for a link to another app's env file, and a copy that followed
// it would later be restored into this app. writeEnvFile checks the FULL path for links,
// again right before the rename. Real bash, ssh mocked. Invented app names only.
import { spawnSync } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cmds: string[] = []
let env: NodeJS.ProcessEnv = process.env

vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		cmds.push(cmd)
		const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env })
		return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
	},
	withConnection: (_s: unknown, h: { onReady: (c: unknown) => void }) => {
		const conn = {
			end() {},
			sftp(cb: (e: Error | null, s: unknown) => void) {
				cb(null, { createWriteStream: (p: string) => createWriteStream(p) })
			},
		}
		queueMicrotask(() => h.onReady(conn))
		return conn
	},
}))
vi.mock('../ssh/discovery', () => ({ inspectContainer: async () => ({}) }))
vi.mock('../ssh-host-keys', () => ({ explainSshError: (_h: string, e: Error) => e }))

import { backupEnvBeforeRender, envCopyShell, envStateDirName, restoreEnvSnapshot, snapshotEnvForDeploy, writeEnvFile } from '../ssh/files'

const SRV = { id: 's', host: 'h' } as never

/** Every file under dir (recursively), with its content. */
function allFiles(dir: string): string[] {
	if (!existsSync(dir)) return []
	const out: string[] = []
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name)
		if (e.isDirectory()) out.push(...allFiles(p))
		else if (e.isFile()) out.push(readFileSync(p, 'utf8'))
	}
	return out
}

describe('env copies never follow a link at the env file', () => {
	let root: string
	let state: string
	let appDir: string
	let envPath: string
	let other: string
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'envcopy-'))
		const stubs = join(root, 'stubs')
		mkdirSync(stubs)
		for (const n of ['chown', 'getent']) {
			writeFileSync(join(stubs, n), n === 'getent' ? '#!/bin/sh\nexit 2\n' : '#!/bin/sh\nexit 0\n')
			chmodSync(join(stubs, n), 0o755)
		}
		writeFileSync(join(stubs, 'stat'), "#!/bin/sh\necho '0 1'\n")
		chmodSync(join(stubs, 'stat'), 0o755)
		state = join(root, 'state')
		env = { ...process.env, PATH: `${stubs}:${process.env.PATH}`, POWDER_ENV_STATE: state }
		appDir = join(root, 'apps', 'shop')
		mkdirSync(join(appDir, 'conf'), { recursive: true })
		other = join(root, 'apps', 'mill.env')
		writeFileSync(other, 'MILL_SECRET=other-app\n')
		envPath = join(appDir, 'conf', 'x.env')
		cmds.length = 0
	})
	const plantLink = () => symlinkSync(other, envPath)
	const stateHasSecret = () => allFiles(state).some((c) => c.includes('MILL_SECRET'))

	it('the pre-render copy refuses a link (deploy stops before the render)', async () => {
		plantLink()
		await expect(backupEnvBeforeRender(SRV, envPath, 'dep_1')).rejects.toThrow(/not a regular file/)
		expect(stateHasSecret()).toBe(false)
	})
	it('the pre-render copy of a regular file still works', async () => {
		writeFileSync(envPath, 'A=1\n')
		await backupEnvBeforeRender(SRV, envPath, 'dep_1')
		expect(readFileSync(join(state, envStateDirName(envPath), 'pre-1'), 'utf8')).toBe('A=1\n')
	})
	it('the deploy snapshot refuses a link', async () => {
		plantLink()
		await snapshotEnvForDeploy(SRV, envPath, 'dep_2')
		expect(stateHasSecret()).toBe(false)
		writeFileSync(join(root, 'reg.env'), 'B=2\n')
		await snapshotEnvForDeploy(SRV, join(root, 'reg.env'), 'dep_2')
		expect(readFileSync(join(state, envStateDirName(join(root, 'reg.env')), 'deploy-2'), 'utf8')).toBe('B=2\n')
	})
	it('writeEnvFile: the .bak never copies through a link, and the link is refused at the full path', async () => {
		plantLink()
		await expect(writeEnvFile(SRV, envPath, 'NEW=1\n', { noSymlinkBelow: appDir })).rejects.toThrow(/is a symlink/)
		await expect(writeEnvFile(SRV, envPath, 'NEW=1\n')).rejects.toThrow(/not a regular file/)
		expect(stateHasSecret()).toBe(false)
		expect(readFileSync(other, 'utf8')).toBe('MILL_SECRET=other-app\n')
	})
	it('writeEnvFile checks the full path again right before the rename', async () => {
		writeFileSync(envPath, 'OLD=1\n')
		await writeEnvFile(SRV, envPath, 'NEW=1\n', { noSymlinkBelow: appDir })
		expect(readFileSync(envPath, 'utf8')).toBe('NEW=1\n')
		const write = cmds.find((c) => c.includes('mv -fT')) ?? ''
		const mv = write.indexOf(`rm -f -- '${envPath}' && { mv -fT`)
		expect(mv).toBeGreaterThan(0)
		// the link loop over the full path, after the .bak copy and before the rm / mv
		const last = write.lastIndexOf(`'${envPath}'; do if [ -L "$P" ]`)
		expect(last).toBeGreaterThan(write.indexOf('.bak.tmp'))
		expect(last).toBeLessThan(mv)
	})
	it('a restore keeps no copy of a linked env file in its .bak', async () => {
		writeFileSync(envPath, 'A=1\n')
		await snapshotEnvForDeploy(SRV, envPath, 'dep_3')
		const { rmSync } = await import('node:fs')
		rmSync(envPath)
		plantLink()
		await expect(restoreEnvSnapshot(SRV, envPath, 'dep_3')).rejects.toThrow(/symlink/)
		expect(stateHasSecret()).toBe(false)
	})
	it('envCopyShell: a regular file is copied, a link or a missing file is not', () => {
		const sh = (cmd: string) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })
		const src = join(root, 'src.env')
		const dst = join(root, 'dst.env')
		writeFileSync(src, 'C=3\n')
		expect(sh(envCopyShell(`'${src}'`, `'${dst}'`)).status).toBe(0)
		expect(readFileSync(dst, 'utf8')).toBe('C=3\n')
		const ln = join(root, 'ln.env')
		symlinkSync(other, ln)
		const r = sh(envCopyShell(`'${ln}'`, `'${dst}'`))
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain('not a regular file')
		expect(existsSync(dst)).toBe(false)
	})
	it('envCopyShell: a swap between the check and the copy (the copy lands as a link) is refused', () => {
		// a cp that behaves as `cp -P` does when the source was swapped for a link after the
		// check: it creates a link at the destination
		const stubs = join(root, 'race')
		mkdirSync(stubs)
		writeFileSync(join(stubs, 'cp'), `#!/bin/sh\nfor a; do d=$a; done\nln -s ${JSON.stringify(other)} "$d"\n`)
		chmodSync(join(stubs, 'cp'), 0o755)
		const src = join(root, 'src2.env')
		const dst = join(root, 'dst2.env')
		writeFileSync(src, 'D=4\n')
		const r = spawnSync('bash', ['-c', envCopyShell(`'${src}'`, `'${dst}'`)], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
		})
		expect(r.status).not.toBe(0)
		expect(existsSync(dst)).toBe(false)
	})
})
