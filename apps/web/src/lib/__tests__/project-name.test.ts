// the compose `name:` never decides ownership; a project name other than the app
// name is refused in every guard mode, and a project change during the git sync resets
// the checkout like a guard refusal.
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

const state: { stdout: string } = { stdout: '' }
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => ({ stdout: state.stdout.split('__POWDER_CG_SEP__').join(cmd.match(/__POWDER_CG_SEP_[0-9a-f]+__/)?.[0] ?? '__POWDER_CG_SEP__'), stderr: '', code: 0 }),
}))
import { composeViolations } from '../compose-safety'
import {
	ComposeGuardError,
	checkComposeForDeploy,
	deployGuardContext,
} from '../deploy/compose-check'
import { composeProjectStableShell, projectChangedMarkerFor } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'

const server = { id: 's1', name: 's1', host: 'h', user: 'root', port: 22, kind: 'compose' as const }
const p = {
	appName: 'shop',
	workingDir: '/opt/apps/shop',
	composeFiles: ['/opt/apps/shop/docker-compose.yml'],
	routeHosts: null,
	approvedHash: null,
}
const probe = (name: string) => {
	const cfg = JSON.stringify({
		name,
		services: { shop: { image: 'shop:latest', container_name: 'shop' } },
	})
	return ['a'.repeat(64), cfg, cfg, 'api\tapi:1\tapi\trunning\tapi\tweb'].join(
		'\n__POWDER_CG_SEP__\n',
	)
}

describe('compose project name', () => {
	it('is refused in warn mode too when it is not the app name', async () => {
		state.stdout = probe('api')
		await expect(
			checkComposeForDeploy(server, '', p, { POWDER_COMPOSE_GUARD: 'warn' }),
		).rejects.toBeInstanceOf(ComposeGuardError)
		await expect(
			checkComposeForDeploy(server, '', p, { POWDER_COMPOSE_GUARD: 'warn' }),
		).rejects.toThrow(/not "shop" \(the app name "shop"/)
	})
	it('passes when it is the app name (the common shape)', async () => {
		state.stdout = probe('shop')
		const r = await checkComposeForDeploy(server, '', p, { POWDER_COMPOSE_GUARD: 'warn' })
		expect(r.log).toContain('passes the safety rules')
	})
	it('grants no ownership: another app named in name: owns nothing here', () => {
		const v = composeViolations(
			{
				name: 'api',
				services: {
					shop: {
						image: 'shop:latest',
						env_file: ['/opt/apps/api.env'],
						labels: ['traefik.http.routers.api.rule=Host(`shop.example.com`)'],
					},
				},
				volumes: { d: { name: 'api_data' } },
				networks: { n: { name: 'api-net' } },
			},
			{ appName: 'shop', resolved: true },
		).map((x) => x.code)
		expect(v).toEqual(
			expect.arrayContaining([
				'project_name',
				'env_file',
				'traefik_name',
				'volume_name',
				'network',
			]),
		)
	})
	it('the deploy context derives own / foreign containers from the app name', () => {
		const input = {
			resolved: { name: 'api', services: {} },
			raw: null,
			hash: 'a'.repeat(64),
			containers: [
				{ name: 'api', image: 'api:1', project: 'api', state: 'running' },
				{ name: 'shop', image: 'shop:1', project: 'shop', state: 'running' },
			],
		}
		const ctx = deployGuardContext(input, { ...p, serverId: 's1' })
		expect(ctx.ownProjectContainers).toEqual(['shop'])
		expect(ctx.foreignContainers).toEqual(['api'])
	})
})

describe('a project change during the git sync resets the checkout', () => {
	it('composeProjectStableShell prints the nonce marker on a refusal', () => {
		const m = projectChangedMarkerFor('abc123')
		const r = spawnSync(
			'bash',
			[
				'-c',
				`docker() { printf 'name: other\\n'; }; CP_PROJ=shop; ${composeProjectStableShell('-f c.yml', m)}`,
			],
			{ encoding: 'utf8' },
		)
		expect(r.status).not.toBe(0)
		expect(r.stdout.split('\n')).toContain(m)
	})
	it('the deploy script passes the marker', () => {
		const s = buildDeployScript({
			workingDir: '/opt/apps/shop',
			configFile: '/opt/apps/shop/docker-compose.yml',
			service: 'shop',
			cf: "-f '/opt/apps/shop/docker-compose.yml'",
			declaredMode: 'build',
			prebuilt: false,
			infra: null,
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
			shaNonce: 'n0nce',
		})
		expect(s).toContain(projectChangedMarkerFor('n0nce'))
	})
})

describe('the longest registered app name owns a prefix', () => {
	const v = (doc: Record<string, unknown>, otherApps: string[]) =>
		composeViolations(
			{ name: 'shop', services: { shop: { image: 'shop:latest', ...doc } } },
			{ appName: 'shop', resolved: true, otherApps },
		).map((x) => x.code)
	it("a Traefik name of another app shop-api is not shop's", () => {
		const labels = ['traefik.http.routers.shop-api.rule=Host(`shop.example.com`)']
		expect(v({ labels }, ['shop-api'])).toContain('traefik_name')
		expect(v({ labels }, ['web'])).not.toContain('traefik_name')
		expect(
			v({ labels: ['traefik.http.routers.shop-apix.rule=Host(`shop.example.com`)'] }, ['shop-api']),
		).not.toContain('traefik_name')
	})
	it("volumes and networks named after shop-api are not shop's", () => {
		const top = (name: string, otherApps: string[]) =>
			composeViolations(
				{
					name: 'shop',
					services: { shop: { image: 'shop:latest' } },
					volumes: { d: { name } },
					networks: { n: { name: `${name}-net` } },
				},
				{ appName: 'shop', resolved: true, otherApps },
			).map((x) => x.code)
		expect(top('shop-api_data', ['shop-api'])).toEqual(['network', 'volume_name'])
		expect(top('shop_data', ['shop-api'])).toEqual([])
		expect(top('shop-api_data', [])).toEqual([])
	})
})

describe('one authority for the app name in recreates', () => {
	it('composeUpCommand checks the project name only when the caller names the app', async () => {
		const { composeUpCommand } = await import('../deploy/fragments')
		expect(
			composeUpCommand('/opt/apps/shop/src/docker-compose.yml', 'web', '/opt/apps/shop/src', { approval: { hash: '', app: null, log: '' } }),
		).not.toContain('BG_WANT')
		expect(
			composeUpCommand('/opt/apps/shop/src/docker-compose.yml', 'web', '/opt/apps/shop/src', { approval: { hash: '', app: null, log: '' },
				app: 'shop',
			}),
		).toContain('BG_WANT=')
	})
	it('rollbacks, snapshot rollbacks and the apply route pass the app_repos container name', async () => {
		const { readFileSync } = await import('node:fs')
		const { join } = await import('node:path')
		const src = join(__dirname, '..', '..')
		expect(readFileSync(join(src, 'lib', 'deploys.ts'), 'utf8')).toContain(
			'app: opts.containerName',
		)
		expect(readFileSync(join(src, 'lib', 'deploy-snapshots.ts'), 'utf8')).toContain('app: liveName')
		expect(readFileSync(join(src, 'lib', 'deploy', 'health.ts'), 'utf8')).toMatch(
			/opts\.app !== undefined \? \{ app: opts\.app \}/,
		)
		const routes = join(src, 'app', 'api', 'servers', '[id]', 'containers', '[name]')
		// the owning app (its own app_repos row, or the app whose compose project a
		// sidecar is in) via owningAppFor
		for (const r of ['rollback', 'apply']) {
			const t = readFileSync(join(routes, r, 'route.ts'), 'utf8')
			expect(t).toContain('owningAppFor(id, name, detail.compose.project)')
			expect(t).toContain('app: owner')
		}
	})
})
