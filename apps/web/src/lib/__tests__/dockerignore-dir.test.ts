// a tracked `.dockerignore/` DIRECTORY made the protected-ignore write fail
// (`> dir` is an error) and, inside the deploy's `step && { ... } && next` chain where
// set -e does not apply, the chain went on without powder's entries. Real bash runs.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { protectExistingIgnoreShell, writeDockerignoreShell } from '../app-runtime-files'
import { builderDockerignoreShell } from '../builder'

const tmp = () => mkdtempSync(join(tmpdir(), 'powder-r25di-'))
// The deploy script's shape: set -e, then the write inside an && chain.
const chain = (inner: string) =>
	spawnSync('bash', ['-c', `set -e; step(){ :; }; step dockerignore && { ${inner}; } && echo CHAIN-CONTINUES`], {
		encoding: 'utf8',
	})

describe('a non-file ignore path stops the script', () => {
	it('a .dockerignore directory is refused and the chain stops', () => {
		const d = tmp()
		mkdirSync(join(d, '.dockerignore'))
		const r = chain(writeDockerignoreShell(d))
		expect(r.status).not.toBe(0)
		expect(r.stdout).not.toContain('CHAIN-CONTINUES')
		expect(r.stderr).toContain('not a regular file')
		expect(statSync(join(d, '.dockerignore')).isDirectory()).toBe(true)
	})
	it('a Dockerfile.dockerignore directory is refused (default and named Dockerfile)', () => {
		for (const df of [undefined, 'web/app.Dockerfile']) {
			const d = tmp()
			mkdirSync(join(d, 'web'))
			const p = df ? join(d, `${df}.dockerignore`) : join(d, 'Dockerfile.dockerignore')
			mkdirSync(p)
			const r = chain(writeDockerignoreShell(d, df))
			expect(r.status).not.toBe(0)
			expect(r.stdout).not.toContain('CHAIN-CONTINUES')
			expect(r.stderr).toContain('not a regular file')
			// nothing was moved into the directory
			expect(spawnSync('ls', ['-A', p], { encoding: 'utf8' }).stdout).toBe('')
		}
	})
	it('protectExistingIgnoreShell alone refuses a directory', () => {
		const d = tmp()
		mkdirSync(join(d, 'x.dockerignore'))
		const r = chain(protectExistingIgnoreShell(join(d, 'x.dockerignore')))
		expect(r.status).not.toBe(0)
		expect(r.stdout).not.toContain('CHAIN-CONTINUES')
	})
	it('builder path: a .dockerignore directory is refused', () => {
		const d = tmp()
		mkdirSync(join(d, '.dockerignore'))
		const r = spawnSync('bash', ['-c', `set -e; ${builderDockerignoreShell(d)} echo CHAIN-CONTINUES`], {
			encoding: 'utf8',
		})
		expect(r.status).not.toBe(0)
		expect(r.stdout).not.toContain('CHAIN-CONTINUES')
	})
	it.skipIf(process.getuid?.() === 0)('a failed write of a new .dockerignore stops the chain', () => {
		const d = tmp()
		chmodSync(d, 0o555)
		try {
			const r = chain(writeDockerignoreShell(d))
			expect(r.status).not.toBe(0)
			expect(r.stdout).not.toContain('CHAIN-CONTINUES')
			expect(r.stderr).toContain('could not write')
		} finally {
			chmodSync(d, 0o755)
		}
		expect(existsSync(join(d, '.dockerignore'))).toBe(false)
	})
	it('a plain checkout still gets its .dockerignore and the chain continues', () => {
		const d = tmp()
		const r = chain(writeDockerignoreShell(d))
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('CHAIN-CONTINUES')
		expect(readFileSync(join(d, '.dockerignore'), 'utf8')).toContain('.deploy-key')
	})
})
