// a repo .dockerignore could re-include powder's secrets with a
// later `!.deploy-key` / `!*.env` line, and BuildKit reads <Dockerfile>.dockerignore
// INSTEAD of the context's file. powder's protected entries now go LAST in both.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROTECTED_DOCKERIGNORE_LINES, writeDockerignoreShell } from '../app-runtime-files'
import { builderDockerignoreShell } from '../builder'

const bash = (script: string) =>
	spawnSync('bash', ['-c', `set -e; ${script}`], { encoding: 'utf8' })
const tmp = () => mkdtempSync(join(tmpdir(), 'powder-di5-'))
const lines = (f: string) => readFileSync(f, 'utf8').trim().split('\n')
const tail = (f: string) => lines(f).slice(-PROTECTED_DOCKERIGNORE_LINES.length)

describe('protected .dockerignore entries are written last', () => {
	it('a negation after powder entries does not win (writeDockerignoreShell)', () => {
		const d = tmp()
		writeFileSync(
			join(d, '.dockerignore'),
			'.deploy-key\n*.env\n!.deploy-key\n!prod.env\n.git\n!.git/HEAD\n',
		)
		expect(bash(writeDockerignoreShell(d)).status).toBe(0)
		const f = join(d, '.dockerignore')
		expect(tail(f)).toEqual([...PROTECTED_DOCKERIGNORE_LINES])
		// the repo's own lines stay, .git keeps its place so `!.git/HEAD` still works
		expect(lines(f).slice(0, 4)).toEqual(['!.deploy-key', '!prod.env', '.git', '!.git/HEAD'])
		const once = readFileSync(f, 'utf8')
		expect(bash(writeDockerignoreShell(d)).status).toBe(0)
		expect(readFileSync(f, 'utf8')).toBe(once)
	})
	it('an existing ignore file without .git stays without .git; a new file gets it', () => {
		const d = tmp()
		writeFileSync(join(d, '.dockerignore'), 'node_modules\n')
		writeFileSync(join(d, 'Dockerfile.dockerignore'), 'node_modules\n')
		expect(bash(writeDockerignoreShell(d)).status).toBe(0)
		expect(lines(join(d, '.dockerignore'))).not.toContain('.git')
		expect(lines(join(d, 'Dockerfile.dockerignore'))).not.toContain('.git')
		const b = tmp()
		writeFileSync(join(b, '.dockerignore'), 'node_modules\n')
		writeFileSync(join(b, 'Dockerfile.x.dockerignore'), 'node_modules\n')
		expect(
			bash(`${builderDockerignoreShell(b, join(b, 'Dockerfile.x'))} echo OK`).stdout,
		).toContain('OK')
		expect(lines(join(b, '.dockerignore'))).not.toContain('.git')
		expect(lines(join(b, 'Dockerfile.x.dockerignore'))).not.toContain('.git')
		const n = tmp()
		expect(bash(writeDockerignoreShell(n)).status).toBe(0)
		expect(lines(join(n, '.dockerignore'))).toContain('.git')
		const nb = tmp()
		expect(bash(`${builderDockerignoreShell(nb)} echo OK`).stdout).toContain('OK')
		expect(lines(join(nb, '.dockerignore'))).toContain('.git')
	})
	it('<Dockerfile>.dockerignore next to the Dockerfile gets the entries too', () => {
		const d = tmp()
		mkdirSync(join(d, 'web'))
		writeFileSync(join(d, 'Dockerfile.dockerignore'), '!.deploy-key\n')
		writeFileSync(join(d, 'web/app.Dockerfile.dockerignore'), '*\n!.deploy-key\n')
		expect(bash(writeDockerignoreShell(d, 'web/app.Dockerfile')).status).toBe(0)
		expect(tail(join(d, 'Dockerfile.dockerignore'))).toEqual([...PROTECTED_DOCKERIGNORE_LINES])
		expect(tail(join(d, 'web/app.Dockerfile.dockerignore'))).toEqual([
			...PROTECTED_DOCKERIGNORE_LINES,
		])
	})
	it('a symlinked <Dockerfile>.dockerignore is refused', () => {
		const d = tmp()
		writeFileSync(join(d, 'victim'), 'x\n')
		symlinkSync(join(d, 'victim'), join(d, 'Dockerfile.dockerignore'))
		expect(bash(writeDockerignoreShell(d)).status).not.toBe(0)
		expect(readFileSync(join(d, 'victim'), 'utf8')).toBe('x\n')
	})
	it('builder path: repo negations and the Dockerfile ignore file are neutralized', () => {
		const d = tmp()
		writeFileSync(join(d, '.dockerignore'), '.deploy-key\n!.deploy-key\n')
		writeFileSync(join(d, 'Dockerfile.prod.dockerignore'), '!*.env\n')
		const r = bash(`${builderDockerignoreShell(d, join(d, 'Dockerfile.prod'))} echo OK`)
		expect(r.stdout).toContain('OK')
		expect(tail(join(d, '.dockerignore'))).toEqual([...PROTECTED_DOCKERIGNORE_LINES])
		expect(tail(join(d, 'Dockerfile.prod.dockerignore'))).toEqual([...PROTECTED_DOCKERIGNORE_LINES])
	})
})
