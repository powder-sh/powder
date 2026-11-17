// One rule for powder's DB layout: bin/lib-db-layout.sh (sourced by bin/install.sh
// and bin/self-deploy.sh) and DB_LAYOUT_SH in lib/deploy/self-deploy.ts (the
// dashboard self-deploy) are the same text, and that text classifies every
// container/data-dir state of both layouts the same way.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DB_LAYOUT_SH, selfDbLayoutShell } from '../deploy/self-deploy'
import { pathWithout } from './hermetic'

const BIN = resolve(__dirname, '../../../../../bin')

// docker stub: STUB_PP (a powder-postgres container exists), STUB_PG_MOUNT (mounts of
// a `postgres` container), STUB_POWDER_NETS (networks of the `powder` container).
const DOCKER = `#!/bin/sh
case "$*" in
  "container inspect -f ok powder-postgres") [ -n "$STUB_PP" ] && { echo ok; exit 0; }; exit 1;;
  "container inspect -f {{range .Mounts}}{{.Source}} {{end}} postgres") [ -n "$STUB_PG_MOUNT" ] && { echo "$STUB_PG_MOUNT "; exit 0; }; exit 1;;
  "container inspect -f {{json .NetworkSettings.Networks}} powder") [ -n "$STUB_POWDER_NETS" ] && { echo "$STUB_POWDER_NETS"; exit 0; }; exit 1;;
esac
exit 1
`

type Ct = { pp?: boolean; pgMount?: string; powderNets?: string }

// system tools without docker; the stub dir ahead of it supplies docker
const SYS_NO_DOCKER = pathWithout(['docker'])

function probe(opts: { ct: Ct; dataDir: boolean; dbUrl?: string; envLines?: string; shell?: string }): string {
	const root = mkdtempSync(join(tmpdir(), 'dblayout-'))
	const stubs = join(root, 'stubs')
	mkdirSync(stubs)
	writeFileSync(join(stubs, 'docker'), DOCKER)
	chmodSync(join(stubs, 'docker'), 0o755)
	const data = join(root, 'apps')
	mkdirSync(data)
	if (opts.dataDir) mkdirSync(join(data, 'powder-pgdata'))
	const envf = join(root, 'powder.env')
	if (opts.dbUrl !== undefined) writeFileSync(envf, `POWDER_DB_USER=admin\nDATABASE_URL=${opts.dbUrl}\n${opts.envLines ?? ''}`)
	const r = spawnSync(opts.shell ?? 'sh', ['-c', selfDbLayoutShell(data, envf)], {
		env: {
			...process.env,
			PATH: `${stubs}:${SYS_NO_DOCKER}`,
			STUB_PP: opts.ct.pp ? '1' : '',
			STUB_PG_MOUNT: opts.ct.pgMount ?? '',
			STUB_POWDER_NETS: opts.ct.powderNets ?? '',
		},
		encoding: 'utf8',
	})
	return r.stdout.trim()
}

const PRIVATE_URL = 'postgres://admin:pw@powder-postgres:5432/powder'
const SHARED_URL = 'postgres://admin:pw@postgres:5432/powder'

describe('DB layout rule', () => {
	it('bin/lib-db-layout.sh holds exactly DB_LAYOUT_SH', () => {
		const lib = readFileSync(join(BIN, 'lib-db-layout.sh'), 'utf8')
		expect(lib).toContain(`\nPOWDER_DB_LAYOUT_SH='${DB_LAYOUT_SH}'\n`)
		expect(DB_LAYOUT_SH).not.toContain("'")
	})

	it('install.sh and self-deploy.sh use the shared rule and carry no copy of their own', () => {
		for (const f of ['install.sh', 'self-deploy.sh']) {
			const src = readFileSync(join(BIN, f), 'utf8')
			expect(src).toContain('. bin/lib-db-layout.sh')
			expect(src).toContain('$POWDER_DB_LAYOUT_SH')
			expect(src).not.toMatch(/grep -q '?powder-pgdata/)
			expect(src).not.toMatch(/-d ["']\$DATA_DIR\/powder-pgdata/)
		}
	})

	// Four states of each layout: the DB container running, the DB container
	// stopped (it still exists), all containers removed (`docker compose down`, the
	// data dir stays) and no container and no data dir under POWDER_DATA_DIR.
	const states: { name: string; ct: { private: Ct; shared: Ct }; dataDir: boolean }[] = [
		{
			name: 'DB container running',
			ct: {
				private: { pp: true, powderNets: '{"powder-db":{},"web":{}}' },
				shared: { pgMount: '/opt/apps/powder-pgdata', powderNets: '{"internal":{},"web":{}}' },
			},
			dataDir: true,
		},
		{
			name: 'DB container stopped',
			ct: { private: { pp: true }, shared: { pgMount: '/opt/apps/powder-pgdata' } },
			dataDir: true,
		},
		{ name: 'containers removed, data dir kept', ct: { private: {}, shared: {} }, dataDir: true },
		{ name: 'no container, no data dir', ct: { private: {}, shared: {} }, dataDir: false },
	]

	for (const shell of ['sh', 'bash']) {
		describe(`under ${shell}`, () => {
			for (const s of states) {
				it(`private layout, ${s.name}`, () => {
					const got = probe({ ct: s.ct.private, dataDir: s.dataDir, dbUrl: PRIVATE_URL, shell })
					expect(got).toBe(s.dataDir || s.ct.private.pp ? 'private' : 'fresh')
				})
				it(`shared-network layout, ${s.name}`, () => {
					expect(probe({ ct: s.ct.shared, dataDir: s.dataDir, dbUrl: SHARED_URL, shell })).toBe('legacy')
					for (const envLines of ['POWDER_DB_NETWORK=shared\n', 'POWDER_DB_NETWORK=\n'])
						expect(probe({ ct: s.ct.shared, dataDir: s.dataDir, dbUrl: SHARED_URL, envLines, shell })).toBe('legacy')
				})
			}
		})
	}

	it('a shared-network DB that keeps its data elsewhere is found through the powder container', () => {
		expect(
			probe({ ct: { pgMount: '/srv/pg', powderNets: '{"internal":{}}' }, dataDir: false, dbUrl: SHARED_URL }),
		).toBe('legacy')
	})

	it('a running container wins over the env file (the cutover edits the env file first)', () => {
		expect(probe({ ct: { pgMount: '/opt/apps/powder-pgdata' }, dataDir: true, dbUrl: PRIVATE_URL })).toBe('legacy')
		expect(probe({ ct: { pp: true }, dataDir: true, dbUrl: SHARED_URL })).toBe('private')
	})

	it('reads quoted values and passwords with @, and ignores an unrelated postgres container', () => {
		expect(probe({ ct: {}, dataDir: true, dbUrl: '"postgres://admin:p@ss@postgres:5432/powder"' })).toBe('legacy')
		expect(probe({ ct: {}, dataDir: true, dbUrl: "'postgres://admin:p@ss@powder-postgres/powder'" })).toBe('private')
		expect(probe({ ct: { pgMount: '/srv/other-app' }, dataDir: true, dbUrl: PRIVATE_URL })).toBe('private')
	})

	it('reads the host after the scheme and before the first / ? #: no userinfo, @ in the query, [v6]', () => {
		const cases: [string, boolean, string][] = [
			['postgres://powder-postgres/powder', true, 'private'],
			['postgres://powder-postgres/powder', false, 'fresh'],
			['postgresql://powder-postgres:5432', true, 'private'],
			['postgres://postgres/powder', true, 'legacy'],
			['postgres://postgres:5432/powder', false, 'legacy'],
			['postgres://admin:pw@powder-postgres:5432/powder?application_name=a@postgres', true, 'private'],
			['postgres://admin:pw@powder-postgres/powder#x@postgres', true, 'private'],
			['postgres://admin:pw@[2001:db8::5]:5432/powder', true, 'private'],
			['postgres://admin:pw@[::1]/powder', false, 'fresh'],
			['postgres://admin:pw@postgres?sslmode=disable', true, 'legacy'],
		]
		for (const shell of ['sh', 'bash'])
			for (const [dbUrl, dataDir, want] of cases)
				expect(probe({ ct: {}, dataDir, dbUrl, shell }), `${shell} ${dbUrl}`).toBe(want)
	})

	it('with no container, host postgres is the private layout only when POWDER_DB_NETWORK=private', () => {
		for (const shell of ['sh', 'bash']) {
			for (const envLines of ['POWDER_DB_NETWORK=private\n', 'POWDER_DB_NETWORK="private"\r\n', "POWDER_DB_NETWORK='private'\n"]) {
				expect(probe({ ct: {}, dataDir: true, dbUrl: SHARED_URL, envLines, shell })).toBe('private')
				expect(probe({ ct: {}, dataDir: false, dbUrl: SHARED_URL, envLines, shell })).toBe('fresh')
			}
			expect(probe({ ct: {}, dataDir: true, dbUrl: SHARED_URL, envLines: 'POWDER_DB_NETWORK=shared\n', shell })).toBe('legacy')
			expect(probe({ ct: {}, dataDir: true, dbUrl: SHARED_URL, envLines: 'POWDER_DB_NETWORK=privatex\n', shell })).toBe('legacy')
			// a container still decides first
			expect(
				probe({ ct: { pgMount: '/opt/apps/powder-pgdata' }, dataDir: true, dbUrl: SHARED_URL, envLines: 'POWDER_DB_NETWORK=private\n', shell }),
			).toBe('legacy')
		}
	})

	it('no env file or another DB host: the data dir decides', () => {
		expect(probe({ ct: {}, dataDir: false })).toBe('fresh')
		expect(probe({ ct: {}, dataDir: true })).toBe('private')
		expect(probe({ ct: {}, dataDir: true, dbUrl: 'postgres://u:p@db.example.com:5432/powder' })).toBe('private')
	})
})
