// discovery cannot forge records or plant app_domains rows for any hostname.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const ran = vi.hoisted(() => ({
	cmds: [] as string[],
	fakeBin: '',
	/** the host proxy master as the fake /proc shows it:
	 *  running    pid file -> live `nginx` in the host pid namespace
	 *  stopped    nginx installed, no pid file
	 *  stale      pid file -> a live `bash` (the pid was reused by another host process)
	 *  container  pid file -> a live `nginx` in ANOTHER pid namespace (a container's)
	 *  no-ns      pid file -> a live `nginx` whose /proc/<pid>/ns is unreadable
	 *  openresty  pid file -> a live `openresty` in the host namespace, nginx binary present
	 *  off-path   pid file -> a live `nginx` in the host namespace, no nginx binary on PATH
	 *  absent     nothing installed, no pid file */
	hostNginx: 'running' as 'running' | 'stopped' | 'stale' | 'container' | 'no-ns' | 'openresty' | 'off-path' | 'absent',
}))
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		ran.cmds.push(cmd)
		// the command reads the server's host nginx config: point it at a test dir, never
		// this host's real proxy config (nor its pid files, /proc or /opt/apps)
		const f = ran.fakeBin
		const local = cmd
			.replaceAll('/etc/nginx/sites-enabled/', `${f}/sites-enabled/`)
			.replaceAll('/etc/nginx/conf.d/', `${f}/conf.d/`)
			.replaceAll('/var/run/', `${f}/run/`)
			.replaceAll(' /run/', ` ${f}/run/`)
			.replaceAll('/usr/local/openresty/nginx/logs/', `${f}/run/`)
			.replaceAll('/proc/', `${f}/proc/`)
			// app space for the host-config check only (the container working-dir check keeps
			// the literal /opt/apps its fixtures print)
			.replaceAll('readlink -f /opt/apps ', `readlink -f ${f}/opt-apps `)
			.replaceAll('OPTR:-/opt/apps}', `OPTR:-${f}/opt-apps}`)
			.replaceAll('inapp() { case "$1" in (/opt/apps|/opt/apps/*|', `inapp() { case "$1" in (${f}/opt-apps|${f}/opt-apps/*|`)
		if (f) {
			const st = ran.hostNginx
			mkdirSync(join(f, 'opt-apps'), { recursive: true })
			// never this host's own nginx: a test without a fake one gets an nginx that fails
			if (st !== 'absent' && st !== 'off-path' && !existsSync(join(f, 'nginx')))
				writeFileSync(join(f, 'nginx'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
			if (st === 'off-path') rmSync(join(f, 'nginx'), { force: true })
			mkdirSync(join(f, 'run'), { recursive: true })
			// pid 1 and the pid file's process 4242, each with its pid namespace link
			rmSync(join(f, 'proc', '1'), { recursive: true, force: true })
			rmSync(join(f, 'proc', '4242'), { recursive: true, force: true })
			mkdirSync(join(f, 'proc', '1', 'ns'), { recursive: true })
			symlinkSync('pid:[4026531836]', join(f, 'proc', '1', 'ns', 'pid'))
			mkdirSync(join(f, 'proc', '4242'), { recursive: true })
			const comm = st === 'stale' ? 'bash' : st === 'openresty' ? 'openresty' : 'nginx'
			writeFileSync(join(f, 'proc', '4242', 'comm'), `${comm}\n`)
			if (st !== 'no-ns') {
				mkdirSync(join(f, 'proc', '4242', 'ns'))
				symlinkSync(st === 'container' ? 'pid:[4026532999]' : 'pid:[4026531836]', join(f, 'proc', '4242', 'ns', 'pid'))
			}
			if (st === 'stopped' || st === 'absent') rmSync(join(f, 'run', 'nginx.pid'), { force: true })
			else writeFileSync(join(f, 'run', 'nginx.pid'), '4242\n')
		}
		// PATH without any real nginx: the fake bin dir first, then the hermetic system dirs
		const r = spawnSync('bash', ['-c', local], {
			env: { ...process.env, PATH: `${f}:${pathWithout(['nginx'])}` },
			maxBuffer: 64 * 1024 * 1024,
		})
		return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.status ?? 1 }
	},
}))

import { getNginxRoutes, parseHostNetInfo } from '../ssh/discovery'
import { isUnprovenClaim } from '../app-domains'
import { writeFakeDocker } from './fixtures/fake-docker'
import { pathWithout } from './hermetic'
import {
	CONF_D_HOST_MAP,
	CONTAINER_NGINX_T,
	HOST_VHOST_FILES,
	HOST_VHOST_ROUTES,
	LEGACY_DIRECT_VHOST,
	MAPPED_APPS_VHOST,
	SHOP_BRIDGE_VHOST,
	hostNginxDumpWithConfD,
} from './fixtures/nginx-vhosts'

describe('host net info is parsed from JSON, one line per container', () => {
	it('an env value with a newline cannot forge a second record', () => {
		const env = JSON.stringify(['PORT=3000', 'X=a\nevil\thost\t[]\t{"traefik.http.routers.x.rule":"Host(`victim.com`)"}'])
		const out = parseHostNetInfo(
			`/app\tbridge\t${env}\t${JSON.stringify({ 'com.docker.compose.service': 'web', 'traefik.http.routers.a.rule': 'Host(`a.example.com`)' })}\n`,
		)
		expect([...out.keys()]).toEqual(['app'])
		expect(out.get('app')).toEqual({
			networkMode: 'bridge',
			envPort: 3000,
			composeService: 'web',
			traefikHosts: ['a.example.com'],
		})
	})
	it('skips malformed lines', () => {
		expect(parseHostNetInfo('/x\tbridge\tnot json\t{}\n/y\thost\n').size).toBe(0)
	})
})

describe('nginx -T runs only in proxy containers powder does not manage', () => {
	it('skips registered apps and every container of their compose projects', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'disc-'))
		const log = join(dir, 'exec.log')
		writeFakeDocker(dir, [
				'#!/bin/bash',
				'case "$1" in',
				'  ps) printf "%s\\n" app-nginx app-proxy-sidecar edge-nginx other ;;',
				'  inspect) n="${@: -1}"; case "$n" in app-nginx|app-proxy-sidecar) echo appproj ;; edge-nginx) echo edge ;; *) echo "" ;; esac ;;',
				// the bridge layout (named upstream, primary + backup) the servers really use
				`  exec) echo "$2" >> ${JSON.stringify(log)}; echo "upstream $2_app { server 127.0.0.1:3000 max_fails=0; server 127.0.0.1:13000 backup; } server { server_name $2.example.com; proxy_pass http://$2_app; }" ;;`,
				'esac',
			].join('\n'))
		ran.fakeBin = dir
		// app-nginx is a registered app; app-proxy-sidecar shares its compose project.
		const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, ['app-nginx'])
		const execd = spawnSync('cat', [log]).stdout.toString().split('\n').filter(Boolean)
		expect(execd).toEqual(['edge-nginx'])
		expect(routes).toEqual([{ host: '127.0.0.1', port: 3000, urls: ['http://edge-nginx.example.com'] }])
		rmSync(dir, { recursive: true, force: true })
	})
})

describe('getNginxRoutes on the real vhost shape (named upstream + bridge backup)', () => {
	it('host vhost files and a proxy container with upstreams resolve to their primaries', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'disc-'))
		mkdirSync(join(dir, 'sites-enabled'))
		for (const [f, body] of Object.entries(HOST_VHOST_FILES)) writeFileSync(join(dir, 'sites-enabled', f), body)
		writeFileSync(join(dir, 'nginx-t.txt'), CONTAINER_NGINX_T)
		writeFakeDocker(dir, [
			'#!/bin/bash',
			'case "$1" in',
			'  ps) printf "%s\\n" edge-nginx ;;',
			'  inspect) echo "" ;;',
			`  exec) cat ${JSON.stringify(join(dir, 'nginx-t.txt'))} ;;`,
			'esac',
		].join('\n'))
		ran.fakeBin = dir
		const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, ['shop'])
		const byKey = (r: { host: string | null; port: number | null }) => `${r.host}|${r.port}`
		expect([...routes].sort((a, b) => byKey(a).localeCompare(byKey(b)))).toEqual([
			...HOST_VHOST_ROUTES,
			{ host: 'notes-web', port: 3000, urls: ['https://notes.example.com'] },
		])
		rmSync(dir, { recursive: true, force: true })
	})
})

describe('the host config: nginx -T of a running host nginx, else sites-enabled and conf.d', () => {
	const fakeDocker = (dir: string) =>
		writeFakeDocker(dir, ['#!/bin/bash', 'case "$1" in', '  ps) ;;', '  *) echo "" ;;', 'esac'].join('\n'))
	const ports = (routes: Array<{ port: number | null; urls: string[] }>) =>
		Object.fromEntries(routes.filter((r) => r.port != null).map((r) => [r.port, r.urls]))
	const fakeNginxT = (dir: string, dump: string) => {
		writeFileSync(join(dir, 'dump.txt'), dump)
		writeFileSync(join(dir, 'nginx'), `#!/bin/bash\n[ "$1" = -T ] && cat ${JSON.stringify(join(dir, 'dump.txt'))}\n`, {
			mode: 0o755,
		})
	}
	/** create every file a dump's headers name (except `skip`), so the headers resolve */
	const materialize = (dump: string, skip: string[] = []) => {
		for (const m of dump.matchAll(/^# configuration file (.*):$/gm)) {
			const p = m[1] ?? ''
			if (skip.includes(p) || existsSync(p)) continue
			mkdirSync(join(p, '..'), { recursive: true })
			writeFileSync(p, '# placeholder\n')
		}
	}
	const setup = (state: typeof ran.hostNginx = 'running') => {
		const dir = mkdtempSync(join(tmpdir(), 'disc-'))
		fakeDocker(dir)
		ran.fakeBin = dir
		ran.hostNginx = state
		return dir
	}
	const MAPPED = {
		3017: ['https://shop.example.com'],
		3101: ['https://alpha.example.com'],
		3102: ['https://beta.example.com'],
		3104: ['https://gamma.example.com'],
		3201: ['https://orders.example.com'],
		3202: ['https://desk.example.com'],
	}

	it('normal case: maps and upstreams in conf.d resolve', async () => {
		const dir = setup()
		const dump = hostNginxDumpWithConfD(undefined, join(dir, 'etc-nginx'))
		materialize(dump)
		fakeNginxT(dir, dump)
		const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
		expect(ports(routes)).toEqual(MAPPED)
		expect(routes.hostSkipped).toBeUndefined()
		rmSync(dir, { recursive: true, force: true })
	})

	it('a file under app space, with a spoofed header inside it: nothing of the host config is read', async () => {
		const dir = setup()
		mkdirSync(join(dir, 'opt-apps', 'shop'), { recursive: true })
		const appFile = join(dir, 'opt-apps', 'shop', 'nginx-extra.conf')
		writeFileSync(appFile, 'server {}')
		const dump = hostNginxDumpWithConfD(appFile, join(dir, 'etc-nginx'))
		materialize(dump, [join(dir, 'etc-nginx', 'fake.conf')])
		fakeNginxT(dir, dump)
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
		expect([...routes]).toEqual([])
		expect(routes.hostSkipped).toBe('app-space')
		expect(warn.mock.calls.join(' ')).toContain('host routes not read')
		warn.mockRestore()
		rmSync(dir, { recursive: true, force: true })
	})

	it('a sites-enabled symlink into app space fails closed, in the nginx -T and in the file path', async () => {
		for (const viaT of [true, false]) {
			const dir = setup()
			mkdirSync(join(dir, 'opt-apps', 'shop'), { recursive: true })
			mkdirSync(join(dir, 'sites-enabled'))
			writeFileSync(join(dir, 'opt-apps', 'shop', 'vhost'), SHOP_BRIDGE_VHOST)
			symlinkSync(join(dir, 'opt-apps', 'shop', 'vhost'), join(dir, 'sites-enabled', 'shop'))
			writeFileSync(join(dir, 'sites-enabled', 'legacy'), LEGACY_DIRECT_VHOST)
			// nginx prints the include path as written: the symlink, not its target
			if (viaT)
				fakeNginxT(
					dir,
					`# configuration file ${join(dir, 'sites-enabled', 'shop')}:\n${SHOP_BRIDGE_VHOST}\n# configuration file ${join(dir, 'sites-enabled', 'legacy')}:\n${LEGACY_DIRECT_VHOST}`,
				)
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
			warn.mockRestore()
			expect([...routes], `viaT=${viaT}`).toEqual([])
			expect(routes.hostSkipped).toBe('app-space')
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it('nginx -T failing on a running nginx: the sites-enabled and conf.d files', async () => {
		const dir = setup()
		mkdirSync(join(dir, 'sites-enabled'))
		mkdirSync(join(dir, 'conf.d'))
		writeFileSync(join(dir, 'conf.d', 'apps-map.conf'), CONF_D_HOST_MAP)
		writeFileSync(join(dir, 'conf.d', 'ignored.txt'), 'server { server_name nope.example.com; proxy_pass http://127.0.0.1:1; }')
		writeFileSync(join(dir, 'sites-enabled', 'mapped-apps'), MAPPED_APPS_VHOST)
		const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
		expect(ports(routes)).toEqual({
			3101: ['https://alpha.example.com'],
			3102: ['https://beta.example.com'],
			3104: ['https://gamma.example.com'],
		})
		rmSync(dir, { recursive: true, force: true })
	})

	it('nginx installed but no master running: the host is skipped, proxy containers are still read', async () => {
		const dir = setup('stopped')
		fakeNginxT(dir, hostNginxDumpWithConfD())
		writeFileSync(join(dir, 'nginx-t.txt'), CONTAINER_NGINX_T)
		writeFakeDocker(dir, ['#!/bin/bash', 'case "$1" in', '  ps) printf "%s\\n" edge-nginx ;;', '  inspect) echo "" ;;', `  exec) cat ${JSON.stringify(join(dir, 'nginx-t.txt'))} ;;`, 'esac'].join('\n'))
		const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
		expect([...routes]).toEqual([{ host: 'notes-web', port: 3000, urls: ['https://notes.example.com'] }])
		expect(routes.hostSkipped).toBe('not-running')
		rmSync(dir, { recursive: true, force: true })
	})

	it('a stale pid file (the pid is not nginx) counts as not running; the config can name the pid file', async () => {
		const dir = setup('stale')
		fakeNginxT(dir, hostNginxDumpWithConfD())
		const stale = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
		expect([...stale]).toEqual([])
		expect(stale.hostSkipped).toBe('not-running')
		rmSync(dir, { recursive: true, force: true })

		const dir2 = setup('stopped')
		mkdirSync(join(dir2, 'proc', '77', 'ns'), { recursive: true })
		writeFileSync(join(dir2, 'proc', '77', 'comm'), 'nginx\n')
		symlinkSync('pid:[4026531836]', join(dir2, 'proc', '77', 'ns', 'pid'))
		writeFileSync(join(dir2, 'custom.pid'), '77\n')
		writeFileSync(join(dir2, 'nginx.conf'), '# placeholder\n')
		fakeNginxT(dir2, `# configuration file ${join(dir2, 'nginx.conf')}:\npid ${join(dir2, 'custom.pid')};\n${LEGACY_DIRECT_VHOST}`)
		const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
		expect(ports(routes)).toEqual({ 3005: ['https://legacy.example.com', 'https://www.legacy.example.com'] })
		rmSync(dir2, { recursive: true, force: true })
	})

	it('a pid reused by a container nginx (another pid namespace) or an unreadable ns counts as not running', async () => {
		for (const st of ['container', 'no-ns'] as const) {
			const dir = setup(st)
			const dump = hostNginxDumpWithConfD(undefined, join(dir, 'etc-nginx'))
			materialize(dump)
			fakeNginxT(dir, dump)
			const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
			expect([...routes], st).toEqual([])
			expect(routes.hostSkipped, st).toBe('not-running')
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it('an openresty master, or a running nginx with no nginx binary on PATH: the file lists are read', async () => {
		for (const st of ['openresty', 'off-path'] as const) {
			const dir = setup(st)
			mkdirSync(join(dir, 'sites-enabled'))
			writeFileSync(join(dir, 'sites-enabled', 'legacy'), LEGACY_DIRECT_VHOST)
			// an nginx -T that would claim other hostnames is not used for an openresty master
			if (st === 'openresty') fakeNginxT(dir, `# configuration file ${join(dir, 'sites-enabled', 'legacy')}:\n${SHOP_BRIDGE_VHOST}`)
			const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
			expect(ports(routes), st).toEqual({ 3005: ['https://legacy.example.com', 'https://www.legacy.example.com'] })
			expect(routes.hostSkipped, st).toBeUndefined()
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it('a file name with a newline cannot slip past the app-space check (dump headers and file list)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		// via nginx -T: the header is cut at the newline; its first part still names app space
		const dir = setup()
		const shopDir = join(dir, 'opt-apps', 'shop')
		mkdirSync(shopDir, { recursive: true })
		writeFileSync(join(shopDir, 'a\nb.conf'), 'server {}')
		const root = join(dir, 'etc-nginx')
		const dump = `# configuration file ${root}/nginx.conf:\nhttp { include ${shopDir}/*.conf; }\n# configuration file ${shopDir}/a\nb.conf:\nserver { listen 443 ssl; server_name planted.example.com; location / { proxy_pass http://127.0.0.1:3017; } }\n`
		materialize(dump)
		fakeNginxT(dir, dump)
		const viaT = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
		expect([...viaT]).toEqual([])
		expect(viaT.hostSkipped).toBe('app-space')
		rmSync(dir, { recursive: true, force: true })

		// via the file list: a sites-enabled entry named with a newline, linked into app space
		const dir2 = setup()
		mkdirSync(join(dir2, 'opt-apps', 'shop'), { recursive: true })
		mkdirSync(join(dir2, 'sites-enabled'))
		writeFileSync(join(dir2, 'opt-apps', 'shop', 'vhost'), 'server { listen 443 ssl; server_name planted.example.com; location / { proxy_pass http://127.0.0.1:3017; } }')
		symlinkSync(join(dir2, 'opt-apps', 'shop', 'vhost'), join(dir2, 'sites-enabled', 'x\ny'))
		writeFileSync(join(dir2, 'sites-enabled', 'legacy'), LEGACY_DIRECT_VHOST)
		const viaFiles = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
		expect([...viaFiles]).toEqual([])
		expect(viaFiles.hostSkipped).toBe('app-space')
		rmSync(dir2, { recursive: true, force: true })
		warn.mockRestore()
	})

	it('a header whose path does not exist: unverifiable, nothing read', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const dir = setup()
		const root = join(dir, 'etc-nginx')
		const dump = hostNginxDumpWithConfD(undefined, root)
		materialize(dump, [`${root}/sites-enabled/ports`])
		fakeNginxT(dir, dump)
		const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
		expect([...routes]).toEqual([])
		expect(routes.hostSkipped).toBe('unverifiable')
		expect(warn.mock.calls.join(' ')).toContain('could not be checked')
		warn.mockRestore()
		rmSync(dir, { recursive: true, force: true })
	})

	it('output cut at the cap is flagged too large', async () => {
		const { MAX_NGINX_PARSE_CHARS } = await import('../ssh/discovery')
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const dir = setup()
		const root = join(dir, 'etc-nginx')
		const big = `# configuration file ${root}/nginx.conf:\n${'#'.repeat(MAX_NGINX_PARSE_CHARS)}\n${LEGACY_DIRECT_VHOST}`
		materialize(big)
		fakeNginxT(dir, big)
		const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
		expect(routes.tooLarge).toBe(true)
		expect([...routes]).toEqual([])
		expect(warn.mock.calls.join(' ')).toContain('some routes not read')
		warn.mockRestore()
		rmSync(dir, { recursive: true, force: true })
		// a normal config is not flagged
		const dir2 = setup()
		const small = hostNginxDumpWithConfD(undefined, join(dir2, 'etc-nginx'))
		materialize(small)
		fakeNginxT(dir2, small)
		expect((await getNginxRoutes({ id: 's', host: 'h' } as never, [])).tooLarge).toBeUndefined()
		rmSync(dir2, { recursive: true, force: true })
	})

	it('no nginx on the host: no host routes, no skip note', async () => {
		const dir = setup('absent')
		mkdirSync(join(dir, 'sites-enabled'))
		writeFileSync(join(dir, 'sites-enabled', 'legacy'), LEGACY_DIRECT_VHOST)
		const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, [])
		expect([...routes]).toEqual([])
		expect(routes.hostSkipped).toBeUndefined()
		rmSync(dir, { recursive: true, force: true })
	})

	it('the host part stays read-only and bounded', async () => {
		const src = readFileSync(join(__dirname, '../ssh/discovery.ts'), 'utf8')
		expect(src).toContain('runCommand(server, cmd, 10_000)')
		const dir = setup()
		ran.cmds.length = 0
		await getNginxRoutes({ id: 's', host: 'h' } as never, [])
		const cmd = ran.cmds.join('\n')
		expect(cmd).toContain("NT='timeout 6'")
		expect(cmd).toContain('$NT nginx -T 2>/dev/null')
		// running = the pid file's process is nginx; pgrep would see container nginx too
		expect(cmd).not.toMatch(/pgrep|systemctl|nginx -s|>\s*\/etc|rm /)
		rmSync(dir, { recursive: true, force: true })
	})
})

describe('addDomain may replace an unproven row of another app', () => {
	it('pending + never verified/applied is replaceable; verified or live is not', () => {
		expect(isUnprovenClaim({ status: 'pending', verifiedAt: null, appliedAt: null })).toBe(true)
		expect(isUnprovenClaim({ status: 'verified', verifiedAt: new Date(), appliedAt: null })).toBe(false)
		expect(isUnprovenClaim({ status: 'live', verifiedAt: null, appliedAt: null })).toBe(false)
		expect(isUnprovenClaim({ status: 'pending', verifiedAt: new Date(), appliedAt: null })).toBe(false)
		// a failed TXT check proves nothing either
		expect(isUnprovenClaim({ status: 'verify_failed', verifiedAt: null, appliedAt: null })).toBe(true)
		expect(isUnprovenClaim({ status: 'verify_failed', verifiedAt: new Date(), appliedAt: null })).toBe(false)
		expect(isUnprovenClaim({ status: 'verify_failed', verifiedAt: null, appliedAt: new Date() })).toBe(false)
		expect(isUnprovenClaim({ status: 'apply_failed', verifiedAt: null, appliedAt: null })).toBe(false)
	})
})

describe('docker inspect format strings never rely on an escape', () => {
	// docker inspect does not expand \t or \n in --format (only the ps/images
	// formatters do): a separator must be a Go template string ({{"\t"}}) or a real
	// character. Scans every source file for inspect format strings.
	it('no `}}\\t{{` / `}}\\n{{` escape in a docker inspect format', async () => {
		const { readdirSync, readFileSync, statSync } = await import('node:fs')
		const root = join(__dirname, '..', '..')
		const walk = (d: string): string[] =>
			readdirSync(d).flatMap((n) => {
				const p = join(d, n)
				if (n === 'node_modules' || n === '__tests__') return []
				return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
			})
		const bad: string[] = []
		for (const f of walk(root)) {
			for (const [i, line] of readFileSync(f, 'utf8').split('\n').entries()) {
				if (!/docker inspect|inspect -f|inspect --format/.test(line)) continue
				if (/\}\}\\[tn]|\\[tn]\{\{/.test(line)) bad.push(`${f}:${i + 1}`)
			}
		}
		expect(bad).toEqual([])
	})
	it('the host net info command uses {{"\\t"}} separators', async () => {
		ran.cmds.length = 0
		ran.fakeBin = ''
		const { getContainerHostNetInfo } = await import('../ssh/discovery')
		await getContainerHostNetInfo({ id: 's', host: 'h' } as never, ['app'])
		const cmd = ran.cmds.find((c) => c.startsWith('docker inspect')) ?? ''
		expect(cmd).toContain(`{{.Name}}{{"\\t"}}{{.HostConfig.NetworkMode}}`)
		expect(cmd).not.toContain('\t')
	})
})

describe('a resumed deploy stream keeps a private key masked', () => {
	it('priming the redactor with the output before the offset masks the key body after it', async () => {
		const { SecretStreamRedactor } = await import('../secret-text')
		const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'
		const before = `step 1\n-----BEGIN PRIVATE KEY-----\n${body}\n`
		const after = `${body}\n${body}\n-----END PRIVATE KEY-----\nstep 2\n`
		const fresh = new SecretStreamRedactor().push(after)
		const r = new SecretStreamRedactor()
		r.push(before)
		const resumed = r.push(after)
		expect(resumed).not.toContain(body)
		expect(resumed).toContain('step 2')
		// (without priming the body lines are not recognised as a key)
		expect(fresh).toContain(body)
	})
	it('the stream route primes the redactor on resume', async () => {
		const { readFileSync } = await import('node:fs')
		const src = readFileSync(join(__dirname, '..', '..', 'app/api/deploys/[deployId]/stream/route.ts'), 'utf8')
		expect(src).toMatch(/if \(!primed\) await prime\(\)/)
	})
})

describe('the replace transaction deletes the same unproven statuses', () => {
	it('uses UNPROVEN_STATUSES, not a pending-only filter', () => {
		const src = readFileSync(join(__dirname, '../app-domains.ts'), 'utf8')
		expect(src).toContain('inArray(appDomains.status, [...UNPROVEN_STATUSES])')
		expect(src).not.toContain("eq(appDomains.status, 'pending'),\n\t\t\t\t\t\t\tisNull(appDomains.verifiedAt)")
	})
})

describe('nginx -T never runs in preview containers or in app space', () => {
	it('skips a managed preview name and any container whose compose working dir is under /opt/apps', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'disc-'))
		const log = join(dir, 'exec.log')
		writeFakeDocker(dir, [
				'#!/bin/bash',
				'case "$1" in',
				'  ps) printf "%s\\n" shop-feat-nginx appdir-proxy edge-nginx ;;',
				'  inspect) n="${@: -1}"; case "$*" in',
				'    *working_dir*) case "$n" in appdir-proxy) echo /opt/apps/somethingelse ;; edge-nginx) echo /srv/edge ;; *) echo "" ;; esac ;;',
				'    *) case "$n" in shop-feat-nginx) echo shopfeat ;; appdir-proxy) echo appdir ;; edge-nginx) echo edge ;; *) echo "" ;; esac ;;',
				'  esac ;;',
				`  exec) echo "$2" >> ${JSON.stringify(log)}; echo "server { server_name $2.example.com; proxy_pass http://127.0.0.1:3000; }" ;;`,
				'esac',
			].join('\n'))
		ran.fakeBin = dir
		// shop-feat-nginx is a preview container of app `shop` (managedContainerNames lists it).
		await getNginxRoutes({ id: 's', host: 'h' } as never, ['shop', 'shop-feat-nginx'])
		const execd = spawnSync('cat', [log]).stdout.toString().split('\n').filter(Boolean)
		expect(execd).toEqual(['edge-nginx'])
		rmSync(dir, { recursive: true, force: true })
	})
	it('managedContainerNames includes preview_deploys containers', () => {
		const src = readFileSync(join(__dirname, '../managed-containers.ts'), 'utf8')
		expect(src).toContain('previewDeploys.containerName')
		const list = readFileSync(join(__dirname, '../server-list.ts'), 'utf8')
		expect(list).toContain('managedContainerNames(server.id).then((names) => getNginxRoutes(server, names))')
	})
})
