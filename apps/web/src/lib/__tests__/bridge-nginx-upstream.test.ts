import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	NGINX_BRIDGE_AWK,
	NGINX_UPSTREAM_AWK,
	bridgeShellFunctions,
	nginxUpstreamMarkerFor,
	parseNginxUpstreamVerdict,
} from '../deploy/fragments'
import { reportDeployWarningsToHq } from '../hq'
import { writeFakeDocker } from './fixtures/fake-docker'
import { pathWithout } from './hermetic'

// An upstream with one primary and a backup: when the primary lacks max_fails=0,
// a few slow requests that hit proxy_read_timeout mark the only primary down and
// nginx answers 502/503 "no live upstreams" while the backup port is empty. Every
// deploy scans the host nginx config (read-only) per server; host-port bridge apps
// also get a per-app check that an upstream lists the bridge port as backup.

const NONCE = 'abc123'
const MARK = nginxUpstreamMarkerFor(NONCE)

const HEAD = `# configuration file /etc/nginx/nginx.conf:
user www-data;
http {
\tlog_format main '$remote_addr $upstream_addr "#x" $upstream_response_time';
\tinclude /etc/nginx/sites-enabled/*;
}
`

// One upstream shared by two vhosts.
const SHOP = (primary: string) => `${HEAD}
# configuration file /etc/nginx/sites-enabled/shop.example.com:
upstream shop_app {
    ${primary};
    server 127.0.0.1:13004 backup;
}
server {
\tserver_name shop.example.com;
\tlocation / { proxy_pass http://shop_app; proxy_next_upstream error; }
}
# configuration file /etc/nginx/sites-enabled/stats.shop.example.com:
server { server_name stats.shop.example.com; location / { proxy_pass http://shop_app; proxy_next_upstream error; } }
`
const SHOP_BAD = SHOP('server 127.0.0.1:3004')
const SHOP_FIXED = SHOP('server 127.0.0.1:3004 max_fails=0')

// Correct host-port bridge block.
const BLOG = `${HEAD}
# configuration file /etc/nginx/sites-enabled/blog.example.com:
upstream blog_app {
\tserver 127.0.0.1:3001 max_fails=0;   # app
\tserver 127.0.0.1:13001 backup;
}
server { location / { proxy_pass http://blog_app; proxy_next_upstream error timeout; } }
`

// No upstream lists bridge port 13004: the vhost proxies straight to the app.
const NO_UPSTREAM = `${HEAD}
upstream other_app { server 127.0.0.1:3005 max_fails=0; server 127.0.0.1:13005 backup; }
server { location / { proxy_pass http://127.0.0.1:3004; } }
`

function scan(bin: string, conf: string): string[] {
	return execFileSync(bin, [NGINX_UPSTREAM_AWK], { input: conf })
		.toString()
		.split('\n')
		.filter(Boolean)
}
function bridge(bin: string, conf: string, b = '13004'): string {
	return execFileSync(bin, ['-v', `b=${b}`, NGINX_BRIDGE_AWK], { input: conf })
		.toString()
		.trim()
}

function hasBin(bin: string): boolean {
	try {
		execFileSync('sh', ['-c', `command -v ${bin}`])
		return true
	} catch {
		return false
	}
}

function fakeNginx(dir: string, conf: string | null) {
	if (conf === null) return
	writeFileSync(join(dir, 'conf'), conf)
	writeFileSync(
		join(dir, 'nginx'),
		`#!/bin/bash\n[ "$1" = -T ] || exit 9\ncat ${join(dir, 'conf')}\necho "nginx: configuration file /etc/nginx/nginx.conf test is successful" >&2\n`,
		{ mode: 0o755 },
	)
}

// PATH: the stub dir + the system dirs without nginx, so a host nginx never leaks in.
function sh(dir: string, body: string): string {
	return execFileSync('bash', ['-c', body], {
		env: { ...process.env, PATH: `${dir}:${pathWithout(['nginx'])}` },
	}).toString()
}

function fns(nonce = NONCE) {
	return bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo', nonce)
}

/** bridge_nginx_scan alone against a fake nginx -T. */
function runScan(conf: string | null, nonce = NONCE): string {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-ngx-'))
	fakeNginx(dir, conf)
	return sh(dir, `${fns(nonce)} bridge_nginx_scan; echo rc=$?`)
}

/** bridge_start on a host-network app with no bridge labels. */
function runStartUnbridged(conf: string | null): string {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-ngx-'))
	fakeNginx(dir, conf)
	writeFakeDocker(
		dir,
		`#!/bin/bash
case "$*" in
 *"ps -q"*) echo oldid;;
 *State.Running*) echo true;;
 *'index .Config.Labels "powder.bridge.enabled"'*) echo;;
 *'range $k,$v := .Config.Labels'*) echo 'com.docker.compose.service=shop';;
 *NetworkMode*) echo host;;
esac
exit 0
`,
	)
	writeFileSync(join(dir, 'curl'), '#!/bin/bash\necho 200\n', { mode: 0o755 })
	return sh(dir, `cap() { echo "$1"; }; ${fns()} bridge_start; echo rc=$?`)
}

describe('per-server nginx scan (NGINX_UPSTREAM_AWK)', () => {
	for (const bin of ['mawk', 'gawk', 'awk']) {
		it.runIf(hasBin(bin))(`${bin}: classifies the fixtures`, () => {
			expect(scan(bin, SHOP_BAD)).toEqual(['shop_app'])
			expect(scan(bin, SHOP_FIXED)).toEqual([])
			expect(scan(bin, BLOG)).toEqual([])
			expect(scan(bin, NO_UPSTREAM)).toEqual([])
			expect(bridge(bin, BLOG, '13001')).toBe('ok')
			expect(bridge(bin, SHOP_BAD)).toBe('ok')
			expect(bridge(bin, NO_UPSTREAM)).toBe('no-upstream')
			expect(
				scan(bin, 'http{upstream x{server 127.0.0.1:3004;server [::1]:13004 backup;}}'),
			).toEqual(['x'])
		})
	}
	it('multi-primary groups and single-server groups never match', () => {
		expect(
			scan(
				'awk',
				'upstream lb { server 10.0.0.1:80; server 10.0.0.2:80; server 10.0.0.3:80 backup; }',
			),
		).toEqual([])
		expect(scan('awk', 'upstream one { server 127.0.0.1:3004; }')).toEqual([])
		expect(scan('awk', 'upstream ka { server 127.0.0.1:3004; keepalive 8; }')).toEqual([])
	})
	it('any primary address counts, other directives are ignored', () => {
		expect(
			scan(
				'awk',
				'upstream u { zone u 64k; server unix:/run/app.sock; server 127.0.0.1:13004 backup; keepalive 4; }',
			),
		).toEqual(['u'])
	})
	it('lists every bad upstream', () => {
		expect(
			scan(
				'awk',
				`${SHOP_BAD}\nupstream b_app { server 127.0.0.1:3009 weight=2; server 127.0.0.1:13009 backup; }`,
			),
		).toEqual(['shop_app', 'b_app'])
	})
	it('reads `{upstream x{` without spaces', () => {
		const ok = 'http{upstream x{server 127.0.0.1:3004 max_fails=0;server localhost:13004 backup;}}'
		expect(scan('awk', ok)).toEqual([])
		expect(bridge('awk', ok)).toBe('ok')
		expect(
			scan('awk', 'http{upstream x{server 127.0.0.1:3004;server localhost:13004 backup;}}'),
		).toEqual(['x'])
	})
	it('recognises [::1]:PORT server lines', () => {
		expect(scan('awk', 'upstream v6 { server [::1]:3004; server [::1]:13004 backup; }')).toEqual([
			'v6',
		])
		expect(
			bridge('awk', 'upstream v6 { server [::1]:3004 max_fails=0; server [::1]:13004 backup; }'),
		).toBe('ok')
	})
	it('bridge port matches whole: 13004 is not 113004', () => {
		expect(
			bridge('awk', 'upstream x { server 127.0.0.1:3004; server 127.0.0.1:113004 backup; }'),
		).toBe('no-upstream')
	})
	it('a commented-out max_fails=0 or backup does not count', () => {
		expect(
			scan(
				'awk',
				'upstream x {\n server 127.0.0.1:3004; # max_fails=0;\n server 127.0.0.1:13004 backup;\n}',
			),
		).toEqual(['x'])
		expect(
			scan('awk', 'upstream x {\n server 127.0.0.1:3004;\n# server 127.0.0.1:13004 backup;\n}'),
		).toEqual([])
		expect(
			bridge(
				'awk',
				'upstream x {\n server 127.0.0.1:3004 max_fails=0;\n# server 127.0.0.1:13004 backup;\n}',
			),
		).toBe('no-upstream')
	})
	it('empty config is clean', () => {
		expect(scan('awk', '')).toEqual([])
		expect(bridge('awk', '')).toBe('no-upstream')
	})
})

describe('bridge_nginx_scan / bridge_start', () => {
	it('shop: host-network app with no bridge labels still gets the scan; card lists shop_app', () => {
		const out = runStartUnbridged(SHOP_BAD)
		expect(out).toContain(
			'[nginx] WARNING: upstream(s) with one primary without max_fails=0 plus a backup: shop_app',
		)
		expect(parseNginxUpstreamVerdict(out, NONCE)).toEqual({ server: ['shop_app'], app: 'n/a' })
		expect(out).toContain('rc=0')
	})
	it('shop fixed: scan is clean and resolves', () => {
		const out = runStartUnbridged(SHOP_FIXED)
		expect(out).not.toContain('WARNING: upstream')
		expect(parseNginxUpstreamVerdict(out, NONCE)).toEqual({ server: [], app: 'n/a' })
	})
	it('nginx absent: server part unknown, app part n/a', () => {
		const out = runStartUnbridged(null)
		expect(out).not.toContain('[nginx]')
		expect(parseNginxUpstreamVerdict(out, NONCE)).toEqual({ server: null, app: 'n/a' })
	})
	it('nginx -T failing: silent', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bridge-ngx-'))
		writeFileSync(
			join(dir, 'nginx'),
			'#!/bin/bash\necho "nginx: [emerg] unknown directive" >&2\nexit 1\n',
			{
				mode: 0o755,
			},
		)
		expect(sh(dir, `${fns()} bridge_nginx_scan; echo rc=$?`).trim()).toBe('rc=0')
	})
	it('never prints the nginx config itself', () => {
		const out = runScan(SHOP_BAD)
		expect(out).not.toContain('server_name')
		expect(out).not.toContain('log_format')
	})
	it('no nonce: logs but prints no marker', () => {
		const out = runScan(SHOP_BAD, '')
		expect(out).toContain('WARNING')
		expect(out).not.toContain('__POWDER_NGINXUP_')
	})
	it('bridge_nginx_check: ok, no-upstream, silent without nginx', () => {
		for (const [conf, want] of [
			[SHOP_FIXED, 'ok'],
			[NO_UPSTREAM, 'no-upstream'],
		] as const) {
			const dir = mkdtempSync(join(tmpdir(), 'bridge-ngx-'))
			fakeNginx(dir, conf)
			const out = sh(dir, `${fns()} B_NGA=""; bridge_nginx_check 13004; echo "nga=$B_NGA"`)
			expect(out).toContain(`nga=${want}`)
			if (want === 'no-upstream')
				expect(out).toContain(
					"[bridge] WARNING: no nginx upstream lists 'server 127.0.0.1:13004 backup;'",
				)
		}
		const dir = mkdtempSync(join(tmpdir(), 'bridge-ngx-'))
		expect(sh(dir, `${fns()} B_NGA=""; bridge_nginx_check 13004; echo "nga=$B_NGA"`).trim()).toBe(
			'nga=',
		)
	})
	it('bridge_start: scan first, per-app check only in host-port mode, n/a outside it', () => {
		const s = fns()
		// the scan runs first, except for a dns-alias app (no host nginx in its path)
		expect(s).toContain('then echo "[nginx] host nginx checks not run (powder.bridge.dns-alias app: its proxy reaches it by docker DNS name)"; else bridge_nginx_scan; fi; B_NGA=""; bridge_start_body;')
		expect(s).toContain(
			'app host port + 10000\'; bridge_stop; return 0; fi; bridge_nginx_check "$B_HP"; fi; ',
		)
		expect(s).toContain('elif [ -z "$B_HP" ]; then B_NGA=n/a;')
		expect(s).toContain('if [ -n "$B_DNS" ]; then B_NGA=n/a;')
		expect(s).toContain('not enabled (label powder.bridge.enabled=true)"; B_NGA=n/a;')
	})
	it('generated shell passes bash -n', () => {
		execFileSync('bash', ['-n'], { input: fns() })
	})
	it('only the nonce-tagged marker counts; bad names are dropped', () => {
		const none = { server: null, app: null }
		expect(parseNginxUpstreamVerdict(`${MARK} scan a b\nbuild: ${MARK} scan`, NONCE)).toEqual({
			server: ['a', 'b'],
			app: null,
		})
		expect(parseNginxUpstreamVerdict(`${MARK} scan a\n${MARK} scan`, NONCE)).toEqual({
			server: [],
			app: null,
		})
		expect(parseNginxUpstreamVerdict(`${MARK} scan a;rm`, NONCE)).toEqual(none)
		expect(parseNginxUpstreamVerdict('__POWDER_NGINXUP_other__ scan x', NONCE)).toEqual(none)
		expect(parseNginxUpstreamVerdict(`${MARK} app nonsense`, NONCE)).toEqual(none)
		expect(parseNginxUpstreamVerdict(`${MARK} app no-upstream`, NONCE)).toEqual({
			server: null,
			app: 'no-upstream',
		})
		expect(parseNginxUpstreamVerdict(`${MARK} scan x`, '')).toEqual(none)
	})
})

describe('nginx HQ cards', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		delete process.env.POWDER_HQ_INGEST_TOKEN
		delete process.env.POWDER_HQ_GENERIC_URL
	})
	it('per-server card lists bad upstreams, resolves on an empty list; per-app card resolves on ok and n/a', async () => {
		process.env.POWDER_HQ_INGEST_TOKEN = 't'
		process.env.POWDER_HQ_GENERIC_URL = 'http://hq/generic'
		const bodies: Record<string, unknown>[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_u: string, i: { body: string }) => {
				bodies.push(JSON.parse(i.body))
				return new Response('ok')
			}),
		)
		const base = { app: 'shop', server: 'web1', envRefusedKeys: null, builderFallback: null }
		const srv = () => bodies.filter((b) => b.source_ref === 'nginx-upstream:web1')
		const app = () => bodies.filter((b) => b.source_ref === 'bridge-upstream:web1/shop')
		await reportDeployWarningsToHq({
			...base,
			nginxUpstream: { server: ['shop_app'], app: 'n/a' },
		})
		expect(srv()).toHaveLength(1)
		expect(srv()[0]).toMatchObject({ severity: 'warn', source: 'powder-deploy-warn' })
		expect(String(srv()[0]?.body)).toContain('shop_app')
		expect(String(srv()[0]?.body)).toContain('no live upstreams')
		expect(app()[0]?.resolve).toBe(true)
		await reportDeployWarningsToHq({ ...base, nginxUpstream: { server: null, app: null } })
		await reportDeployWarningsToHq({ ...base })
		expect(srv()).toHaveLength(1)
		expect(app()).toHaveLength(1)
		await reportDeployWarningsToHq({ ...base, nginxUpstream: { server: [], app: 'no-upstream' } })
		expect(srv()[1]?.resolve).toBe(true)
		expect(app()[1]).toMatchObject({ severity: 'warn', project: 'shop' })
		await reportDeployWarningsToHq({ ...base, nginxUpstream: { server: [], app: 'ok' } })
		expect(app()[2]?.resolve).toBe(true)
	})
})
