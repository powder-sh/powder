// network aliases are checked per network against every name another compose
// project's running containers answer there (container names, service names, aliases).
import { describe, expect, it } from 'vitest'
import { composeViolations } from '../compose-safety'
import {
	ALIAS_PROBE_FORMAT,
	deployGuardContext,
	parseAliasProbe,
	parseComposeProbe,
} from '../deploy/compose-check'

const doc = (networks: Record<string, unknown>, top: Record<string, unknown> = {}) => ({
	name: 'shop',
	networks: {
		infra: { name: 'infra', external: true },
		own: { name: 'shop_own' },
		web: { name: 'web', external: true },
		...top,
	},
	services: { db: { image: 'postgres:16', networks } },
})

describe('alias probe parsing', () => {
	it('parses name, project and per-network aliases', () => {
		expect(
			parseAliasProbe(
				'"/api-db"\t"api"\t{"infra":{"Aliases":["api-db","db"]},"web":{"Aliases":null}}\n"/shop"\t"shop"\t{"shop_own":{"Aliases":["shop","web"]}}\n',
			),
		).toEqual([
			{ name: 'api-db', project: 'api', networks: { infra: ['api-db', 'db'], web: [] } },
			{ name: 'shop', project: 'shop', networks: { shop_own: ['shop', 'web'] } },
		])
		expect(ALIAS_PROBE_FORMAT).toContain('.NetworkSettings.Networks')
	})
	it('a 6-part probe carries the aliases into foreignNamesByNetwork, own project excluded', () => {
		const cfg = JSON.stringify(doc({}))
		const ps =
			'api-db\tpostgres:16\tapi\trunning\tdb\tinfra\nshop-db\tpostgres:16\tshop\trunning\tdb\tinfra'
		const aliases =
			'"/api-db"\t"api"\t{"infra":{"Aliases":["api-db","db","pg"]}}\n"/shop-db"\t"shop"\t{"infra":{"Aliases":["shop-db","db","shopdb"]}}'
		const input = parseComposeProbe(
			['a'.repeat(64), cfg, cfg, ps, cfg, aliases].join('\n__POWDER_CG_SEP__\n'),
		)
		expect(input?.aliases).toHaveLength(2)
		if (!input) throw new Error('the probe did not parse')
		const ctx = deployGuardContext(input, {
			appName: 'shop',
			workingDir: '/opt/apps/shop',
			composeFiles: ['/opt/apps/shop/docker-compose.yml'],
			serverId: null,
			routeHosts: null,
		})
		expect(ctx.foreignNamesByNetwork?.infra).toEqual(expect.arrayContaining(['pg', 'api-db', 'db']))
		expect(ctx.foreignNamesByNetwork?.infra).not.toContain('shopdb')
	})
	it('older 5-part probes still parse', () => {
		const cfg = JSON.stringify(doc({}))
		expect(
			parseComposeProbe(['a'.repeat(64), cfg, cfg, '', cfg].join('\n__POWDER_CG_SEP__\n'))?.aliases,
		).toBeUndefined()
	})
})

describe('alias rule', () => {
	const codes = (
		networks: Record<string, unknown>,
		foreignNamesByNetwork?: Record<string, string[]>,
	) =>
		composeViolations(doc(networks), {
			appName: 'shop',
			resolved: true,
			foreignNamesByNetwork,
		}).map((v) => v.code)
	it("an alias postgres on the app's own network passes", () => {
		expect(codes({ own: { aliases: ['postgres'] } }, { infra: ['powder'] })).toEqual([])
		expect(codes({ own: { aliases: ['postgres'] } })).toEqual([])
	})
	it('an alias on infra that no other project answers passes', () => {
		expect(codes({ infra: { aliases: ['shop-db'] } }, { infra: ['api', 'api-db'] })).toEqual([])
	})
	it('refuses an alias another project answers on that network (alias, service or container)', () => {
		expect(codes({ infra: { aliases: ['pg'] } }, { infra: ['pg'] })).toEqual(['network_alias'])
		expect(codes({ own: { aliases: ['pg'] } }, { shop_own: ['pg'] })).toEqual(['network_alias'])
		expect(codes({ infra: { aliases: ['pg'] } }, { web: ['pg'] })).toEqual([])
	})
	it('refuses a powder name on a shared network', () => {
		expect(codes({ web: { aliases: ['powder-postgres'] } }, {})).toEqual(['network_alias'])
	})
})
