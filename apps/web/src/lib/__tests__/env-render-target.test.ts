// the env render target comes from the app's compose (`env_file:`; a repo file
// in the workdir layout) and powder writes it as root before the compose guard runs.
// The target must be /opt/apps/<app>.env, a file inside /opt/apps/<app>/ (no deploy
// key, compose file, .git, symlink), or a pinned target. A pin is only made from
// evidence that predates repo control (powder's own render record for that path from a
// successful deploy of the app before the 0057 cutoff), never for powder's env, another
// app's env or dir, or another app's pin, and never by the dashboard write.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const meta = new Map<string, string>()
const writes: Array<{ path: string; opts: unknown }> = []
let candidates: string[] = []
let apps: string[] = []
/** Render record listing of the env state dir, per env path. */
let stateDirs: Record<string, string> = {}
/** Rows the deploys evidence query returns (the SQL filters are DB-side). */
let evidenceRows: Array<{ id: string }> = []
/** appEnvVars rows (count query); [] = no vars, render skipped. */
let envVarRows: unknown[] = [{ id: 'v1' }]
/** Disk env file contents for the drift guard ('' = no file). */
let diskEnv = ''

vi.mock('../db', async (orig) => {
	const real = (await orig()) as Record<string, unknown>
	const rows = (t: unknown): unknown[] => {
		if (t === real.powderMeta) return [...meta.entries()].map(([key, value]) => ({ key, value }))
		if (t === real.appRepos) return apps.map((name) => ({ name }))
		if (t === real.deploys) return evidenceRows
		if (t === real.appEnvVars) return envVarRows
		return [{ id: 'v1' }]
	}
	const query = (t: unknown) => {
		const q = {
			where: () => q,
			limit: async () => rows(t),
			// drizzle queries are thenables
			then: (ok: (v: unknown[]) => unknown, err?: (e: unknown) => unknown) =>
				Promise.resolve(rows(t)).then(ok, err),
		}
		return q
	}
	const fakeDb = {
		select: () => ({ from: (t: unknown) => query(t) }),
		insert: () => ({
			values: (v: { key: string; value: string }) => ({
				onConflictDoNothing: async () => {
					if (!meta.has(v.key)) meta.set(v.key, v.value)
				},
			}),
		}),
	}
	return { ...real, db: fakeDb }
})

vi.mock('../ssh', () => ({
	envFileCandidatesFor: async () => candidates,
	findEnvFile: async () => ({
		path: candidates[0],
		exists: diskEnv !== '',
		contents: diskEnv,
		candidates,
	}),
	readEnvRestoreMarker: async () => null,
	clearEnvRestoreMarker: async () => {},
	writeEnvFile: async (_s: unknown, path: string, _c: string, opts: unknown) => {
		writes.push({ path, opts })
	},
}))

vi.mock('../ssh/files', async (orig) => ({
	...((await orig()) as Record<string, unknown>),
	listEnvSnapshots: async (_s: unknown, p: string) => stateDirs[p] ?? '',
}))

import { pinReportLine } from '../env-pin-report'
import { envRenderTargetRefusal, pinSql, renderRecordDeployIds } from '../env-target'
import { checkEnvRenderTarget, powderPsqlArgs, prepareEnvFileForDeploy } from '../env-vars-db'
import { noSymlinkBelowShell } from '../repo-symlinks'
import { composeServiceEnvFilePaths, envSnapshotListShell, envStateDirName } from '../ssh/files'

const server = { id: 's1', host: 'h' } as unknown as Parameters<typeof prepareEnvFileForDeploy>[0]
const KEY = 'env_render_target:s1:myapp'

describe('envRenderTargetRefusal (pure)', () => {
	const r = (path: string, pinned: string | null = null) =>
		envRenderTargetRefusal(path, {
			appName: 'myapp',
			pinned,
			otherApps: ['victim', 'myapp-worker'],
			otherPins: ['/opt/docker/stack/env/victim.env'],
			powderEnvFile: '/srv/powder/powder.env',
		})
	it('allows the convention file, the app dir and the pinned target', () => {
		expect(r('/opt/apps/myapp.env')).toBeNull()
		expect(r('/opt/apps/myapp/.env')).toBeNull()
		expect(r('/opt/apps/myapp/env/web.env')).toBeNull()
		expect(r('/opt/docker/stack/env/myapp.env', '/opt/docker/stack/env/myapp.env')).toBeNull()
		expect(r('/opt/apps/myapp.db.env', '/opt/apps/myapp.db.env')).toBeNull()
	})
	it('refuses powder, other apps, other pins, system paths and protected files, pinned or not', () => {
		expect(r('/opt/apps/powder.env', '/opt/apps/powder.env')).toMatch(/powder's own/)
		expect(r('/opt/apps/powder-prod.env')).toMatch(/powder's own/)
		expect(r('/srv/powder/powder.env', '/srv/powder/powder.env')).toMatch(/powder's own/)
		expect(r('/opt/apps/victim.env', '/opt/apps/victim.env')).toMatch(/belongs to the app victim/)
		expect(r('/opt/apps/victim/.env')).toMatch(/belongs to the app victim/)
		expect(r('/opt/apps/myapp-worker.env')).toMatch(/belongs to the app myapp-worker/)
		expect(r('/opt/docker/stack/env/victim.env', '/opt/docker/stack/env/victim.env')).toMatch(
			/another app's recorded/,
		)
		expect(r('/opt/apps/myapp/../victim.env')).toMatch(/\.\./)
		expect(r('/etc/cron.d/x')).toMatch(/system/)
		expect(r('/opt/apps/myapp/.deploy-key')).toMatch(/deploy key/)
		expect(r('/opt/apps/myapp/docker-compose.yml')).toMatch(/compose file/)
		expect(r('/opt/apps/myapp/docker-compose.powder.yml')).toMatch(/compose file/)
		expect(r('/opt/apps/myapp/src/.git/config')).toMatch(/\.git/)
		expect(r('/opt/docker/other/env/x.env', '/opt/docker/stack/env/myapp.env')).toMatch(
			/recorded target/,
		)
		expect(r('/opt/docker/other/env/x.env')).toMatch(/outside this app/)
		expect(r('relative.env')).toMatch(/absolute/)
	})
	it('an app whose name starts with powder keeps its own env file', () => {
		expect(
			envRenderTargetRefusal('/opt/apps/powder-docs.env', { appName: 'powder-docs', pinned: null }),
		).toBeNull()
	})
	it('renderRecordDeployIds: deploy- snapshots, in-place ones only before the cutoff', () => {
		const cut = new Date('2026-11-07T12:00:00Z')
		expect(renderRecordDeployIds('render-abc\ndeploy-def\nbak\npre-xyz\n', cut)).toEqual([
			'def',
			'dep_def',
		])
		// in-place snapshots count only when older than the cutoff (a checkout writes now)
		const before = Math.floor(new Date('2026-10-01T00:00:00Z').getTime() / 1000)
		const after = Math.floor(new Date('2026-11-08T00:00:00Z').getTime() / 1000)
		expect(renderRecordDeployIds(`inplace-old ${before}\ninplace-new ${after}\n`, cut)).toEqual([
			'old',
			'dep_old',
		])
	})
})

describe('noSymlinkBelowShell (bash)', () => {
	it('refuses a planted symlink dir and passes a real path', () => {
		const root = mkdtempSync(join(tmpdir(), 'env-'))
		mkdirSync(join(root, 'src', 'env'), { recursive: true })
		symlinkSync('/tmp', join(root, 'src', 'evil'))
		const run = (p: string) => {
			try {
				execFileSync('bash', ['-c', noSymlinkBelowShell(root, p)], { stdio: 'pipe' })
				return 0
			} catch (e) {
				return (e as { status: number }).status
			}
		}
		expect(run(join(root, 'src', 'env'))).toBe(0)
		expect(run(join(root, 'src', 'evil'))).toBe(41)
		expect(run(join(root, 'src', 'evil', 'deeper'))).toBe(41)
	})
})

describe('checkEnvRenderTarget / prepareEnvFileForDeploy', () => {
	beforeEach(() => {
		meta.clear()
		meta.set('env_target_cutoff', '2026-11-07T12:00:00Z')
		writes.length = 0
		apps = ['myapp', 'victim', 'blog']
		stateDirs = {}
		evidenceRows = []
		envVarRows = [{ id: 'v1' }]
		diskEnv = ''
		candidates = []
		process.env.POWDER_ENV_VARS_DB_MODE = 'on'
	})
	const deployCheck = (path: string, app = 'myapp') =>
		checkEnvRenderTarget(server, app, path, { allowPin: true })

	it('existing install shapes with a pre-upgrade render record are pinned and allowed', async () => {
		for (const [app, path] of [
			['myapp', '/opt/docker/stack/env/myapp.env'],
			['myapp', '/opt/apps/myapp.db.env'],
			['blog', '/opt/apps/blog.pg.env'],
			['myapp', '/opt/apps/shared-ingest.env'],
		] as const) {
			meta.delete(`env_render_target:s1:${app}`)
			for (const k of [...meta.keys()]) if (k.startsWith('env_render_target:')) meta.delete(k)
			stateDirs = { [path]: 'deploy-old1\n' }
			evidenceRows = [{ id: 'dep_old1' }]
			expect(await deployCheck(path, app)).toBeNull()
			expect(meta.get(`env_render_target:s1:${app}`)).toBe(path)
			// unchanged: the next render is allowed by the pin
			expect(await deployCheck(path, app)).toBeNull()
		}
	})

	it('a first render to powder.env or another app env is refused even with a record', async () => {
		for (const path of ['/opt/apps/powder.env', '/opt/apps/victim.env', '/opt/apps/victim/x.env']) {
			stateDirs = { [path]: 'deploy-old1\n' }
			evidenceRows = [{ id: 'dep_old1' }]
			expect(await deployCheck(path)).toMatch(/refus|powder's own|belongs to the app/)
			expect(meta.has(KEY)).toBe(false)
		}
	})

	it("another app's pinned path is refused", async () => {
		meta.set('env_render_target:s1:victim', '/opt/docker/stack/env/shared.env')
		stateDirs = { '/opt/docker/stack/env/shared.env': 'deploy-old1\n' }
		evidenceRows = [{ id: 'dep_old1' }]
		expect(await deployCheck('/opt/docker/stack/env/shared.env')).toMatch(/another app's recorded/)
		expect(meta.has(KEY)).toBe(false)
	})

	it('no pin without pre-upgrade evidence (new app, repo-changed path), without a cutoff, or from the dashboard', async () => {
		// no render record on the server for that path
		expect(await deployCheck('/opt/docker/stack/env/myapp.env')).toMatch(/outside this app/)
		// a record, but no successful pre-cutoff deploy of this app (new app / later render)
		stateDirs = { '/opt/docker/stack/env/myapp.env': 'deploy-new1\n' }
		expect(await deployCheck('/opt/docker/stack/env/myapp.env')).toMatch(/outside this app/)
		// evidence, but no cutoff row
		evidenceRows = [{ id: 'dep_new1' }]
		meta.delete('env_target_cutoff')
		expect(await deployCheck('/opt/docker/stack/env/myapp.env')).toMatch(/outside this app/)
		// the dashboard write never pins
		meta.set('env_target_cutoff', '2026-11-07T12:00:00Z')
		expect(
			await checkEnvRenderTarget(server, 'myapp', '/opt/docker/stack/env/myapp.env', {
				allowPin: false,
			}),
		).toMatch(/outside this app/)
		expect(meta.has(KEY)).toBe(false)
	})

	it('prepareEnvFileForDeploy refuses before any write', async () => {
		candidates = ['/opt/apps/victim.env']
		const res = await prepareEnvFileForDeploy(
			server,
			{ id: 'r1', containerName: 'myapp' },
			'production',
		)
		expect(res).toMatchObject({ rendered: false, unsafeTarget: true, path: '/opt/apps/victim.env' })
		candidates = ['/opt/apps/myapp/src/../../powder.env']
		expect(
			await prepareEnvFileForDeploy(server, { id: 'r1', containerName: 'myapp' }, 'production'),
		).toMatchObject({ unsafeTarget: true })
		expect(writes).toEqual([])
	})
})

describe('evidence, no-write deploys, operator messages', () => {
	beforeEach(() => {
		meta.clear()
		meta.set('env_target_cutoff', '2026-11-07T12:00:00Z')
		writes.length = 0
		apps = ['myapp', 'victim']
		stateDirs = {}
		evidenceRows = []
		envVarRows = [{ id: 'v1' }]
		diskEnv = ''
		candidates = []
		process.env.POWDER_ENV_VARS_DB_MODE = 'on'
	})
	const OUT = '/opt/docker/stack/env/myapp.env'

	it('envSnapshotListShell lists state-dir and old in-place deploy- snapshots, never links', () => {
		const root = mkdtempSync(join(tmpdir(), 'snap-'))
		const envDir = join(root, 'env')
		mkdirSync(envDir)
		const envPath = join(envDir, 'myapp.env')
		const state = join(root, 'state')
		const es = join(state, envStateDirName(envPath))
		mkdirSync(es, { recursive: true })
		writeFileSync(join(es, 'deploy-aaa'), 'x')
		symlinkSync('/etc/hosts', join(es, 'deploy-lnk'))
		writeFileSync(join(es, 'pre-bbb'), 'x')
		writeFileSync(`${envPath}.deploy-ccc`, 'x')
		symlinkSync('/etc/hosts', `${envPath}.deploy-ddd`)
		writeFileSync(join(envDir, 'other.env.deploy-eee'), 'x')
		const out = execFileSync('bash', ['-c', envSnapshotListShell(envPath)], {
			env: { ...process.env, POWDER_ENV_STATE: state },
		}).toString()
		const got = out.trim().split('\n').sort()
		expect(got[0]).toBe('deploy-aaa')
		expect(got[1]).toMatch(/^inplace-ccc \d+$/)
		expect(got).toHaveLength(2)
		// nothing: no state dir, no snapshots
		expect(
			execFileSync('bash', ['-c', envSnapshotListShell(join(envDir, 'none.env'))], {
				env: { ...process.env, POWDER_ENV_STATE: join(root, 'missing') },
			}).toString(),
		).toBe('')
	})

	it('a deploy that will not write never fails on containment', async () => {
		candidates = [OUT] // outside, no pin, no evidence
		// drift-refused render: disk has a key the DB lacks
		diskEnv = 'ONLY_ON_DISK=1\n'
		expect(
			await prepareEnvFileForDeploy(server, { id: 'r1', containerName: 'myapp' }, 'production'),
		).toMatchObject({ rendered: false, refused: true })
		// no env vars in the DB: render skipped
		diskEnv = ''
		envVarRows = []
		expect(
			await prepareEnvFileForDeploy(server, { id: 'r1', containerName: 'myapp' }, 'production'),
		).toMatchObject({ rendered: false, reason: 'no_vars' })
		// DB mode off
		process.env.POWDER_ENV_VARS_DB_MODE = 'off'
		expect(
			await prepareEnvFileForDeploy(server, { id: 'r1', containerName: 'myapp' }, 'production'),
		).toMatchObject({ rendered: false, reason: 'db_mode_off' })
		// a render that WOULD write is refused
		process.env.POWDER_ENV_VARS_DB_MODE = 'on'
		envVarRows = [{ id: 'v1' }]
		expect(
			await prepareEnvFileForDeploy(server, { id: 'r1', containerName: 'myapp' }, 'production'),
		).toMatchObject({ unsafeTarget: true })
		expect(writes).toEqual([])
	})

	it('the refusal says exactly how to pin (dashboard and deploy), or that it can never be pinned', async () => {
		const dash = await checkEnvRenderTarget(server, 'myapp', OUT, { allowPin: false })
		expect(dash).toContain(
			`INSERT INTO powder_meta (key, value) VALUES ('${KEY}', '${OUT}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();`,
		)
		expect(dash).toMatch(/docker exec -i powder-postgres psql -U admin powder/)
		expect(dash).toMatch(/save again/)
		expect(await checkEnvRenderTarget(server, 'myapp', OUT, { allowPin: true })).toMatch(/redeploy/)
		const hard = await checkEnvRenderTarget(server, 'myapp', '/opt/apps/victim.env', {
			allowPin: false,
		})
		expect(hard).toMatch(/can never be pinned/)
		expect(hard).not.toContain('INSERT INTO')
		expect(pinSql('s1', 'a', "/x/it's.env")).toContain("'/x/it''s.env'")
	})

	it("the pin hint names powder's own DB user and name (POWDER_DB_USER / POWDER_DB_NAME), shell-quoted", async () => {
		expect(powderPsqlArgs({})).toBe('-U admin powder')
		expect(powderPsqlArgs({ POWDER_DB_USER: ' ', POWDER_DB_NAME: '' })).toBe('-U admin powder')
		expect(powderPsqlArgs({ POWDER_DB_USER: 'ops', POWDER_DB_NAME: 'powder_main' })).toBe('-U ops powder_main')
		expect(powderPsqlArgs({ POWDER_DB_USER: "o'brien", POWDER_DB_NAME: 'db; echo hi' })).toBe(`-U 'o'\\''brien' 'db; echo hi'`)
		expect(powderPsqlArgs({ POWDER_DB_USER: '-x' })).toBe("-U '-x' powder")
		vi.stubEnv('POWDER_DB_USER', 'ops')
		vi.stubEnv('POWDER_DB_NAME', 'pw db')
		try {
			const dash = await checkEnvRenderTarget(server, 'myapp', OUT, { allowPin: false })
			expect(dash).toContain("docker exec -i powder-postgres psql -U ops 'pw db',")
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it('pinReportLine: ok inside / pinned / evidence, NO with the INSERT otherwise', () => {
		const row = {
			serverId: 's1',
			app: 'myapp',
			target: OUT,
			pinned: null,
			hard: null,
			evidence: null,
		}
		expect(pinReportLine({ ...row, target: '/opt/apps/myapp.env' })).toMatch(/^ok .*inside the app/)
		expect(pinReportLine({ ...row, pinned: OUT })).toMatch(/^ok .*pinned/)
		expect(pinReportLine({ ...row, evidence: 'snapshot' })).toMatch(/^ok .*evidence: snapshot/)
		expect(pinReportLine(row)).toMatch(/^NO .*\n {3}INSERT INTO powder_meta/)
		expect(pinReportLine({ ...row, hard: 'belongs to the app victim' })).toMatch(
			/^NO .*can never be used/,
		)
	})

	it('a planted in-place snapshot (new mtime) is no evidence', async () => {
		const OUT2 = '/opt/docker/stack/env/myapp.env'
		const now = Math.floor(Date.now() / 1000)
		stateDirs = { [OUT2]: `inplace-old1 ${now}\n` }
		evidenceRows = [{ id: 'dep_old1' }]
		meta.set('env_target_cutoff', '2026-11-07T12:00:00Z')
		expect(await checkEnvRenderTarget(server, 'myapp', OUT2, { allowPin: true })).toMatch(
			/outside this app/,
		)
		expect(meta.has(KEY)).toBe(false)
	})
})

describe('the render target is an env_file of the app OWN service', () => {
	const compose = [
		'services:',
		'  myapp:',
		'    image: myapp',
		'    env_file: /opt/apps/myapp.env',
		'  sidecar:',
		'    image: x',
		'    env_file:',
		'      - /var/spool/cron/crontabs/root',
		'      - path: /opt/docker/stack/env/evil.env',
		'',
	].join('\n')
	it('another service listing a path never makes it a candidate', () => {
		expect(
			composeServiceEnvFilePaths(compose, 'myapp', 'myapp', '/opt/apps/myapp/docker-compose.yml'),
		).toEqual(['/opt/apps/myapp.env'])
		// a sidecar listed FIRST in the file does not come first either
		const first = `${compose.replace('  myapp:\n    image: myapp\n    env_file: /opt/apps/myapp.env\n', '')}  myapp:\n    image: myapp\n`
		expect(
			composeServiceEnvFilePaths(first, 'myapp', 'myapp', '/opt/apps/myapp/docker-compose.yml'),
		).toEqual([])
		expect(
			composeServiceEnvFilePaths(compose, 'sidecar', 'myapp', '/opt/apps/myapp/docker-compose.yml'),
		).toEqual(['/var/spool/cron/crontabs/root', '/opt/docker/stack/env/evil.env'])
	})
	it('no service name: the key, then container_name, then the only service; else none', () => {
		const cn =
			'services:\n  web:\n    container_name: myapp\n    env_file: [./a.env]\n  db:\n    env_file: /x/db.env\n'
		expect(
			composeServiceEnvFilePaths(cn, null, 'myapp', '/opt/apps/myapp/docker-compose.yml'),
		).toEqual(['/opt/apps/myapp/a.env'])
		const one = 'services:\n  app:\n    env_file: /opt/apps/demo.env\n'
		expect(composeServiceEnvFilePaths(one, null, 'demo')).toEqual(['/opt/apps/demo.env'])
		const two = 'services:\n  a:\n    env_file: /x/a.env\n  b:\n    env_file: /x/b.env\n'
		expect(composeServiceEnvFilePaths(two, null, 'demo')).toEqual([])
		expect(composeServiceEnvFilePaths('services: [', 'myapp', 'myapp')).toEqual([])
	})
})
