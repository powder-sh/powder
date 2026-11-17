// writeEnvFile writes the temp over SFTP, then changes its owner and mode. chown /
// chmod in a later ssh call would follow links, so the temp is checked (regular,
// root-owned, one link) in the same command, and chown never follows.
import { spawnSync } from 'node:child_process'
import { chmodSync, createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const hook: { before: ((cmd: string) => void) | null } = { before: null }
let env: NodeJS.ProcessEnv = process.env
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		if (cmd.includes('chown -h "$OWN"')) hook.before?.(cmd)
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

const { writeEnvFile } = await import('../ssh/files')

function setup(statOut: string) {
	const root = mkdtempSync(join(tmpdir(), 'envtmp-'))
	const stubs = join(root, 'stubs')
	mkdirSync(stubs)
	writeFileSync(join(stubs, 'getent'), '#!/bin/sh\nexit 2\n')
	writeFileSync(join(stubs, 'chown'), '#!/bin/sh\necho "chown $*" >> "$CALLS"\n')
	writeFileSync(join(stubs, 'stat'), `#!/bin/sh\necho '${statOut}'\n`)
	for (const n of ['getent', 'chown', 'stat']) chmodSync(join(stubs, n), 0o755)
	const calls = join(root, 'calls')
	writeFileSync(calls, '')
	env = { ...process.env, PATH: `${stubs}:${process.env.PATH}`, POWDER_ENV_STATE: join(root, 'state'), CALLS: calls }
	const dir = join(root, 'apps')
	mkdirSync(dir)
	const victim = join(root, 'victim')
	writeFileSync(victim, 'SECRET=1\n')
	chmodSync(victim, 0o644)
	return { root, dir, victim, calls }
}

describe('the env temp file is not followed', () => {
	it('a temp swapped for a link after the upload is refused; the link target keeps its mode', async () => {
		const t = setup('0 1')
		try {
			hook.before = () => {
				const tmp = readdirSync(t.dir).find((n) => n !== 'shop.env') ?? ''
				rmSync(join(t.dir, tmp))
				symlinkSync(t.victim, join(t.dir, tmp))
			}
			await expect(writeEnvFile({ id: 's', host: 'h' } as never, join(t.dir, 'shop.env'), 'A=1\n')).rejects.toThrow(/not the regular file powder wrote/)
			expect(statSync(t.victim).mode & 0o777).toBe(0o644)
			expect(readFileSync(t.calls, 'utf8')).toBe('')
		} finally {
			hook.before = null
			rmSync(t.root, { recursive: true, force: true })
		}
	})
	it('a hard-linked or foreign-owned temp is refused', async () => {
		for (const out of ['0 2', '1000 1']) {
			const t = setup(out)
			try {
				await expect(writeEnvFile({ id: 's', host: 'h' } as never, join(t.dir, 'shop.env'), 'A=1\n')).rejects.toThrow(/not the regular file/)
			} finally {
				rmSync(t.root, { recursive: true, force: true })
			}
		}
	})
	it('a plain write passes, with chown -h', async () => {
		const t = setup('0 1')
		try {
			await writeEnvFile({ id: 's', host: 'h' } as never, join(t.dir, 'shop.env'), 'A=1\n')
			expect(readFileSync(join(t.dir, 'shop.env'), 'utf8')).toBe('A=1\n')
			expect(readFileSync(t.calls, 'utf8')).toMatch(/^chown -h root:root /)
		} finally {
			rmSync(t.root, { recursive: true, force: true })
		}
	})
})
