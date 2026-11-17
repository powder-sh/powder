// powder's DB is reachable only by powder + powder-worker
// (the default layout; a shared-network-layout server keeps docker-compose.shared-db.yml),
// and new apps do not join the shared `internal` network by default.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { renderComposeYaml } from '../compose-render'

const compose = parse(readFileSync(resolve(__dirname, '../../../../../docker-compose.yml'), 'utf8'))
const nets = (svc: string) => {
	const n = compose.services[svc].networks
	return Array.isArray(n) ? n : Object.keys(n)
}

const legacy = parse(
	readFileSync(resolve(__dirname, '../../../../../docker-compose.shared-db.yml'), 'utf8'),
	{
		customTags: [
			{ tag: '!override', resolve: (v: unknown) => v, collection: 'map' } as never,
			{ tag: '!override', resolve: (v: unknown) => v, collection: 'seq' } as never,
		],
	},
)
const keys = (n: unknown) => (Array.isArray(n) ? n : Object.keys(n as object))

describe("powder's own compose", () => {
	it('the default layout puts the DB alone with powder + worker on the internal-only powder-db network', () => {
		expect(compose.services.postgres.container_name).toBe('powder-postgres')
		expect(nets('postgres')).toEqual(['powder-db'])
		// `postgres` stays resolvable there, so an old DATABASE_URL keeps working
		expect(compose.services.postgres.networks['powder-db'].aliases).toEqual(['powder-postgres', 'postgres'])
		expect(nets('powder')).toEqual(['web', 'powder-db'])
		expect(nets('worker')).toEqual(['web', 'powder-db'])
		expect(compose.networks['powder-db']).toEqual({ name: 'powder-db', internal: true })
		expect(compose.networks.internal).toBeUndefined()
		for (const svc of ['postgres', 'powder', 'worker']) expect(nets(svc)).not.toContain('internal')
	})
	it('the shared-db override gives the shared-network layout (postgres on internal)', () => {
		expect(legacy.services.postgres.container_name).toBe('postgres')
		expect(keys(legacy.services.postgres.networks)).toEqual(['internal'])
		expect(keys(legacy.services.powder.networks)).toEqual(['web', 'internal'])
		expect(keys(legacy.services.worker.networks)).toEqual(['web', 'internal'])
		expect(legacy.networks.internal).toEqual({ external: true })
	})
	it('the env example defaults DATABASE_URL to powder-postgres', () => {
		const env = readFileSync(resolve(__dirname, '../../../../../docker/powder.env.example'), 'utf8')
		expect(env).toMatch(/^DATABASE_URL=postgres:\/\/[^@]+@powder-postgres:5432\//m)
	})
})

describe('renderComposeYaml networks', () => {
	const base = {
		name: 'myapp',
		dockerfilePath: './Dockerfile',
		hostPort: null,
		containerPort: 3000,
		envFilePath: '/opt/apps/myapp.env',
		publicHost: 'myapp.apps.example.com',
		postgres: { password: 'pw', dataDir: '/opt/apps/myapp/pgdata' },
		kv: null,
	}
	it('joins web + its own db network only', () => {
		const doc = parse(renderComposeYaml(base))
		expect(doc.services.myapp.networks).toEqual(['web', 'myapp-db'])
		expect(doc.networks.internal).toBeUndefined()
	})
	it('internal is an explicit opt-in', () => {
		const doc = parse(renderComposeYaml({ ...base, sharedInternal: true }))
		expect(doc.services.myapp.networks).toContain('internal')
		expect(doc.networks.internal).toEqual({ external: true })
	})
})

describe('hardening is the default (opt-out docker-compose.unharden.yml)', () => {
	it('the default compose is pinned (comments only may change)', () => {
		// sha256 of JSON.stringify(parse(docker-compose.yml)). Any change to what the
		// default compose resolves to must be deliberate: update this pin with it.
		const text = readFileSync(resolve(__dirname, '../../../../../docker-compose.yml'), 'utf8')
		const hash = createHash('sha256')
			.update(JSON.stringify(parse(text)))
			.digest('hex')
		expect(hash).toBe('98fdd23a3c84e6c4572a6d14fa1f3a7e18bf6fb578b15b152788eb62bb2c80e4')
	})
	it('powder and worker drop every capability and forbid privilege gain by default; read_only stays opt-in', () => {
		for (const svc of ['powder', 'worker']) {
			expect(compose.services[svc].cap_drop, svc).toEqual(['ALL'])
			expect(compose.services[svc].security_opt, svc).toEqual(['no-new-privileges:true'])
			expect(compose.services[svc].read_only, svc).toBeUndefined()
		}
		const ro = parse(
			readFileSync(resolve(__dirname, '../../../../../docker-compose.web-readonly.yml'), 'utf8'),
		)
		expect(ro.services.powder.read_only).toBe(true)
		expect(ro.services.powder.tmpfs).toEqual(['/tmp', '/app/apps/web/.next/cache'])
		expect(ro.services.worker).toBeUndefined()
	})
	it('the opt-out override resets both settings on both services', () => {
		const text = readFileSync(resolve(__dirname, '../../../../../docker-compose.unharden.yml'), 'utf8')
		for (const svc of ['powder', 'worker']) {
			const block = text.split(`  ${svc}:\n`)[1]?.split('\n\n')[0] ?? ''
			expect(block, svc).toContain('cap_drop: !reset []')
			expect(block, svc).toContain('security_opt: !reset []')
		}
	})
})

describe('/new: sharedInternal is an explicit opt-in', () => {
	it('the API reads it from the body (default off) and passes it to both compose renders', () => {
		const route = readFileSync(resolve(__dirname, '../../app/api/apps/route.ts'), 'utf8')
		expect(route).toContain('const sharedInternal = body.sharedInternal === true')
		expect(route.match(/^\s+sharedInternal,$/gm)?.length).toBe(2)
		const page = readFileSync(resolve(__dirname, '../../app/(dashboard)/new/page.tsx'), 'utf8')
		expect(page).toContain('useState(false)\n\tconst [sharedInternal')
	})
})
