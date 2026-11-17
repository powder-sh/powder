// compose `include` (with its own env_file / project_directory) and `extends`
// are refused on the RAW compose files, before any `docker compose config` runs.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COMPOSE_RAW_AWK, composeRawGuardShell, composeUpCommand, envFileLinkGuardShell } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'

const raw = (text: string, gen = 0) => {
	const r = spawnSync('awk', ['-v', `gen=${gen}`, COMPOSE_RAW_AWK], { input: text, env: { ...process.env, LC_ALL: 'C' } })
	return { ok: r.status === 0, out: r.stdout.toString() }
}

describe('COMPOSE_RAW_AWK', () => {
	const allowed: Record<string, string> = {
		plain: 'services:\n  app:\n    image: a\n',
		'labels, cron, shell, quoted root key': [
			'# comment',
			'version: "3.8"',
			'x-common:',
			'  restart: always',
			'services:',
			'  app:',
			'    image: a',
			'    labels:',
			'      - "traefik.http.routers.a.rule=Host(`a.com`)"',
			'      - "x.regex=^https://www\\\\.(.*)"',
			'    command: ["sh", "-c", "[ ! -f /x ] && echo hi"]',
			'    environment:',
			'      CRON: "*/5 * * * *"',
			'"volumes":',
			'  data: {}',
			'',
		].join('\n'),
		crlf: 'services:\r\n  app:\r\n    image: a\r\n',
		bom: '\ufeffservices:\n  a:\n    image: x\n',
	}
	for (const [name, text] of Object.entries(allowed)) {
		it(`allows ${name}`, () => expect(raw(text)).toEqual({ ok: true, out: '' }))
	}
	const override = 'services:\n  "app":\n    labels:\n      - "a=b"\n    ports: !override\n      - target: 3000\n'
	it('allows !override only in a file powder generates (gen=1)', () => {
		expect(raw(override, 1)).toEqual({ ok: true, out: '' })
		expect(raw(override).out).toContain('a YAML tag is not supported')
	})

	const refused: Record<string, string> = {
		// hostile case: an include that reaches another app's env file
		'include with env_file': 'include:\n  - path: ./inc.yml\n    env_file: ../victim/victim.env\n',
		'include with project_directory': 'include:\n  - path: ./inc2.yml\n    project_directory: ../victim\n',
		'quoted include': '"include":\n  - x\n',
		'indented root': '  include:\n    - x\n  services: {}\n',
		'flow root': '{include: [x], services: {}}\n',
		'root merge': 'x-a: &a\n  include: [x]\n<<: *a\nservices: {}\n',
		'escaped key': '"\\x69nclude": [x]\n',
		'extends with file': 'services:\n  a:\n    extends:\n      file: ../v/c.yml\n      service: v\n',
		'alias as key': 'x-k: &k extends\nservices:\n  a:\n    *k : {file: ../v.yml, service: v}\n',
		'unicode escape key': 'services:\n  a:\n    "ext\\u0065nds": {file: ../v.yml}\n',
		'binary tag key': 'services:\n  a:\n    !!binary ZXh0ZW5kcw==: {file: ../v.yml}\n',
		'lone CR': 'services:\n  a: {image: x}\rinclude: [x]\n',
		'explicit key': 'services:\n  a:\n    ? extends\n    : {file: x}\n',
		'directive': '%TAG !e! tag:yaml.org,2002:\n---\nservices: {}\n',
		'second document': 'services: {}\n---\ninclude: [x]\n',
		'flow after ---': 'services: {}\n--- {include: [x]}\n',
		'single-quoted extends': "services:\n  a:\n    'extends': {file: x}\n",
		'tagged root key': '!!str include: [x]\n',
		'unicode line separator': 'services: {}\n\u2028include: [x]\n',
	}
	for (const [name, text] of Object.entries(refused)) {
		it(`refuses ${name}`, () => {
			const r = raw(text)
			expect(r.ok).toBe(false)
			expect(r.out).toMatch(/^line \d+: /)
		})
	}
})

describe('composeRawGuardShell (every -f file)', () => {
	let root: string
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'raw-')))
		writeFileSync(join(root, 'ok.yml'), 'services:\n  app:\n    image: a\n')
		writeFileSync(join(root, 'inc.yml'), 'include:\n  - path: ./x.yml\n    env_file: ../victim/victim.env\n')
	})
	afterAll(() => rmSync(root, { recursive: true, force: true }))
	const run = (cf: string) => {
		const r = spawnSync('bash', ['-c', `${composeRawGuardShell(cf)} && echo PASSED`])
		return { ok: r.status === 0 && r.stdout.toString().includes('PASSED'), out: r.stdout.toString() }
	}
	it('passes clean files', () => expect(run(`-f '${root}/ok.yml'`).ok).toBe(true))
	it('refuses include in the second -f file, naming file and line', () => {
		const r = run(`-f '${root}/ok.yml' -f '${root}/inc.yml'`)
		expect(r.ok).toBe(false)
		expect(r.out).toContain(`compose file guard: refusing, ${root}/inc.yml`)
		expect(r.out).toContain('line 1: an include key')
	})
	it('skips a missing -f file (compose itself fails on it)', () => expect(run(`-f '${root}/nope.yml'`).ok).toBe(true))
	it('refuses a -f path that is a directory', () => expect(run(`-f '${root}'`).ok).toBe(false))
	it('reads the override shell test form of composeFileArgs', () => {
		const r = run(`-f '${root}/ok.yml' $([ -f '${root}/inc.yml' ] && printf '%s %s' -f '${root}/inc.yml')`)
		expect(r.ok).toBe(false)
	})
})

describe('wiring', () => {
	it('the env file guard runs the raw check before its first compose config', () => {
		const g = envFileLinkGuardShell("-f '/opt/apps/a/docker-compose.yml'", 'a', '/opt/apps/a')
		expect(g.indexOf('cr_files')).toBeGreaterThan(-1)
		expect(g.indexOf('cr_files')).toBeLessThan(g.indexOf('docker compose'))
	})
	it('the deploy script runs the guard before the preflight compose config', () => {
		const s = buildDeployScript({
			workingDir: '/opt/apps/a',
			configFile: '/opt/apps/a/docker-compose.yml',
			service: 'a',
			cf: "-f '/opt/apps/a/docker-compose.yml'",
			declaredMode: 'build',
			prebuilt: false,
			infra: null,
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
		})
		expect(s.indexOf('cr_files')).toBeGreaterThan(-1)
		expect(s.indexOf('cr_files')).toBeLessThan(s.indexOf('compose file is INVALID'))
	})
	it('composeUpCommand runs it before up', () => {
		const c = composeUpCommand('/opt/apps/shop/docker-compose.yml', 'shop', '/opt/apps/shop', { approval: { hash: '', app: null, log: '' } })
		expect(c.indexOf('cr_files')).toBeLessThan(c.indexOf('up -d --no-build'))
	})
})
