// One reading of an nginx upstream block. Two readers exist: the deploy-time awk walk
// over `nginx -T` (UPSTREAM_WALK, behind the bridge's upstream checks) and the servers
// list's TypeScript parser (parseUpstreamBlocks, behind the URL discovery). They cannot
// share code (one runs in awk on the server), so this test feeds both the same nginx
// text and compares what each concludes per upstream: the primary entries, the backup
// (bridge) entries, whether a primary lacks max_fails=0, and whether a given loopback
// port is listed as the backup.
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { NGINX_BRIDGE_AWK, NGINX_UPSTREAM_AWK, UPSTREAM_WALK } from '../deploy/fragments'
import { parseNginxRoutes, parseUpstreamBlocks } from '../ssh/discovery'
import {
	API_BRIDGE_VHOST_NO_MAXFAILS,
	BLOG_BRIDGE_VHOST,
	CONTAINER_NGINX_T,
	HOST_VHOST_ROUTES,
	LEGACY_DIRECT_VHOST,
	CONF_D_HOST_MAP,
	PORT_MAP_VHOST,
	SHOP_BRIDGE_VHOST,
	hostNginxDump,
	hostNginxDumpWithConfD,
} from './fixtures/nginx-vhosts'

// the awk walk's own per-block counters, printed one line per upstream
const AWK_DUMP = `${UPSTREAM_WALK}print nm "|" np "|" nb "|" pbad "|" hb } }`

const LOOPBACK = (b: number) => [`127.0.0.1:${b}`, `localhost:${b}`, `[::1]:${b}`]

/** The awk walk's conclusions, computed from the TypeScript reading. */
function tsDump(conf: string, b: number): string[] {
	return parseUpstreamBlocks(conf).map(({ name, entries }) => {
		const primaries = entries.filter((e) => !e.backup)
		const backups = entries.filter((e) => e.backup)
		const pbad = primaries.some((e) => !e.params.includes('max_fails=0')) ? 1 : 0
		const hb = backups.some((e) => LOOPBACK(b).includes(e.address)) ? 1 : 0
		return `${name}|${primaries.length}|${backups.length}|${pbad}|${hb}`
	})
}
function tsScan(conf: string): string[] {
	return parseUpstreamBlocks(conf)
		.filter(({ entries }) => {
			const p = entries.filter((e) => !e.backup)
			return entries.some((e) => e.backup) && p.length === 1 && !p[0]?.params.includes('max_fails=0')
		})
		.map((u) => u.name)
}
function tsBridge(conf: string, b: number): string {
	return tsDump(conf, b).some((l) => l.endsWith('|1')) ? 'ok' : 'no-upstream'
}

const lines = (s: string) => s.split('\n').filter(Boolean)
function hasBin(bin: string): boolean {
	try {
		execFileSync('sh', ['-c', `command -v ${bin}`])
		return true
	} catch {
		return false
	}
}

const CASES: Record<string, string> = {
	'host nginx -T dump of the realistic vhost files': hostNginxDump(),
	'host nginx -T dump with conf.d maps and an upstream reached through a map': hostNginxDumpWithConfD(),
	'map blocks next to upstreams (a map is never read as an upstream)': `${CONF_D_HOST_MAP}${PORT_MAP_VHOST}`,
	'bridge layout': SHOP_BRIDGE_VHOST,
	'bridge layout with tabs and inline comments': BLOG_BRIDGE_VHOST,
	'bridge layout without max_fails=0': API_BRIDGE_VHOST_NO_MAXFAILS,
	'direct proxy_pass only': LEGACY_DIRECT_VHOST,
	'containerized nginx -T': CONTAINER_NGINX_T,
	'one line, no spaces around braces': 'http{upstream x{server 127.0.0.1:3004;server localhost:13004 backup;}}',
	ipv6: 'upstream v6 { server [::1]:3004 max_fails=0; server [::1]:13004 backup; }',
	'several primaries, weights, down, keepalive, unix socket':
		'upstream lb {\n server 10.0.0.1:80 weight=2;\n server unix:/run/a.sock;\n server 10.0.0.2:80 down;\n server 127.0.0.1:13050 backup max_fails=0;\n keepalive 8;\n}',
	'commented-out entry and block': '# upstream gone { server 127.0.0.1:1; }\nupstream half {\n # server 127.0.0.1:3091;\n server 127.0.0.1:3092;\n}',
	'bridge port is not app port + 10000': 'upstream odd { server 127.0.0.1:3004 max_fails=0; server 127.0.0.1:113004 backup; }',
}
const PORTS = [13001, 13004, 13017, 13022, 13050, 13104, 3092, 113004, 9999]

describe('awk and TypeScript read upstream blocks the same way', () => {
	for (const bin of ['mawk', 'gawk', 'awk']) {
		describe.runIf(hasBin(bin))(bin, () => {
			for (const [label, conf] of Object.entries(CASES)) {
				it(label, () => {
					for (const b of PORTS) {
						const awk = lines(execFileSync(bin, ['-v', `b=${b}`, AWK_DUMP], { input: conf }).toString())
						expect(tsDump(conf, b), `b=${b}`).toEqual(awk)
						const verdict = execFileSync(bin, ['-v', `b=${b}`, NGINX_BRIDGE_AWK], { input: conf }).toString().trim()
						expect(tsBridge(conf, b), `bridge b=${b}`).toBe(verdict)
					}
					expect(tsScan(conf)).toEqual(lines(execFileSync(bin, [NGINX_UPSTREAM_AWK], { input: conf }).toString()))
				})
			}
		})
	}

	it('the realistic dump: every bridge upstream has its app port as the one primary and app port + 10000 as backup', () => {
		const blocks = parseUpstreamBlocks(hostNginxDump())
		expect(blocks.map((b) => b.name)).toEqual(['shop_app', 'blog_app', 'demo_api'])
		for (const { entries } of blocks) {
			const [primary, ...more] = entries.filter((e) => !e.backup)
			const backups = entries.filter((e) => e.backup)
			expect(more).toEqual([])
			expect(backups.map((e) => e.port)).toEqual([(primary?.port ?? 0) + 10000])
		}
	})

	it('discovery routes the hostnames to the primaries the awk walk counts, never to the backup', () => {
		const routes = parseNginxRoutes(hostNginxDump())
		expect([...routes].sort((a, b) => (a.port ?? 0) - (b.port ?? 0))).toEqual(HOST_VHOST_ROUTES)
		const backupPorts = parseUpstreamBlocks(hostNginxDump()).flatMap((u) => u.entries.filter((e) => e.backup).map((e) => e.port))
		for (const r of routes) expect(backupPorts).not.toContain(r.port)
	})
})
