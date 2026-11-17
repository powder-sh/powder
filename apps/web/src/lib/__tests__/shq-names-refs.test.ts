import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({}))

import { resolveBaseDomain } from '../app-hosts'
import { composeFileArgs, buildDeployScript, GIT_REF_RE } from '../ssh'
import { swapGateShell } from '../deploy-supersede'

const EVIL = 'x$(touch /tmp/pwn)`id`"'

const base = {
	workingDir: '/opt/apps/demo',
	configFile: '/opt/apps/demo/docker-compose.yml',
	service: 'app',
	cf: composeFileArgs('/opt/apps/demo/docker-compose.yml'),
	declaredMode: 'build',
	prebuilt: false,
	infra: null,
	wantBranch: 'main',
	wantSha: null,
	shaIsStrict: false,
}

describe('shq on interpolated names', () => {
	it('a hostile service name never appears unquoted in the deploy script', () => {
		const s = buildDeployScript({ ...base, service: EVIL })
		const parts = s.split(EVIL)
		expect(parts.length).toBeGreaterThan(1)
		for (let i = 0; i < parts.length - 1; i++) {
			// either its own quoting, or inside an already single-quoted label/filter
			expect(/['|]$/.test(parts[i] ?? '')).toBe(true)
			expect((parts[i + 1] ?? '').startsWith("'")).toBe(true)
		}
	})
	it('a hostile workingDir is quoted in the cd error line and parses under bash', () => {
		const wd = '/opt/apps/a$(touch /tmp/pwn)b'
		const s = buildDeployScript({ ...base, workingDir: wd })
		expect(s).not.toContain(`directory ${wd}`)
		const dir = mkdtempSync(join(tmpdir(), 'powder-shq-'))
		const f = join(dir, 's.sh')
		writeFileSync(f, s)
		execFileSync('bash', ['-n', f])
	})
	it('swap gate quotes the service', () => {
		expect(swapGateShell('/s', null, EVIL)).toContain(`service "'${EVIL}'`)
	})
	it('test gate only runs allow-listed images (a leading dash cannot become a docker flag)', () => {
		const s = buildDeployScript({ ...base, service: 'app' })
		expect(s).toContain('case "$TG_IMG" in -*) TG_IMG=node:22-alpine;; esac')
		expect(s).toContain('refusing powder-test-image')
	})
})

describe('base_domain validated where read', () => {
	it('rejects a base_domain with a quote or space', () => {
		expect(resolveBaseDomain('s1', "x.com' ; touch /tmp/pwn; '")).toBeNull()
		expect(resolveBaseDomain('s1', 'a b.com')).toBeNull()
		expect(resolveBaseDomain('s1', 'Apps.Example.com')).toBe('apps.example.com')
	})
})

describe('git refs', () => {
	it('rejects a leading dash and ..', () => {
		expect(GIT_REF_RE.test('-fexec')).toBe(false)
		expect(GIT_REF_RE.test('a/../b')).toBe(false)
		expect(GIT_REF_RE.test('feat/x-1.2')).toBe(true)
		expect(GIT_REF_RE.test('main')).toBe(true)
	})
})
