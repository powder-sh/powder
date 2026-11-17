// every recreate outside a deploy (manual apply, domain apply, rollback,
// auto-rollback, snapshot rollback) runs the deploy's compose guard on the compose on
// disk, with "approved" = the compose_config_hash of the app's last successful deploy.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = { stdout: '', throws: false, approved: null as string | null, view: null as unknown, cmds: [] as string[] }
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		state.cmds.push(cmd)
		if (state.throws) throw new Error('SSH timeout')
		const sep = cmd.match(/__POWDER_CG_SEP_[0-9a-f]+__/)?.[0] ?? '__POWDER_CG_SEP__'
		return { stdout: state.stdout.split('__POWDER_CG_SEP__').join(sep), stderr: '', code: 0 }
	},
}))
// queries FROM preview_deploys answer pv.rows, queries FROM app_repos ar.rows.
const pv = { rows: [] as unknown[] }
const ar = { rows: [] as unknown[] }
vi.mock('../db', () => {
	const chain = (): Record<string, unknown> => {
		const c: Record<string, unknown> = {}
		const rows = () => (c.t === 'app' ? ar.rows : pv.rows)
		c.from = (t: { t?: string }) => {
			c.t = t?.t
			return c
		}
		for (const k of ['innerJoin', 'where']) c[k] = () => c
		c.limit = async () => rows()
		c.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(rows()).then(ok, bad)
		return c
	}
	return { and: () => null, eq: () => null, appRepos: { t: 'app' }, previewDeploys: { t: 'pv' }, db: { select: () => chain() } }
})
vi.mock('../deploy-runner', () => ({ otherAppsOnServer: async () => ['blogx'] }))
vi.mock('../deploys', () => ({ lastSuccessfulComposeHash: async () => state.approved, lastSuccessfulComposeView: async () => state.view }))
const routes = { hosts: [] as string[], calls: [] as unknown[][] }
vi.mock('../app-domains', () => ({
	routeHostsFor: async (...a: unknown[]) => {
		routes.calls.push(a)
		return routes.hosts
	},
}))
vi.mock('../app-hosts', () => ({ defaultHostFor: () => null }))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => false }))
vi.mock('../ssh/files', () => ({ envFileCandidatesFor: async () => ['/opt/apps/shopx.env'] }))

const { checkComposeForRecreate, owningAppFor } = await import('../recreate-guard')
const { structuralComposeHash, structuralComposeView } = await import('../deploy/compose-check')
const { composeUpCommand, recreatePinShell } = await import('../deploy/fragments')

const server = { id: 'boxa', host: 'h', user: 'root' } as never
const doc = (svc: Record<string, unknown>) => ({ name: 'shopx', services: { shopx: { image: 'shopx:latest', ...svc } } })
const probe = (d: unknown) => {
	const c = JSON.stringify(d)
	return ['a'.repeat(64), c, c, ''].join('\n__POWDER_CG_SEP__\n')
}
const WARN = { POWDER_COMPOSE_GUARD: 'warn' }
const p = { app: 'shopx', configFile: '/opt/apps/shopx/docker-compose.yml', workingDir: '/opt/apps/shopx', what: 'domain apply' }

beforeEach(() => {
	pv.rows = []
	ar.rows = []
	routes.hosts = []
	routes.calls = []
	state.stdout = ''
	state.throws = false
	state.approved = null
	state.view = null
	state.cmds = []
})

describe('checkComposeForRecreate: the deploy decision on the compose on disk', () => {
	it('warn, no approved hash: warn lines only (what a deploy does), the hash is pinned', async () => {
		state.stdout = probe(doc({ privileged: true }))
		const a = await checkComposeForRecreate(server, p, WARN)
		expect(a.hash).toBe('a'.repeat(64))
		expect(a.app).toBe('shopx')
		expect(a.log).toContain('[compose-guard] WARN shopx privileged')
		expect(a.log).toContain('no approved compose hash recorded yet')
	})

	it('warn, unchanged since the approved deploy: recreates as before (warn lines only)', async () => {
		const d = doc({ privileged: true })
		state.stdout = probe(d)
		state.approved = structuralComposeHash(d)
		const a = await checkComposeForRecreate(server, p, WARN)
		expect(a.log).toContain('WARN shopx privileged')
	})

	it('warn, the compose differs from the approved one: high findings refuse the recreate', async () => {
		state.stdout = probe(doc({ privileged: true, volumes: ['/:/host'] }))
		state.approved = structuralComposeHash(doc({}))
		await expect(checkComposeForRecreate(server, p, WARN)).rejects.toThrow(/domain apply refused[\s\S]*\[privileged\]/)
		await expect(checkComposeForRecreate(server, p, WARN)).rejects.not.toThrow(/__POWDER_FAIL__/)
	})

	it('warn, the compose differs but breaks no rule: recreates', async () => {
		state.stdout = probe(doc({ restart: 'unless-stopped' }))
		state.approved = structuralComposeHash(doc({}))
		const a = await checkComposeForRecreate(server, p, WARN)
		expect(a.log).toContain('passes the safety rules')
	})

	it('with a stored view, the refusal lists what changed since the approved deploy', async () => {
		state.stdout = probe(doc({ privileged: true, network_mode: 'host' }))
		state.approved = structuralComposeHash(doc({}))
		state.view = structuralComposeView(doc({}))
		const err = await checkComposeForRecreate(server, p, WARN).then(
			() => '',
			(e: Error) => e.message,
		)
		expect(err).toMatch(/domain apply refused[\s\S]*\[privileged\]/)
		expect(err).toContain('services.shopx.network_mode: (unset) -> host')
		expect(err).toContain('services.shopx.privileged: (unset) -> true')
		expect(err).toContain('A hand edit of the compose on the server (/opt/apps/shopx/docker-compose.yml)')
	})

	it('enforce: any finding refuses, as at deploy', async () => {
		state.stdout = probe(doc({ privileged: true }))
		state.approved = structuralComposeHash(doc({ privileged: true }))
		await expect(checkComposeForRecreate(server, { ...p, what: 'rollback' }, {})).rejects.toThrow(/rollback refused/)
	})

	it('an unreadable probe: enforce refuses, warn recreates unchecked and says so', async () => {
		state.stdout = 'garbage'
		await expect(checkComposeForRecreate(server, p, {})).rejects.toThrow(/refusing to deploy an unchecked compose/)
		const a = await checkComposeForRecreate(server, p, WARN)
		expect(a.hash).toBe('')
		expect(a.log).toContain('UNCHECKED')
	})

	it('a refused compose project name stays a hard refusal', async () => {
		state.stdout = probe({ name: 'other', services: { shopx: { image: 'shopx:latest' } } })
		await expect(checkComposeForRecreate(server, p, WARN)).rejects.toThrow(/project name/)
	})
})

// a preview container is checked with the preview deploy's own context
// (previewGuardContext): its URL host and live preview domains, the parent's .preview.env.
describe('checkComposeForRecreate on a preview', () => {
	const name = 'pv-myapp-feat'
	const wd = `/opt/apps/${name}`
	const pcfg = (envFiles: string[]) => ({
		name,
		services: {
			[name]: {
				image: `${name}:latest`,
				container_name: name,
				build: { context: wd, dockerfile: 'Dockerfile' },
				env_file: envFiles.map((path) => ({ path, required: true })),
				labels: {
					'traefik.enable': 'true',
					[`traefik.http.routers.${name}.rule`]: 'Host(`pv-myapp-feat.example.com`) || Host(`custom.example.org`)',
					[`traefik.http.routers.${name}.entrypoints`]: 'websecure',
					[`traefik.http.services.${name}.loadbalancer.server.port`]: '3000',
				},
				networks: { web: null, default: null },
			},
		},
		networks: { web: { external: true, name: 'web' }, default: { name: `${name}_default` } },
	})
	const pp = { app: name, configFile: `${wd}/docker-compose.yml`, workingDir: wd, what: 'domain apply' }
	const row = { id: 'pvd_1', url: 'https://pv-myapp-feat.example.com', containerName: name, appRepoId: 'rep_1', parentName: 'myapp' }
	it('preview domain apply passes in enforce mode', async () => {
		pv.rows = [row]
		routes.hosts = ['pv-myapp-feat.example.com', 'custom.example.org']
		state.stdout = probe(pcfg(['/opt/apps/myapp.preview.env']))
		const a = await checkComposeForRecreate(server, pp, {})
		expect(a.log).toContain('passes the safety rules')
		expect(routes.calls[0]).toEqual([server, 'rep_1', name, 'pvd_1'])
	})
	it('a preview compose with a hostile extra env_file is still refused', async () => {
		pv.rows = [row]
		routes.hosts = ['pv-myapp-feat.example.com', 'custom.example.org']
		state.stdout = probe(pcfg(['/opt/apps/myapp.preview.env', '/opt/apps/myapp.env']))
		await expect(checkComposeForRecreate(server, pp, {})).rejects.toThrow(/\[env_file\]/)
	})
	it('apply / rollback on a preview container resolve it as its own app (not unregistered)', async () => {
		pv.rows = [{ name }]
		expect(await owningAppFor('boxa', name, name)).toBe(name)
		pv.rows = []
		expect(await owningAppFor('boxa', 'stray', 'stray')).toBeNull()
	})
	it('a registered app is checked as that app even when a preview row has its name', async () => {
		ar.rows = [{ id: 'rep_9', name }]
		pv.rows = [row]
		state.stdout = probe(pcfg(['/opt/apps/myapp.preview.env']))
		await checkComposeForRecreate(server, pp, {}).catch(() => null)
		// the preview path asks for the preview's routes (pvd_1); the app path asks only for
		// the app's own (checked when the probe sees a Docker-provider proxy)
		expect(routes.calls.every((c) => c[1] === 'rep_9' && (c[3] ?? null) === null)).toBe(true)
	})
	it('an old-style preview named <parent>-worker never claims the parent sidecar', async () => {
		ar.rows = [{ name: 'shopx' }]
		pv.rows = [{ name: 'shopx-worker' }]
		expect(await owningAppFor('boxa', 'shopx-worker', 'shopx')).toBe('shopx')
		// the preview container itself (its own compose project) is still the preview
		expect(await owningAppFor('boxa', 'shopx-worker', 'shopx-worker')).toBe('shopx-worker')
		expect(await owningAppFor('boxa', 'shopx-worker', null)).toBe('shopx-worker')
		expect(await owningAppFor('boxa', 'shopx-db', 'shopx')).toBe('shopx')
		expect(await owningAppFor('boxa', 'stray', 'other')).toBeNull()
	})
	it('a domain the preview does not own is still refused', async () => {
		pv.rows = [row]
		routes.hosts = ['pv-myapp-feat.example.com']
		state.stdout = probe(pcfg(['/opt/apps/myapp.preview.env']))
		await expect(checkComposeForRecreate(server, pp, {})).rejects.toThrow(/traefik_host/)
	})
})

describe('composeUpCommand pins the approved hash before the up', () => {
	const cf = "-f '/opt/apps/shopx/docker-compose.yml'"
	it('refuses the up when the config moved after the check', () => {
		const c = composeUpCommand('/opt/apps/shopx/docker-compose.yml', 'shopx', '/opt/apps/shopx', {
			app: 'shopx',
			approval: { hash: 'b'.repeat(64), app: 'shopx', log: '' },
		})
		expect(c).toContain('b'.repeat(64))
		expect(c.indexOf('b'.repeat(64))).toBeLessThan(c.indexOf('up -d --no-build'))
		expect(c.indexOf('bind guard')).toBeLessThan(c.indexOf('b'.repeat(64)))
	})
	it('no pin for an unchecked approval', () => {
		expect(recreatePinShell(cf, { hash: '', app: null, log: '' })).toBe('')
	})
	it('the pin runs: same config passes, a changed one exits 1', () => {
		const root = mkdtempSync(join(tmpdir(), 'pin-'))
		try {
			mkdirSync(join(root, 'bin'))
			writeFileSync(join(root, 'bin', 'docker'), '#!/bin/bash\ncat "$CFG"\n')
			chmodSync(join(root, 'bin', 'docker'), 0o755)
			writeFileSync(join(root, 'cfg'), '{"services":{}}\n')
			const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, CFG: join(root, 'cfg') }
			const run = (h: string) =>
				spawnSync('bash', ['-c', `${recreatePinShell(cf, { hash: h, app: 'shopx', log: '' })}echo UP`], { encoding: 'utf8', env })
			// what the check saw: the same two config outputs, hashed the same way
			const seen = createHash('sha256').update('{"services":{}}\n---\n{"services":{}}\n').digest('hex')
			const ok = run(seen)
			expect(ok.stdout, ok.stderr).toContain('UP')
			const bad = run('c'.repeat(64))
			expect(bad.status).toBe(1)
			expect(bad.stdout).not.toContain('UP')
			expect(bad.stdout).toContain('refusing the recreate')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})

// One authority: no source file outside lib/recreate-guard.ts makes an approval, and
// every file that recreates through composeUpCommand / composeUpService / rollbackToImage
// gets its approval from checkComposeForRecreate (or receives one as a parameter).
describe('guard: every recreate path goes through checkComposeForRecreate', () => {
	const src = join(__dirname, '..', '..')
	const files: string[] = []
	const walk = (d: string) => {
		for (const f of readdirSync(d)) {
			const x = join(d, f)
			if (f === '__tests__' || f === 'node_modules') continue
			if (statSync(x).isDirectory()) walk(x)
			else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(x)
		}
	}
	walk(src)
	const PASS_THROUGH = new Set(['deploy/fragments.ts', 'deploy/health.ts', 'recreate-guard.ts'])
	it('callers check first', () => {
		const bad: string[] = []
		for (const f of files) {
			const t = readFileSync(f, 'utf8')
			const rel = f.slice(src.length + 1).replace(/^lib\//, '')
			if (/\bhash: ''/.test(t) && /\bapp: null\b/.test(t) && rel !== 'recreate-guard.ts' && rel !== 'deploy/fragments.ts')
				bad.push(`${rel}: builds an approval literal`)
			if (!/composeUpCommand\(|composeUpService\(|rollbackToImage\(/.test(t)) continue
			if (PASS_THROUGH.has(rel)) continue
			if (!/checkComposeForRecreate|unregisteredApproval/.test(t)) bad.push(`${rel}: recreates without checkComposeForRecreate`)
		}
		expect(bad).toEqual([])
	})
	it('no raw compose up outside the deploy script, self-deploy and composeUpCommand', () => {
		const bad = files.filter((f) => {
			const rel = f.slice(src.length + 1)
			if (/lib\/deploy\/(script|fragments|self-deploy)\.ts$/.test(rel)) return false
			return /docker compose \$\{[^}]+\} up -d/.test(readFileSync(f, 'utf8'))
		})
		expect(bad).toEqual([])
	})
})

