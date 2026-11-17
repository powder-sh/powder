// 3: the raw include / extends check accepts single-line YAML only. Every
// earlier bypass came from a node spanning lines (a quoted string, a flow collection, a
// block scalar, a plain continuation), so each line must be self-contained.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderOverride } from '../compose-override'
import { renderComposeYaml } from '../compose-render'
import { COMPOSE_RAW_AWK, composeRawGuardShell } from '../deploy/fragments'
import { reservedAppNameError } from '../app-names'
import { buildTraefikLabels } from '../powder-config'
import { HOSTILE_COMPOSE_PROBES } from './fixtures/hostile-compose-probes'

const raw = (text: string, gen = 0) => {
	const r = spawnSync('awk', ['-v', `gen=${gen}`, COMPOSE_RAW_AWK], {
		input: Buffer.from(text, 'latin1'),
		env: { ...process.env, LC_ALL: 'C' },
	})
	return { ok: r.status === 0, out: r.stdout.toString() }
}

describe('every hostile bypass case is refused', () => {
	it('has the probes', () => expect(Object.keys(HOSTILE_COMPOSE_PROBES).length).toBeGreaterThanOrEqual(55))
	for (const [name, text] of Object.entries(HOSTILE_COMPOSE_PROBES)) {
		it(`refuses ${name}`, () => {
			const r = raw(text)
			expect(r.ok).toBe(false)
			expect(r.out).toMatch(/^line \d+: /)
		})
		it(`refuses ${name} in a powder-generated file too`, () => expect(raw(text, 1).ok).toBe(false))
	}
})

describe('multi-line nodes are refused, naming the line', () => {
	const cases: Array<[string, string, string]> = [
		['block scalar', 'services:\n  a:\n    command: |\n      x\n', 'line 3: a block scalar is not supported'],
		['folded block with indicators and a comment', 'services:\n  a:\n    command: >-2 # c\n      x\n', 'line 3: a block scalar is not supported'],
		['block scalar as a sequence item', 'services:\n  a:\n    command:\n      - |\n        x\n', 'line 4: a block scalar is not supported'],
		['the h4 gap: - k: |', 'x-list:\n  - k: |\n      t\n', 'line 2: a block scalar is not supported'],
		['quoted string spanning lines', "x-a: 'abc\n  b'\n", 'line 1: a quoted string spanning lines is not supported'],
		['flow collection spanning lines', 'services:\n  a: {image: x,\n    b: y}\n', 'line 2: a flow collection spanning lines is not supported'],
		['plain continuation line', 'services:\n  a:\n    image: x\n      y\n', 'line 4: a line that is not key:'],
		['merge key', 'services:\n  a:\n    <<: {image: x}\n', 'line 3: a line that is not key:'],
		['anchor', 'x-a: &a\n  image: x\n', 'line 1: an anchor or alias is not supported'],
		['alias', 'services:\n  a:\n    image: *i\n', 'line 3: an anchor or alias is not supported'],
		['tag in a user file', 'services:\n  a:\n    ports: !reset []\n', 'line 3: a YAML tag is not supported'],
		['anchor inside a flow', 'services:\n  a: {image: &i x}\n', 'line 2: an anchor, alias or tag'],
		['text after a quoted string', 'services:\n  a:\n    image: "x" y\n', 'line 3: text after a quoted string'],
		['a tab in the indentation', 'services:\n\t a:\n', 'a tab in the indentation'],
	]
	for (const [name, text, msg] of cases) {
		it(`refuses ${name}`, () => expect(raw(text).out).toContain(msg))
	}
	it('allows only !override and !reset, and only in a generated file', () => {
		expect(raw('services:\n  a:\n    ports: !reset []\n', 1).ok).toBe(true)
		expect(raw('services:\n  a:\n    ports: !!str x\n', 1).ok).toBe(false)
		expect(raw('services:\n  a:\n    ports: !custom x\n', 1).ok).toBe(false)
	})
})

describe("powder's own files and a single-line compose pass", () => {
	it('renderOverride output (labels with JSON headers, CSP wildcard:port, redirects, rewrites, ports) passes as a generated file', () => {
		const { middlewareLabels, middlewareChain } = buildTraefikLabels('myapp', {
			rewrites: [{ source: '^/blog/(.*)', destination: '/posts/$${1}' }],
			redirects: [{ from: '^https?://www\\.example\\.com/(.*)', to: 'https://example.com/$${1}', permanent: true }],
			headers: {
				'Report-To': '{"group":"csp","max_age":10886400,"endpoints":[{"url":"https://x.report-uri.com/a"}]}',
				'Content-Security-Policy': "default-src 'self'; connect-src wss://*.example.com:443",
			},
		})
		const ov = renderOverride({
			service: 'web',
			labels: [...middlewareLabels, `traefik.http.routers.myapp.middlewares=${middlewareChain}`],
			ports: { web: [{ target: 3000, published: '3000', host_ip: '127.0.0.1', protocol: 'tcp' }] } as never,
		})
		expect(raw(ov ?? '', 1)).toEqual({ ok: true, out: '' })
	})
	it('the dfr override (dockerfile_inline: !reset null) and the empty labels file pass as generated files', () => {
		const dfr = 'services:\n  web:\n    build:\n      dockerfile: /var/lib/powder/compose/abc-x/dfr/1.Dockerfile\n      dockerfile_inline: !reset null\n'
		expect(raw(dfr, 1)).toEqual({ ok: true, out: '' })
		expect(raw('services: {}\n', 1)).toEqual({ ok: true, out: '' })
	})
	it('renderComposeYaml (the /new compose, every option) passes as a user file', () => {
		const yaml = renderComposeYaml({
			name: 'blog',
			dockerfilePath: './Dockerfile',
			hostPort: 3100,
			containerPort: 3000,
			envFilePath: '/opt/apps/blog.env',
			publicHost: 'blog.apps.example.com',
			healthUrl: 'https://blog.apps.example.com/api/health',
			traefik: true,
			postgres: { password: 'p4ss', dataDir: '/opt/apps/blog/pgdata' },
			kv: { dataDir: '/opt/apps/blog/kv' },
			sharedInternal: true,
		})
		expect(raw(yaml)).toEqual({ ok: true, out: '' })
	})
	it('a single-line user compose with quoted, flow, JSON and wildcard values passes', () => {
		const text = [
			'# app compose',
			'version: "3.8"',
			'name: shop',
			'services:',
			'  app:',
			'    image: shop:latest',
			'    container_name: shop',
			'    restart: unless-stopped',
			'    build: {context: ./src, dockerfile: Dockerfile}',
			'    env_file: /opt/apps/shop.env',
			"    command: [\"sh\", \"-c\", \"echo \\\"it's\\\" && [ -f /x ]\"]",
			'    ports:',
			'      - "127.0.0.1:3000:3000"',
			'    volumes:',
			'      - ./data:/data',
			'      - type: bind',
			'        source: ./conf',
			'        target: /conf',
			'        read_only: true',
			'    environment:',
			'      CONFIG_JSON: \'{"a":1,"b":"x: y"}\'',
			'      ALLOWED: https://*.example.com:443',
			'      QUERY: a=1&b=*&c=2',
			"      QUOTED: 'it''s'",
			'      EMPTY:',
			'    labels:',
			'      traefik.http.middlewares.a.headers.contentSecurityPolicy: "connect-src wss://*.example.com:443"',
			'    healthcheck:',
			'      test: ["CMD-SHELL", "wget -q -O- http://localhost:3000/api/health || exit 1"]',
			'      interval: 30s',
			'    depends_on:',
			'      db: {condition: service_healthy}',
			'  db:',
			'    image: postgres:16',
			'networks:',
			'  web: {external: true}',
			'---',
			'x-note: "a second document"',
			'',
		].join('\n')
		expect(raw(text)).toEqual({ ok: true, out: '' })
	})
})

describe('composeRawGuardShell decides "generated" by path, never by content', () => {
	it('a !override file outside the compose state dir is refused, inside it passes', () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'gen-')))
		const prev = process.env.POWDER_COMPOSE_STATE_DIR
		try {
			const state = join(root, 'state')
			mkdirSync(join(state, 'k'), { recursive: true })
			const body = 'services:\n  web:\n    ports: !override\n      - target: 3000\n'
			writeFileSync(join(root, 'user.yml'), body)
			writeFileSync(join(state, 'k', 'docker-compose.powder.yml'), body)
			process.env.POWDER_COMPOSE_STATE_DIR = state
			const run = (f: string) => spawnSync('bash', ['-c', `${composeRawGuardShell(`-f '${f}'`)} && echo PASSED`]).stdout.toString()
			expect(run(join(root, 'user.yml'))).toContain('a YAML tag is not supported')
			expect(run(join(state, 'k', 'docker-compose.powder.yml'))).toContain('PASSED')
		} finally {
			if (prev === undefined) delete process.env.POWDER_COMPOSE_STATE_DIR
			else process.env.POWDER_COMPOSE_STATE_DIR = prev
			rmSync(root, { recursive: true, force: true })
		}
	})
})

describe('4: raw backstops, quotes inside plain scalars, continuation lines', () => {
	it('refuses the words extends / include in any case, anywhere, also in comments, values and generated files', () => {
		for (const line of ['# extends', 'x-a: "INCLUDE me"', 'x-a: includeSubDomains', 'x-a: {k: Extends}']) {
			expect(raw(`services: {}\n${line}\n`).out).toContain('line 2: the word extends/include is not allowed anywhere in a compose file')
			expect(raw(`services: {}\n${line}\n`, 1).ok).toBe(false)
		}
	})
	it('refuses \\x \\u \\U \\N \\_ \\L \\P escapes anywhere; other backslashes pass', () => {
		for (const e of ['\\x41', '\\u0041', '\\U00000041', '\\N', '\\_', '\\L', '\\P']) {
			expect(raw(`services:\n  a:\n    image: "a${e}"\n`).out).toContain('escape is not allowed')
		}
		expect(raw('services:\n  a:\n    labels:\n      - "x.regex=^https://www\\\\.(.*)"\n').ok).toBe(true)
	})
	it('refuses control characters other than tab, from the raw bytes', () => {
		for (const c of ['\u000b', '\u000c', '\u0001', '\u007f']) {
			expect(raw(`services:\n  a:\n    image: a${c}\n`).out).toContain('a control character')
		}
		expect(raw('services:\n  a:\n    image: a\rb\n').out).toContain('a carriage return inside a line')
	})
	it('a quote opens a flow node only after { [ , or ": "', () => {
		expect(raw("services:\n  a: {image: alpine, x-a:'q}\n").out).toContain('a quote inside a plain scalar')
		expect(raw('services:\n  a: {image: alpine, x-a: b"c}\n').out).toContain('a quote inside a plain scalar')
		expect(raw("services:\n  a: {image: alpine, x-a: 'q', x-b: [ 'r', \"s\"]}\n").ok).toBe(true)
	})
	it('quotes inside a block plain value pass (common shape); the line is self-contained', () => {
		const text = [
			'services:',
			'  app:',
			'    image: alpine # it\'s "fine"',
			'    command: sh -c "node server.js"',
			"    entrypoint: echo it's",
			'    healthcheck:',
			'      test: wget -q -O- "http://localhost:3000/api/health" || exit 1',
			'      interval: 30s',
			'    labels:',
			"      - x.note=it's \"quoted\"",
			'',
		].join('\n')
		expect(raw(text)).toEqual({ ok: true, out: '' })
		// a quote inside a plain scalar of a FLOW collection stays refused
		expect(raw("services:\n  a: {image: alpine, x-a:'q}\n").out).toContain('a quote inside a plain scalar')
	})
	it('a line indented deeper than the key (or dash) of a value above is a continuation', () => {
		expect(raw('services:\n  a:\n    x-l: abc\n      - b: c\n').out).toContain('line 4: a value continued from the line above')
		expect(raw('services:\n  a:\n    command:\n      - abc\n        def\n').out).toContain('line 5: a value continued from the line above')
		expect(raw('services:\n  a:\n    image: x\n\n    # c\n    ports:\n      - "1:1"\n  b:\n    image: y\n').ok).toBe(true)
		expect(raw('x:\n  - - a\n    - b\n  - name: x\n    image: y\n').ok).toBe(true)
		expect(raw('services:\n  "web":\n    ports: !override\n      - target: 3000\n', 1).ok).toBe(true)
	})
	it('the two benign probes pass (a quoted value with " #", a quoted key with ": ")', () => {
		expect(raw("services:\n  a: {image: alpine, x-a: 'q #'}\n").ok).toBe(true)
		expect(raw('services:\n  a:\n    image: alpine\n    "x-a: b": c\n').ok).toBe(true)
	})
	it('a //, /./ or /../ path under the state dir never counts as generated', () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'gen2-')))
		const prev = process.env.POWDER_COMPOSE_STATE_DIR
		try {
			const state = join(root, 'state')
			mkdirSync(join(state, 'k'), { recursive: true })
			writeFileSync(join(state, 'k', 'o.yml'), 'services:\n  web:\n    ports: !override\n      - target: 3000\n')
			process.env.POWDER_COMPOSE_STATE_DIR = state
			const run = (f: string) => spawnSync('bash', ['-c', `${composeRawGuardShell(`-f '${f}'`)} && echo PASSED`]).stdout.toString()
			expect(run(`${state}/k/o.yml`)).toContain('PASSED')
			for (const f of [`${state}//k/o.yml`, `${state}/./k/o.yml`, `${state}/k/../k/o.yml`]) {
				expect(run(f)).toContain('a YAML tag is not supported')
			}
		} finally {
			if (prev === undefined) delete process.env.POWDER_COMPOSE_STATE_DIR
			else process.env.POWDER_COMPOSE_STATE_DIR = prev
			rmSync(root, { recursive: true, force: true })
		}
	})
})

describe("4: powder never writes the words or escapes into a compose file", () => {
	it('powder.json entries carrying them are dropped at validation (e.g. HSTS includeSubDomains)', () => {
		const { middlewareLabels } = buildTraefikLabels('myapp', {
			rewrites: [{ source: '^/include/(.*)', destination: '/x/$${1}' }],
			redirects: [{ from: '^/a', to: '/\\u0041' }],
			headers: { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains', 'X-Extends': '1', 'X-Ok': 'yes' },
		})
		expect(middlewareLabels.join('\n')).not.toMatch(/extends|include|\\[xuUN_LP]/i)
		expect(middlewareLabels.some((l) => l.endsWith('X-Ok=yes'))).toBe(true)
	})
	it('new app names may not hold them', () => {
		expect(reservedAppNameError('my-include-app')).toContain('extends')
		expect(reservedAppNameError('ExtendsX')).toContain('extends')
		expect(reservedAppNameError('shop')).toBeNull()
	})
	it('renderComposeYaml and renderOverride output hold neither', () => {
		const yaml = renderComposeYaml({
			name: 'blog',
			dockerfilePath: './Dockerfile',
			hostPort: 3100,
			containerPort: 3000,
			envFilePath: '/opt/apps/blog.env',
			publicHost: 'blog.apps.example.com',
			traefik: true,
			postgres: { password: 'p4ss', dataDir: '/opt/apps/blog/pgdata' },
			kv: { dataDir: '/opt/apps/blog/kv' },
			sharedInternal: true,
		})
		const ov = renderOverride({
			service: 'web',
			labels: ['traefik.enable=true'],
			ports: { web: [{ target: 3000, published: '3000', host_ip: '127.0.0.1', protocol: 'tcp' }] } as never,
		})
		for (const t of [yaml, ov ?? '']) expect(t).not.toMatch(/extends|include|\\[xuUN_LP]/i)
	})
})
