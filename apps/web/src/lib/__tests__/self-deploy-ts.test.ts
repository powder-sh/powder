import { appLockPath } from '../deploy-supersede'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runCommand = vi.fn()
const uploads: string[] = []
vi.mock('../ssh/connection', () => ({ runCommand: (...a: unknown[]) => runCommand(...a) }))
vi.mock('../ssh/files', () => ({
	writeFileViaSftp: async (_s: unknown, _p: string, body: string) => void uploads.push(body),
}))

import { DeployStepError } from '../deploy-failure'
import { parseSelfDbLayout, runSelfDeploy, selfComposeFileArgs } from '../deploy/self-deploy'

const server = { id: 's', host: 'h' } as never

describe('runSelfDeploy', () => {
	beforeEach(() => {
		runCommand.mockReset()
		uploads.length = 0
		runCommand.mockImplementation(async (_s: unknown, cmd: string) => ({
			code: 0,
			stdout: cmd.includes('powder-pgdata') ? 'private\n' : 'image: powder:latest\n',
			stderr: '',
		}))
	})
	it('runs the prep script under timeout -k with the SSH wall of the budget (not a bare 10-min exec)', async () => {
		await runSelfDeploy(
			server,
			'/opt/apps/powder',
			'/opt/apps/powder/docker-compose.yml',
			'powder',
			'deploy-x',
			undefined,
			{
				deployId: 'dep_x',
				budgetSec: 900,
			},
		)
		// call 0 is the DB layout probe
		expect(String(runCommand.mock.calls[0]?.[1])).toContain('powder-pgdata')
		const prep = runCommand.mock.calls[1]
		if (!prep) throw new Error('no prep command')
		expect(String(prep[1])).toMatch(/^timeout -k 30 960 bash /)
		expect(prep[2]).toBe((960 + 30 + 90) * 1000)
		expect(uploads[0]).toContain('docker compose -f')
	})
	it('takes the per-app lock, builds the worker too and recreates it too', async () => {
		await runSelfDeploy(
			server,
			'/opt/apps/powder',
			'/opt/apps/powder/docker-compose.yml',
			'powder',
			'deploy-x',
			undefined,
			{
				deployId: 'dep_x',
			},
		)
		const script = uploads[0] ?? ''
		expect(script).toContain('flock -w 90 9')
		expect(script).toContain(appLockPath('/opt/apps/powder', 'powder'))
		expect(script).toMatch(
			/SELF_TARGETS='powder'; if docker compose .* config --services .* grep -qx 'worker'/,
		)
		expect(script).toContain('build $SELF_TARGETS')
		const fire = String(runCommand.mock.calls[2]?.[1])
		expect(fire).toContain('grep -qx')
		expect(fire).toContain('up -d --force-recreate --no-deps $T')
		expect(fire).toContain('worker')
	})
})

describe('runSelfDeploy: the DB layout probe fails closed', () => {
	const go = () =>
		runSelfDeploy(server, '/opt/apps/powder', '/opt/apps/powder/docker-compose.yml', 'powder', 'deploy-x', undefined, {
			deployId: 'dep_x',
		})
	const probeAnswers = (probe: () => Promise<unknown>) => {
		runCommand.mockReset()
		uploads.length = 0
		runCommand.mockImplementation(async (_s: unknown, cmd: string) =>
			cmd.includes('powder-pgdata') ? probe() : { code: 0, stdout: 'image: powder:latest\n', stderr: '' },
		)
	}
	const refused = async () => {
		const e = await go().then(
			() => null,
			(x: unknown) => x,
		)
		expect(e).toBeInstanceOf(DeployStepError)
		expect(String((e as Error).message)).toMatch(/DB layout of powder's server could not be detected/)
		expect(String((e as Error).message)).toContain('Nothing was recreated')
		expect((e as DeployStepError).failedStep).toBe('preflight')
		// only the probe ran: no prep script, no recreate
		expect(runCommand).toHaveBeenCalledTimes(1)
		expect(uploads).toEqual([])
		return String((e as Error).message)
	}
	it('an ssh error refuses', async () => {
		probeAnswers(async () => {
			throw new Error('connect ECONNREFUSED')
		})
		expect(await refused()).toContain('ECONNREFUSED')
	})
	it('a timeout refuses', async () => {
		probeAnswers(async () => {
			throw new Error('SSH timeout to h')
		})
		expect(await refused()).toContain('SSH timeout')
	})
	it('garbage or an empty answer refuses', async () => {
		for (const stdout of ['image: powder:latest\n', 'Legacy\n', 'legacy fresh\n', '', '\n\n']) {
			probeAnswers(async () => ({ code: 0, stdout, stderr: '' }))
			await refused()
		}
	})
	it('a login banner before the word is fine: the last non-empty line decides', async () => {
		probeAnswers(async () => ({ code: 0, stdout: 'Welcome to box\r\nlegacy\r\n\n', stderr: '' }))
		await go()
		expect(uploads.at(-1)).toContain('docker-compose.shared-db.yml')
	})
	it('parseSelfDbLayout', () => {
		expect(parseSelfDbLayout('private\n')).toBe('private')
		expect(parseSelfDbLayout('motd\nfresh')).toBe('fresh')
		expect(parseSelfDbLayout('legacy\nmotd\n')).toBeNull()
		expect(parseSelfDbLayout(' legacy\n')).toBeNull()
		expect(parseSelfDbLayout('')).toBeNull()
	})
})

describe('eval: in-app self-deploy uses the same compose files as bin/self-deploy.sh', () => {
	const cfg = '/opt/apps/powder/src/docker-compose.yml'
	const args = (layout: 'private' | 'legacy' | 'fresh', env: Record<string, string> = {}) => {
		const r = selfComposeFileArgs(cfg, layout, env)
		return 'args' in r ? r.args : `REFUSED: ${r.refuse}`
	}
	it('private or fresh server with defaults: the base file only (hardened, private DB)', () => {
		expect(args('private')).toBe(`-f '${cfg}'`)
		expect(args('fresh')).toBe(`-f '${cfg}'`)
	})
	it('a shared-network server keeps the shared-db overlay (with a warning note)', () => {
		const r = selfComposeFileArgs(cfg, 'legacy', {})
		expect('args' in r && r.args).toBe(
			`-f '${cfg}' -f '/opt/apps/powder/src/docker-compose.shared-db.yml'`,
		)
		expect('note' in r && r.note).toMatch(/shared-network layout/)
		expect(args('private', { POWDER_DB_NETWORK: 'shared' })).toContain('shared-db.yml')
	})
	it('POWDER_HARDEN=false and POWDER_WEB_READONLY=true add their overrides', () => {
		expect(args('legacy', { POWDER_HARDEN: 'false', POWDER_WEB_READONLY: 'true' })).toBe(
			`-f '${cfg}' -f '/opt/apps/powder/src/docker-compose.shared-db.yml' -f '/opt/apps/powder/src/docker-compose.unharden.yml' -f '/opt/apps/powder/src/docker-compose.web-readonly.yml'`,
		)
	})
	it('refuses POWDER_DB_NETWORK=private on a shared-network server and bad values', () => {
		expect(args('legacy', { POWDER_DB_NETWORK: 'private' })).toMatch(
			/REFUSED: .*--db-network-cutover/,
		)
		expect(args('private', { POWDER_HARDEN: '1' })).toMatch(/REFUSED/)
		expect(args('private', { POWDER_DB_NETWORK: 'x' })).toMatch(/REFUSED/)
	})
	it('the build and the detached recreate both use those files', async () => {
		runCommand.mockImplementation(async (_s: unknown, cmd: string) => ({
			code: 0,
			stdout: cmd.includes('powder-pgdata') ? 'legacy\n' : 'image: powder:latest\n',
			stderr: '',
		}))
		await runSelfDeploy(server, '/opt/apps/powder/src', cfg, 'powder', 'deploy-x', undefined, {
			deployId: 'dep_y',
		})
		expect(uploads.at(-1)).toContain(
			"-f '/opt/apps/powder/src/docker-compose.shared-db.yml' build $SELF_TARGETS",
		)
		const fire = String(runCommand.mock.calls.at(-1)?.[1])
		expect(fire).toContain('docker-compose.shared-db.yml')
		// the recreate log: a 0700 dir of the ssh user, never a shared /tmp path
		expect(fire).toContain('__sld=/var/lib/powder/logs; else __sld="$HOME/.powder-logs"; fi')
		expect(fire).toContain('install -d -m 0700 "$__sld"')
		expect(fire).not.toContain('/tmp/')
	})
})
