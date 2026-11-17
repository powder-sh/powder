import { beforeEach, describe, expect, it, vi } from 'vitest'

// temp files powder writes next to an env target (often inside an app dir a
// repo controls) had predictable names (`<path>.tmp.<Date.now()>`) and the SFTP
// write opened them with plain 'w', which follows a planted symlink.

const opened: Array<{ path: string; flags?: string; mode?: number }> = []
const commands: string[] = []

vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		commands.push(cmd)
		return { code: 0, stdout: '', stderr: '' }
	},
	withConnection: (_s: unknown, h: { onReady: (c: unknown) => void }) => {
		const conn = {
			end: () => {},
			sftp: (cb: (err: Error | null, sftp: unknown) => void) =>
				cb(null, {
					createWriteStream: (path: string, o: { flags?: string; mode?: number }) => {
						opened.push({ path, flags: o.flags, mode: o.mode })
						const handlers: Record<string, () => void> = {}
						return {
							on: (ev: string, fn: () => void) => {
								handlers[ev] = fn
							},
							end: () => setTimeout(() => handlers.close?.(), 0),
						}
					},
				}),
		}
		setTimeout(() => h.onReady(conn), 0)
		return conn
	},
}))

const { writeEnvFile, writeFileSecret, writeFileViaSftp } = await import('../ssh/files')
const { deployGuardContext } = await import('../deploy/compose-check')
const { composeViolations } = await import('../compose-safety')

const server = { id: 's', host: 'h', user: 'root' } as never

beforeEach(() => {
	opened.length = 0
	commands.length = 0
})

describe('temp files: random name, exclusive create', () => {
	it('writeEnvFile writes its temp file with O_EXCL under an unpredictable name', async () => {
		await writeEnvFile(server, '/opt/apps/shop/src/.env', 'A=1\n', {
			noSymlinkBelow: '/opt/apps/shop',
		})
		expect(opened).toHaveLength(1)
		expect(opened[0]?.flags).toBe('wx')
		expect(opened[0]?.path).toMatch(/^\/opt\/apps\/shop\/src\/\.env\.tmp\.[0-9a-f]{16}$/)
		expect(commands.join('\n')).toContain(opened[0]?.path)
	})

	it('writeFileSecret too', async () => {
		await writeFileSecret(server, '/opt/apps/shop/.deploy-key', 'KEY\n')
		expect(opened[0]?.flags).toBe('wx')
		expect(opened[0]?.path).toMatch(/\.deploy-key\.tmp\.[0-9a-f]{16}$/)
	})

	it('two writes never share a temp name', async () => {
		await writeEnvFile(server, '/opt/apps/shop.env', 'A=1\n')
		await writeEnvFile(server, '/opt/apps/shop.env', 'A=1\n')
		expect(opened[0]?.path).not.toBe(opened[1]?.path)
	})

	it('a plain SFTP write keeps truncate-or-create semantics', async () => {
		await writeFileViaSftp(server, '/tmp/x', 'y')
		expect(opened[0]?.flags).toBe('w')
	})
})

describe('the env render target is a protected path', () => {
	const ctx = (envTarget: string | null) =>
		deployGuardContext(
			{
				hash: 'a'.repeat(64),
				resolved: { name: 'shop', services: {} },
				raw: {},
				containers: [],
			} as never,
			{
				appName: 'shop',
				workingDir: '/opt/apps/shop',
				composeFiles: ['/opt/apps/shop/docker-compose.yml'],
				serverId: 's',
				routeHosts: null,
				envTarget,
			},
		)
	const bind = (src: string) => ({
		name: 'shop',
		services: {
			shop: { image: 'shop:latest', volumes: [{ type: 'bind', source: src, target: '/x' }] },
		},
	})

	it('a compose cannot bind the file powder renders the env into (in-dir target)', () => {
		const c = ctx('/opt/apps/shop/src/.env')
		expect(c.protectedPaths).toContain('/opt/apps/shop/src/.env')
		const v = composeViolations(bind('/opt/apps/shop/src/.env'), c)
		expect(v.map((x) => x.code)).toContain('bind')
		// nor a directory that contains it
		expect(composeViolations(bind('/opt/apps/shop/src'), c).map((x) => x.code)).toContain('bind')
	})

	it('other binds inside the app dir stay allowed', () => {
		expect(
			composeViolations(bind('/opt/apps/shop/data'), ctx('/opt/apps/shop/src/.env')).map(
				(x) => x.code,
			),
		).not.toContain('bind')
	})
})

describe('no predictable /tmp names for files powder writes', () => {
	const { readFileSync } = require('node:fs') as typeof import('node:fs')
	const { join } = require('node:path') as typeof import('node:path')
	const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')
	it('the pg env file, deploy key, compose, backup / restore / builder / deploy scripts and stage override use random names', () => {
		const files = [
			'app/api/databases/route.ts',
			'app/api/apps/route.ts',
			'lib/backups.ts',
			'lib/backup-restore.ts',
			'lib/builder.ts',
			'lib/deploy/run.ts',
			'lib/deploy/script.ts',
		]
		for (const f of files) {
			const t = src(f)
			expect(t, f).not.toMatch(
				/(?<!randomTempPath\()`\/tmp\/powder-[a-z-]+-\$\{(Date\.now\(\)|id|row\.id|stageId)\}/,
			)
			expect(t, f).not.toMatch(
				/Math\.random\(\)\.toString\(36\)[^\n]*\/tmp|\/tmp\/[^\n]*Math\.random/,
			)
		}
		expect(src('lib/deploy/script.ts')).toContain('STAGE_OVR=$(mktemp /tmp/powder-stage.XXXXXX)')
	})
	it('restoreScriptPath is random per call', async () => {
		const { restoreScriptPath } = await import('../backup-restore-logic')
		expect(restoreScriptPath('r1')).not.toBe(restoreScriptPath('r1'))
		expect(restoreScriptPath('r1')).toMatch(/^\/tmp\/powder-restore-r1\.[0-9a-f]{16}\.sh$/)
	})
})
