import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const STATE = mkdtempSync(join(tmpdir(), 'ovr-state-'))
process.env.POWDER_COMPOSE_STATE_DIR = STATE

// Local bash stands in for the server; docker compose itself is REAL (config only, no daemon).
const sh = (cmd: string) => {
	const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })
	return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}
vi.mock('../ssh/connection', () => ({ runCommand: async (_s: unknown, cmd: string) => sh(cmd) }))
vi.mock('../ssh', () => ({
	runCommand: async (_s: unknown, cmd: string) => sh(cmd),
	writeFileViaSftp: async (_s: unknown, path: string, contents: string, mode: number) => writeFileSync(path, contents, { mode }),
}))

import { renderLabelsBlock } from '../app-domains'
import {
	composeVersionOk,
	inProjectOverridePathFor,
	overrideDirFor,
	labelLinesFromBlock,
	overridePathFor,
	parseOverrideLabels,
	planPorts,
	renderOverride,
} from '../compose-override'
import { applyComposeOverride } from '../compose-override-io'
import { composeFileArgs } from '../deploy/fragments'

const hasCompose = spawnSync('docker', ['compose', 'version', '--short']).status === 0
const noRedirects = { redirects: [], rewrites: [], headers: {} }
const labelsFor = () =>
	labelLinesFromBlock(renderLabelsBlock({ containerName: 'app', hosts: ['a.example.com'], containerPort: 3000, redirects: noRedirects }))
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

type Cfg = { services: Record<string, { labels?: Record<string, string>; ports?: Array<{ published?: string; host_ip?: string; target: number }> }> }
const config = (files: string[]): { code: number; json: Cfg } => {
	const r = spawnSync('docker', ['compose', ...files.flatMap((f) => ['-f', f]), 'config', '--format', 'json'], { encoding: 'utf8' })
	return { code: r.status ?? 1, json: r.status === 0 ? (JSON.parse(r.stdout) as Cfg) : ({ services: {} } as Cfg) }
}

const SIBLINGS = `  db:
    image: postgres:17
    ports:
      - "5432:5432"
  web:
    image: nginx:alpine
    ports:
      - "80:80"
`

const SHAPES: Array<{ name: string; files: string[]; optOut?: boolean; userLabels: string[] }> = [
	{
		name: 'list labels, 2-space indent, short ports',
		userLabels: ['custom.keep', 'powder.bridge.enabled'],
		files: [
			`services:\n  app:\n    image: demo\n    labels:\n      - custom.keep=1\n      - powder.bridge.enabled=true\n    ports:\n      - "3000:3000"\n${SIBLINGS}`,
		],
	},
	{
		name: 'map labels, 4-space indent',
		userLabels: ['custom.keep'],
		files: [
			`services:\n    app:\n        image: demo\n        labels:\n            custom.keep: "1"\n        ports:\n            - "3000:3000"\n${SIBLINGS.replace(/^ {2}/gm, '    ').replace(/^ {4}(image|ports)/gm, '        $1').replace(/^ {6}-/gm, '            -')}`,
		],
	},
	{
		name: 'multi-file with flow-style ports in the second file',
		userLabels: ['custom.keep'],
		files: [
			`services:\n  app:\n    image: demo\n    labels:\n      custom.keep: "1"\n    ports:\n      - "3000:3000"\n${SIBLINGS}`,
			`services:\n  app:\n    ports: ["8080:3000"]\n`,
		],
	},
	{
		name: 'long-syntax ports with the opt-out label (map form)',
		userLabels: ['powder.public-port', 'custom.keep'],
		optOut: true,
		files: [
			`services:\n  app:\n    image: demo\n    labels:\n      powder.public-port: "true"\n      custom.keep: "1"\n    ports:\n      - target: 3000\n        published: "3000"\n        protocol: tcp\n${SIBLINGS}`,
		],
	},
	{
		name: 'variable with a default',
		userLabels: [],
		files: [`services:\n  app:\n    image: demo\n    ports:\n      - "\${PORT:-3100}:3000"\n${SIBLINGS}`],
	},
]

describe.skipIf(!hasCompose)('compose override matrix (real docker compose config)', () => {
	for (const shape of SHAPES) {
		it(shape.name, () => {
			const dir = mkdtempSync(join(tmpdir(), 'ovr-'))
			const files = shape.files.map((c, i) => {
				const f = join(dir, i === 0 ? 'docker-compose.yml' : `extra${i}.yml`)
				writeFileSync(f, c)
				return f
			})
			const before = files.map(sha)
			const base = config(files)
			expect(base.code).toBe(0)

			const plan = planPorts(base.json, 'app')
			const yaml = renderOverride({ service: 'app', labels: labelsFor(), ports: plan.overrides }) ?? ''
			// two deploy ids => the same bytes (nothing per-deploy in the render)
			expect(renderOverride({ service: 'app', labels: labelsFor(), ports: planPorts(base.json, 'app').overrides })).toBe(yaml)
			const ov = overridePathFor(files[0] ?? '')
			expect(ov.startsWith(STATE)).toBe(true) // outside the workdir
			mkdirSync(overrideDirFor(files[0] ?? ''), { recursive: true })
			writeFileSync(ov, yaml)

			const merged = config([...files, ov])
			expect(merged.code).toBe(0) // resolved config parses
			expect(files.map(sha)).toEqual(before) // user files untouched

			const app = merged.json.services.app
			if (!app) throw new Error('no app service in the merged config')
			for (const k of shape.userLabels) expect(Object.keys(app.labels ?? {})).toContain(k) // user labels survive
			expect(app.labels?.['traefik.enable']).toBe('true')
			expect(app.labels?.['traefik.http.routers.app.rule']).toBe('Host(`a.example.com`)')

			const appPorts = app.ports ?? []
			if (shape.optOut) {
				expect(appPorts.every((p) => !p.host_ip)).toBe(true) // opt-out respected
				expect(plan.notes.join('\n')).toContain('powder.public-port=true')
			} else {
				expect(appPorts.length).toBeGreaterThan(0)
				expect(appPorts.every((p) => p.host_ip === '127.0.0.1')).toBe(true) // loopback applied
			}
			// sibling db bound, nginx left and reported
			expect(merged.json.services.db?.ports?.every((p) => p.host_ip === '127.0.0.1')).toBe(true)
			expect(merged.json.services.web?.ports?.every((p) => !p.host_ip)).toBe(true)
			expect(plan.notes.join('\n')).toContain('left public: web')
			expect(plan.notes.join('\n')).not.toContain('left public: db')
		})
	}
})

describe('planPorts / renderOverride / helpers (pure)', () => {
	it('old compose cannot use !override: reported, nothing replaced', () => {
		const cfg = { services: { app: { image: 'demo', ports: [{ target: 3000, published: '3000', protocol: 'tcp' }] } } }
		const p = planPorts(cfg, 'app', { allowOverride: false })
		expect(p.overrides).toEqual({})
		expect(p.notes.join('\n')).toContain('left public: app compose older than 2.24')
	})
	it('version check', () => {
		expect(composeVersionOk('2.35.1')).toBe(true)
		expect(composeVersionOk('v2.24.0')).toBe(true)
		expect(composeVersionOk('2.23.9')).toBe(false)
		expect(composeVersionOk('')).toBe(false)
	})
	it('labels round-trip through the override file; $ is escaped for compose', () => {
		const y = renderOverride({ service: 'app', labels: ['a=1', 'rule=Host(`x`) && Path(`/$1`)'], ports: {} }) ?? ''
		expect(y).toContain('# generated by powder, do not edit')
		expect(y).toContain('$$1')
		expect(parseOverrideLabels(y, 'app')).toEqual(['a=1', 'rule=Host(`x`) && Path(`/$1`)'])
		expect(renderOverride({ service: 'app', labels: null, ports: {} })).toBeNull()
	})
	it('composeFileArgs puts the override last and only when it exists', () => {
		const args = composeFileArgs('/opt/apps/x/docker-compose.yml')
		const abs = overridePathFor('/opt/apps/x/docker-compose.yml')
		expect(abs.startsWith('/')).toBe(true)
		expect(abs).not.toContain('/opt/apps/x/')
		expect(args).toBe(`-f '/opt/apps/x/docker-compose.yml' $([ -f '${abs}' ] && printf '%s %s' -f '${abs}')`)
		const r = sh(`echo ${args.replace(/^-f '[^']+' /, '')} | cat`)
		expect(r.stdout.trim()).toBe('')
	})
})

describe.skipIf(!hasCompose)('applyComposeOverride (writer)', () => {
	const facts = (dir: string) => ({ workingDir: dir, configFile: join(dir, 'docker-compose.yml'), service: 'app' })
	it('writes once, is idempotent, keeps labels for port-only callers, never follows a leftover link', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ovw-'))
		const compose = join(dir, 'docker-compose.yml')
		writeFileSync(compose, `services:\n  app:\n    image: demo\n    ports:\n      - "3000:3000"\n`)
		const before = sha(compose)
		const victim = join(dir, 'victim')
		writeFileSync(victim, 'ORIGINAL')
		const dest = overridePathFor(compose)
		mkdirSync(overrideDirFor(compose), { recursive: true })
		symlinkSync(victim, dest)
		// an in-checkout copy written by an earlier build is removed
		const legacy = inProjectOverridePathFor(compose)
		writeFileSync(legacy, 'services: {app: {privileged: true}}\n')

		const first = await applyComposeOverride({} as never, facts(dir), { labels: labelsFor(), appName: 'app' })
		expect(first.changed).toBe(true)
		expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL')
		expect(lstatSync(dest).isSymbolicLink()).toBe(false)
		expect(statSync(dest).mode & 0o777).toBe(0o644)
		expect(sha(compose)).toBe(before)
		expect(existsSync(legacy)).toBe(false)
		expect(existsSync(join(dir, 'docker-compose.powder.yml'))).toBe(false)
		const text = readFileSync(dest, 'utf8')
		expect(text).toContain('ports: !override')
		expect(text).toContain('"127.0.0.1"')

		const second = await applyComposeOverride({} as never, facts(dir), { labels: labelsFor(), appName: 'app' })
		expect(second.changed).toBe(false)

		// port-only caller (labels undefined) keeps the labels already there
		const portOnly = await applyComposeOverride({} as never, facts(dir), { appName: 'app' })
		expect(portOnly.changed).toBe(false)
		expect(readFileSync(dest, 'utf8')).toBe(text)

		// labels null drops them, ports stay
		const dropped = await applyComposeOverride({} as never, facts(dir), { labels: null, appName: 'app' })
		expect(dropped.changed).toBe(true)
		expect(readFileSync(dest, 'utf8')).not.toContain('traefik.enable')
		expect(existsSync(dest)).toBe(true)
	})
	it('pins pull_policy never on every build service only; a later labels.yml pin wins; recreates read the file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ovw-'))
		const compose = join(dir, 'docker-compose.yml')
		mkdirSync(join(dir, 'src'))
		writeFileSync(join(dir, 'src', 'Dockerfile'), 'FROM alpine\n')
		writeFileSync(
			compose,
			`services:\n  app:\n    image: ghcr.io/example-org/payroll:latest\n    build:\n      context: ./src\n  worker:\n    image: demo-worker\n    build: ./src\n  rebuilt:\n    image: demo-rebuilt\n    build: ./src\n    pull_policy: build\n  db:\n    image: postgres:17\n`,
		)
		await applyComposeOverride({} as never, facts(dir), { labels: null, appName: 'app' })
		const dest = overridePathFor(compose)
		const text = readFileSync(dest, 'utf8')
		expect(text).toContain('  "app":\n    cap_drop:\n      - "NET_RAW"\n    pull_policy: never\n')
		expect(text).toContain('  "worker":\n    cap_drop:\n      - "NET_RAW"\n    pull_policy: never\n')
		expect(text).not.toMatch(/"db":\n {4}cap_drop:\n {6}- "NET_RAW"\n {4}pull_policy/)
		type P = { services: Record<string, { pull_policy?: string }> }
		const merged = config([compose, dest]).json as unknown as P
		expect(merged.services.app?.pull_policy).toBe('never')
		expect(merged.services.worker?.pull_policy).toBe('never')
		expect(merged.services.db?.pull_policy).toBeUndefined()
		// an app's own pull_policy: build (rebuilt every deploy) is kept
		expect(merged.services.rebuilt?.pull_policy).toBe('build')
		expect(text).not.toMatch(/"rebuilt":\n {4}cap_drop:\n {6}- "NET_RAW"\n {4}pull_policy/)
		// the deploy's label step pins a service it built back to missing in a LATER file
		const lb = join(dir, 'labels.yml')
		writeFileSync(lb, 'services:\n  worker:\n    pull_policy: missing\n')
		const withLb = config([compose, dest, lb]).json as unknown as P
		expect(withLb.services.worker?.pull_policy).toBe('missing')
		expect(withLb.services.app?.pull_policy).toBe('never')
		// every composeUpCommand caller passes composeFileArgs(...), which names this file
		expect(composeFileArgs(compose)).toContain(dest)
	})
	it('an unparseable user compose is refused when labels are required', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ovw-'))
		writeFileSync(join(dir, 'docker-compose.yml'), 'services: [broken\n')
		await expect(
			applyComposeOverride({} as never, facts(dir), { labels: labelsFor(), appName: 'app', requireConfig: true }),
		).rejects.toThrow(/does not parse/)
		const soft = await applyComposeOverride({} as never, facts(dir), { appName: 'app' })
		expect(soft.changed).toBe(false)
	})
})
