// the rules that read files outside the app, or take over another
// app's name, volume, container or route, are high severity: warn mode refuses them
// when the compose config changed. Known real-world shapes keep deploying with an
// operator exemption naming the code.
import { describe, expect, it, vi } from 'vitest'

const state = { stdout: '' }
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => ({ stdout: state.stdout.split('__POWDER_CG_SEP__').join(cmd.match(/__POWDER_CG_SEP_[0-9a-f]+__/)?.[0] ?? '__POWDER_CG_SEP__'), stderr: '', code: 0 }),
}))
import { isHighSeverity } from '../compose-safety'
import { checkComposeForDeploy } from '../deploy/compose-check'

const server = { id: 's1', name: 's1', host: 'h', user: 'root', port: 22, kind: 'compose' as const }
const p = {
	appName: 'myapp',
	workingDir: '/opt/apps/myapp',
	composeFiles: ['/opt/apps/myapp/docker-compose.yml'],
	routeHosts: null as string[] | null,
	// a stored baseline the probed config does not match: the compose changed
	approvedHash: 'b'.repeat(64),
}
const doc = (svc: Record<string, unknown>, top: Record<string, unknown> = {}) =>
	JSON.stringify({
		name: 'myapp',
		...top,
		services: { myapp: { image: 'myapp:latest', container_name: 'myapp', ...svc } },
	})
const probe = (svc: Record<string, unknown>, top: Record<string, unknown> = {}, ps = '') =>
	['c'.repeat(64), doc(svc, top), doc(svc, top), ps].join('\n__POWDER_CG_SEP__\n')
const WARN = { POWDER_COMPOSE_GUARD: 'warn' }

describe('high-severity codes', () => {
	it('lists the medium codes', () => {
		for (const code of [
			'secret',
			'config',
			'env_file',
			'build',
			'network_alias',
			'volume_name',
			'volumes_from',
			'traefik_host',
			'traefik_internal',
			'container_name',
		])
			expect(isHighSeverity({ code, message: '' }), code).toBe(true)
	})
	const cases: Array<[string, Record<string, unknown>, Record<string, unknown>?, string?]> = [
		['env_file', { env_file: ['/opt/apps/other.env'] }],
		['secret', {}, { secrets: { s: { file: '/etc/shadow' } } }],
		['build', { build: { context: '/opt/apps/other/src' } }],
		['container_name', { container_name: 'powder' }],
		[
			'volumes_from',
			{ volumes_from: ['victim'] },
			undefined,
			'victim\tvictim:latest\tvictim\trunning',
		],
	]
	for (const [code, svc, top, ps] of cases) {
		it(`warn mode refuses ${code} in a changed config, and an exemption lets it through`, async () => {
			state.stdout = probe(svc, top, ps)
			await expect(checkComposeForDeploy(server, '', p, WARN)).rejects.toThrow(
				new RegExp(`\\[${code}\\]`),
			)
			process.env.POWDER_COMPOSE_GUARD_EXEMPT = JSON.stringify({ myapp: [code] })
			try {
				state.stdout = probe(svc, top, ps)
				const r = await checkComposeForDeploy(server, '', p, WARN)
				expect(r.log).not.toContain(`[${code}]`)
			} finally {
				Reflect.deleteProperty(process.env, 'POWDER_COMPOSE_GUARD_EXEMPT')
			}
		})
	}
	it('a Traefik rule for a host outside the app is refused; exempting traefik_host allows it', async () => {
		const labels = { 'traefik.http.routers.myapp.rule': 'Host(`www.other.example`)' }
		state.stdout = probe({ labels })
		const q = { ...p, routeHosts: ['myapp.example'] }
		await expect(checkComposeForDeploy(server, '', q, WARN)).rejects.toThrow(/traefik_host/)
		process.env.POWDER_COMPOSE_GUARD_EXEMPT = '{"s1/myapp":["traefik_host"]}'
		try {
			state.stdout = probe({ labels })
			await expect(checkComposeForDeploy(server, '', q, WARN)).resolves.toBeTruthy()
		} finally {
			Reflect.deleteProperty(process.env, 'POWDER_COMPOSE_GUARD_EXEMPT')
		}
	})
})
