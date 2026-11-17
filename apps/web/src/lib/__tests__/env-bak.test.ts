import { spawnSync } from 'node:child_process'
import { chmodSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

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

import { envStateDirName, writeEnvFile } from '../ssh/files'

describe('writeEnvFile .bak', () => {
	it('does not write through a planted .bak symlink', async () => {
		const root = mkdtempSync(join(tmpdir(), 'powder-s9-'))
		const stubs = join(root, 'stubs')
		mkdirSync(stubs)
		for (const n of ['chown', 'getent']) {
			writeFileSync(join(stubs, n), n === 'getent' ? '#!/bin/sh\nexit 2\n' : '#!/bin/sh\nexit 0\n')
			chmodSync(join(stubs, n), 0o755)
		}
		// the temp-file check reads `stat -c '%u %h'` (GNU); root-owned, one link
		writeFileSync(join(stubs, 'stat'), "#!/bin/sh\necho '0 1'\n")
		chmodSync(join(stubs, 'stat'), 0o755)
		const state = join(root, 'state')
		env = { ...process.env, PATH: `${stubs}:${process.env.PATH}`, POWDER_ENV_STATE: state }
		const victim = join(root, 'victim')
		writeFileSync(victim, 'ORIGINAL')
		const path = join(root, 'app.env')
		writeFileSync(path, 'OLD=1\n')
		symlinkSync(victim, `${path}.bak`)
		await writeEnvFile({ id: 's', host: 'h' } as never, path, 'NEW=2\n')
		expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
		// the .bak lives in the powder state dir; the planted link next to the file is never touched
		expect(lstatSync(`${path}.bak`).isSymbolicLink()).toBe(true)
		expect(readFileSync(join(state, envStateDirName(path), 'bak'), 'utf8')).toBe('OLD=1\n')
		expect(readFileSync(path, 'utf8')).toBe('NEW=2\n')
		expect(existsSync(`${path}.tmp`)).toBe(false)
		expect(cmds.some((c) => c.includes('chown -h'))).toBe(true)
	})
})
