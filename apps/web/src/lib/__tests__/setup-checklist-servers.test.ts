// The setup checklist's server row, end to end from check facts: checkItems ->
// isCheckGreen / missingPieces (what the check saves) -> buildChecklist. Invented
// server names; each case is a common mix of present and absent pieces.
import { describe, expect, it } from 'vitest'
import {
	type BootstrapFacts,
	type BootstrapProxy,
	DYNAMIC_DIR_MISSING,
	NETWORK_INTERNAL_ABSENT,
	NETWORK_WEB_ABSENT,
	NETWORK_WEB_MISSING,
	checkItems,
	isCheckGreen,
	missingPieces,
} from '../server-bootstrap'
import { type ChecklistInput, type ChecklistServer, buildChecklist } from '../setup-checklist'

const DYN = '/opt/infra/traefik/dynamic'

// A working server of each proxy kind; `over` removes pieces.
function facts(proxy: BootstrapProxy, over: Partial<BootstrapFacts> = {}): BootstrapFacts {
	const traefik = proxy === 'traefik'
	return {
		root: true,
		os: 'ubuntu',
		docker: 'present',
		dockerVersion: '29.0.0',
		compose: 'present',
		networks: { web: 'present', internal: 'present' },
		traefik: traefik ? 'running' : 'absent',
		traefikFileProvider: traefik ? 'ok' : 'n/a',
		appsDir: 'present',
		dynamicDir: traefik ? 'present' : 'absent',
		ufw: 'inactive',
		port80: 'busy',
		port443: 'busy',
		nginx: traefik ? 'absent' : 'present',
		nginxBinary: traefik ? 'absent' : 'present',
		nginxUnit: traefik ? 'absent' : 'enabled',
		portBindings: 'none',
		proxyContainers: traefik ? 'present' : 'absent',
		diskFreeBytes: 100 * 1024 ** 3,
		memTotalBytes: 8 * 1024 ** 3,
		memAvailBytes: 4 * 1024 ** 3,
		tools: { git: 'present', flock: 'present' },
		...over,
	}
}

const NO_NETS = { networks: { web: 'absent', internal: 'absent' } } as const

// What the checklist route builds from a saved check.
function server(
	name: string,
	proxy: BootstrapProxy,
	over: Partial<BootstrapFacts> = {},
): ChecklistServer {
	const items = checkItems(facts(proxy, over), DYN, proxy)
	return {
		id: name,
		name,
		status: 'connected',
		proxy,
		baseDomain: proxy === 'traefik' ? 'apps.example.com' : null,
		checkGreen: isCheckGreen(items),
		checkMissing: missingPieces(items),
		dnsState: proxy === 'traefik' ? 'ok' : null,
		needsDefaultHost: false,
	}
}

const base: Omit<ChecklistInput, 'servers'> = {
	githubOAuth: true,
	backups: true,
	deployFailureRoutes: ['ops-endpoint'],
	adminPersisted: true,
}

const row = (servers: ChecklistServer[]) => {
	const r = buildChecklist({ ...base, servers }).find((i) => i.id === 'server')
	if (!r) throw new Error('no server row')
	return r
}

describe('setup checklist: the server row names what is missing', () => {
	it('all green, including an nginx-container server without the internal network', () => {
		const items = checkItems(
			facts('nginx-container', { networks: { web: 'present', internal: 'absent' } }),
			DYN,
			'nginx-container',
		)
		expect(isCheckGreen(items)).toBe(true)
		expect(items.find((i) => i.id === 'network-internal')).toMatchObject({
			state: 'info',
			detail: NETWORK_INTERNAL_ABSENT,
		})
		const r = row([
			server('srv-1', 'nginx'),
			server('srv-2', 'nginx-container', { networks: { web: 'present', internal: 'absent' } }),
			server('srv-3', 'traefik'),
		])
		expect(r.state).toBe('done')
	})

	it('an nginx or nginx-container server without web or internal is fine: the new-app flow creates them', () => {
		for (const proxy of ['nginx', 'nginx-container'] as const) {
			const s = server('srv-1', proxy, NO_NETS)
			expect(s.checkGreen, proxy).toBe(true)
			expect(s.checkMissing, proxy).toEqual([])
			expect(row([s]).state, proxy).toBe('done')
		}
		const items = checkItems(facts('nginx', NO_NETS), DYN, 'nginx')
		expect(items.find((i) => i.id === 'network-web')).toMatchObject({ state: 'info', detail: NETWORK_WEB_ABSENT })
	})

	it('network web missing on a Traefik server: named, not "Docker or proxy"', () => {
		const s = server('srv-6', 'traefik', NO_NETS)
		expect(s.checkGreen).toBe(false)
		// the required routing network of a Traefik server (`web` here: nothing names another)
		expect(s.checkMissing?.map((m) => m.id)).toEqual(['traefik-network'])
		const r = row([s])
		expect(r).toMatchObject({
			state: 'missing',
			label: 'add the missing server pieces',
			href: '/servers/srv-6#server-check',
			action: 'fix srv-6',
		})
		expect(r.detail).toBe(`network web missing on srv-6: ${NETWORK_WEB_MISSING.replace(/^missing: /, '')}`)
		expect(r.detail).not.toContain('internal')
	})

	it('file provider folder missing on a Traefik server', () => {
		const r = row([server('srv-4', 'traefik', { dynamicDir: 'absent' })])
		expect(r).toMatchObject({
			state: 'missing',
			label: 'add the missing server pieces',
			action: 'fix srv-4',
		})
		expect(r.detail).toBe(
			`the Traefik file provider folder missing on srv-4: ${DYNAMIC_DIR_MISSING.replace(/^missing: /, '')}`,
		)
	})

	it('Docker truly missing: the Docker and proxy label', () => {
		const r = row([
			server('srv-5', 'nginx', { docker: 'absent', dockerVersion: null, compose: 'absent' }),
		])
		expect(r.label).toBe('install Docker and the proxy')
		expect(r.detail).toMatch(
			/^Docker missing on srv-5; the docker compose plugin missing on srv-5\. first: Docker on srv-5: /,
		)
	})

	it('a stopped Traefik on a Traefik server is the proxy missing', () => {
		expect(row([server('srv-6', 'traefik', { traefik: 'stopped' })]).label).toBe(
			'install Docker and the proxy',
		)
	})

	it('mixed: a short summary per piece, then the first one with its fix link', () => {
		const servers = [
			server('srv-1', 'nginx', NO_NETS),
			server('srv-2', 'nginx', NO_NETS),
			server('srv-3', 'nginx', NO_NETS),
			server('srv-4', 'nginx', NO_NETS),
			server('srv-5', 'nginx', NO_NETS),
			server('srv-6', 'traefik', NO_NETS),
			server('srv-7', 'nginx-container', { networks: { web: 'present', internal: 'absent' } }),
			server('srv-8', 'traefik', { dynamicDir: 'absent' }),
			server('srv-9', 'nginx'),
		]
		expect(servers.filter((s) => s.checkGreen === false).map((s) => s.name)).toEqual(['srv-6', 'srv-8'])
		const r = row(servers)
		expect(r).toMatchObject({
			state: 'missing',
			label: 'add the missing server pieces',
			href: '/servers/srv-6#server-check',
			action: 'fix srv-6',
		})
		expect(r.detail).toBe(
			'network web missing on srv-6; the Traefik file provider folder missing on srv-8. ' +
				`first: network web on srv-6: ${NETWORK_WEB_MISSING.replace(/^missing: /, '')}`,
		)
	})

	it('a failed server with no saved pieces still fails, without inventing a reason', () => {
		const r = row([{ ...server('srv-1', 'nginx'), checkGreen: false, checkMissing: [] }])
		expect(r.state).toBe('missing')
		expect(r.detail).toBe('the server check failed on srv-1')
		expect(r.label).toBe('add the missing server pieces')
	})
})
