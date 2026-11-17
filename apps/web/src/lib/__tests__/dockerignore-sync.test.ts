import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DOCKERIGNORE_PROTECTED_MARKER, writeDockerignoreShell } from '../app-runtime-files'
import { buildDeployScript } from '../deploy/script'

// in the workdir (and preview) layout the workdir is the build context, and
// the hard reset of every deploy put back a tracked .dockerignore without powder's
// entries. The script re-applies them after the sync.

const root = mkdtempSync(join(tmpdir(), 'di-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const git = (dir: string, ...a: string[]) =>
	execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
		encoding: 'utf8',
		// git writes progress ("Reset branch 'main'") to stderr; keep test output clean
		stdio: ['ignore', 'pipe', 'pipe'],
	})

describe('workdir layout: .dockerignore after the workdir sync', () => {
	it('the script re-applies powder entries right after the workdir sync', () => {
		const s = buildDeployScript({
			workingDir: '/opt/apps/shop',
			configFile: '/opt/apps/shop/docker-compose.yml',
			service: 'app',
			cf: "-f '/opt/apps/shop/docker-compose.yml'",
			declaredMode: 'auto',
			prebuilt: false,
			infra: null,
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
		})
		const legacy = s.slice(s.indexOf('elif [ -d .git ]; then'))
		const sync = legacy.indexOf('reset --hard "$TARGET"')
		const di = legacy.indexOf('step "dockerignore" && {')
		expect(sync).toBeGreaterThan(0)
		expect(di).toBeGreaterThan(sync)
		expect(legacy.slice(di, di + 400)).toContain("'/opt/apps/shop/.dockerignore'")
		// the src/ layout (context src/, no secrets inside) is unchanged
		expect(s.slice(0, s.indexOf('elif [ -d .git ]; then'))).not.toContain('step "dockerignore"')
	})

	it('a tracked .dockerignore gets the entries back; the next sync still works', () => {
		const dir = join(root, 'w1')
		execFileSync('git', ['init', '-q', '-b', 'main', dir])
		writeFileSync(join(dir, '.dockerignore'), 'node_modules\n!.deploy-key\n')
		writeFileSync(join(dir, 'a.txt'), '1\n')
		git(dir, 'add', '.')
		git(dir, 'commit', '-qm', 'one')
		const sh = writeDockerignoreShell(dir)
		execFileSync('bash', ['-c', sh])
		const after = readFileSync(join(dir, '.dockerignore'), 'utf8')
		expect(after).toContain(DOCKERIGNORE_PROTECTED_MARKER)
		expect(after.trimEnd().split('\n').pop()).toBe('.powder-*')
		expect(after.indexOf('!.deploy-key')).toBeLessThan(after.lastIndexOf('.deploy-key'))
		// idempotent
		execFileSync('bash', ['-c', sh])
		expect(readFileSync(join(dir, '.dockerignore'), 'utf8')).toBe(after)
		// the next deploy's sync (checkout -f + reset --hard) is not blocked by the edit
		writeFileSync(join(dir, 'a.txt'), '2\n')
		git(dir, 'commit', '-qam', 'two')
		git(dir, 'checkout', '-f', '-B', 'main', 'HEAD~1')
		git(dir, 'reset', '--hard', 'HEAD')
		expect(readFileSync(join(dir, '.dockerignore'), 'utf8')).toBe('node_modules\n!.deploy-key\n')
		execFileSync('bash', ['-c', sh])
		expect(readFileSync(join(dir, '.dockerignore'), 'utf8')).toContain(
			DOCKERIGNORE_PROTECTED_MARKER,
		)
	})

	it('no .dockerignore: powder writes its own (untracked, survives the reset)', () => {
		const dir = join(root, 'w2')
		execFileSync('git', ['init', '-q', '-b', 'main', dir])
		writeFileSync(join(dir, 'a.txt'), '1\n')
		git(dir, 'add', '.')
		git(dir, 'commit', '-qm', 'one')
		execFileSync('bash', ['-c', writeDockerignoreShell(dir)])
		expect(readFileSync(join(dir, '.dockerignore'), 'utf8')).toContain('.deploy-key')
		git(dir, 'reset', '--hard', 'HEAD')
		expect(existsSync(join(dir, '.dockerignore'))).toBe(true)
	})
})
