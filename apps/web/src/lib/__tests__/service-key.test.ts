// a service KEY is a DNS alias on every network the service joins.
// On a shared network it must not be a powder name or a name another project's
// container answers there. High severity: enforced when the repo changed the
// compose, a WARN line otherwise.
import { describe, expect, it } from 'vitest'
import { type ComposeGuardContext, composeViolations, isHighSeverity } from '../compose-safety'
import { deployGuardContext, parseComposeProbe } from '../deploy/compose-check'

const ctx: ComposeGuardContext = {
	appName: 'myapp',
	projectDir: '/opt/apps/myapp',
	foreignContainers: ['victim', 'victim-db'],
}
const doc = (
	services: Record<string, unknown>,
	networks: Record<string, unknown> = { internal: { external: true } },
) => ({
	name: 'myapp',
	services,
	networks,
})
const codes = (d: unknown, c = ctx) =>
	composeViolations(d, c).filter((v) => v.code === 'service_key')

describe('service keys on shared networks', () => {
	it('a key named like a powder container on a shared network is refused', () => {
		const v = codes(doc({ postgres: { image: 'postgres:16', networks: { internal: {} } } }))
		expect(v).toHaveLength(1)
		expect(v.every(isHighSeverity)).toBe(true)
		expect(codes(doc({ traefik: { image: 'x', networks: ['internal'] } }))).toHaveLength(1)
	})
	it("a key named like another app's container on a shared network is refused", () => {
		expect(codes(doc({ 'victim-db': { image: 'x', networks: ['internal'] } }))).toHaveLength(1)
	})
	it('the implicit default network counts when it is renamed to a shared one', () => {
		expect(
			codes(doc({ postgres: { image: 'x' } }, { default: { name: 'web', external: true } })),
		).toHaveLength(1)
	})
	it('own networks, network_mode and an unreserved key pass', () => {
		expect(codes(doc({ postgres: { image: 'x' } }, {}))).toEqual([])
		expect(codes(doc({ postgres: { image: 'x', networks: ['default'] } }, {}))).toEqual([])
		expect(
			codes(
				doc({
					myapp: { image: 'x', networks: ['internal'] },
					db: { image: 'p', networks: ['default'] },
				}),
			),
		).toEqual([])
		expect(codes(doc({ postgres: { image: 'x', network_mode: 'none' } }))).toEqual([])
	})
	it('deploy-time: foreign compose service names count only on the network they are on', () => {
		const ps = [
			'other-db\tpostgres:16\tother\trunning\tdb\tother_default,internal',
			'third\tthird:latest\tthird\trunning\tapp\tthird_default',
			'gone\tgone:latest\tgone\texited\tcache\tinternal',
		].join('\n')
		const input = parseComposeProbe(
			['a'.repeat(64), JSON.stringify(doc({})), JSON.stringify(doc({})), ps].join(
				'\n__POWDER_CG_SEP__\n',
			),
		)
		if (!input) throw new Error('probe did not parse')
		const c = deployGuardContext(input, {
			appName: 'myapp',
			workingDir: '/opt/apps/myapp',
			composeFiles: ['/opt/apps/myapp/docker-compose.yml'],
			serverId: 's',
			routeHosts: null,
		})
		expect(codes(doc({ db: { image: 'p', networks: ['internal'] } }), c)).toHaveLength(1)
		expect(codes(doc({ app: { image: 'p', networks: ['internal'] } }), c)).toEqual([])
		expect(codes(doc({ cache: { image: 'p', networks: ['internal'] } }), c)).toEqual([])
		expect(codes(doc({ db: { image: 'p', networks: ['default'] } }), c)).toEqual([])
	})
})
