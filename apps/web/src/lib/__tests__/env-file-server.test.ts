// server data in the ownership rules. A leftover /opt/apps/<x>.env (a removed
// app's, a copied file) is not claimed by naming a container <x>; powder's own env files
// are never an app's; compose projects, volume labels and app folders on the server join the
// longest-owner rule; an existing volume labelled for another project is refused.
// Invented names only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type ComposeGuardContext, composeViolations, envFileOwnerAllowed, ownByPrefix, powderEnvFileHit } from '../compose-safety'
import {
	APPS_DIR_OK,
	APPS_DIR_PROBE,
	serverOwnership,
	type ComposeCheckInput,
	deployGuardContext,
	parseAppsDirProbe,
	parseComposeProbe,
	parseVolumeProjectProbe,
	probeSeparator,
} from '../deploy/compose-check'

function ctxFor(appName: string, extra: Partial<ComposeGuardContext> = {}): ComposeGuardContext {
	return { appName, projectDir: `/opt/apps/${appName}`, otherApps: ['quillbox'], foreignContainers: [], ownProjectContainers: [appName], resolved: true, powderEnvFile: null, ...extra }
}
function cfg(app: string, extra: Record<string, unknown>, top: Record<string, unknown> = {}) {
	return { name: app, services: { [app]: { image: `${app}:latest`, container_name: app, env_file: [`/opt/apps/${app}.env`] }, ...extra }, ...top }
}
const sidecar = (name: string) => ({ s: { image: 'alpine:3', container_name: name, env_file: [`/opt/apps/${name}.env`] } })
const envHits = (v: { code: string; message: string }[]) => v.filter((x) => x.code === 'env_file').map((x) => x.message)

describe('the container_name path needs this project or a file that does not exist yet', () => {
	it('a leftover env file named after a made-up container is refused', () => {
		const v = composeViolations(cfg('zorbapp', sidecar('worker')), ctxFor('zorbapp', { serverEnvFiles: ['zorbapp.env', 'worker.env'] }))
		expect(envHits(v).join('\n')).toContain('/opt/apps/worker.env')
	})
	it('unknown server data counts as existing', () => {
		const v = composeViolations(cfg('zorbapp', sidecar('worker')), ctxFor('zorbapp'))
		expect(envHits(v)).toHaveLength(1)
	})
	it('passes when the file does not exist yet, or the container already runs in this project', () => {
		expect(envHits(composeViolations(cfg('zorbapp', sidecar('worker')), ctxFor('zorbapp', { serverEnvFiles: ['zorbapp.env'] })))).toEqual([])
		expect(envHits(composeViolations(cfg('zorbapp', sidecar('worker')), ctxFor('zorbapp', { serverEnvFiles: ['worker.env'], ownProjectContainers: ['zorbapp', 'worker'] })))).toEqual([])
		expect(envHits(composeViolations(cfg('zorbapp', sidecar('worker')), ctxFor('zorbapp', { ownProjectContainers: ['zorbapp', 'worker'] })))).toEqual([])
	})
	it('envFileOwnerAllowed: the own-name and own-prefix forms do not need server data', () => {
		const c = ctxFor('zorbapp', { serverEnvFiles: ['zorbapp.db.env', 'zorbapp-db.env'] })
		expect(envFileOwnerAllowed('zorbapp', c, new Set())).toBe(true)
		expect(envFileOwnerAllowed('zorbapp.db', c, new Set())).toBe(true)
		expect(envFileOwnerAllowed('zorbapp-db', c, new Set(['zorbapp-db']))).toBe(true)
		expect(envFileOwnerAllowed('worker', c, new Set(['worker']))).toBe(true)
		expect(envFileOwnerAllowed('worker', { ...c, serverEnvFiles: ['worker.env'] }, new Set(['worker']))).toBe(false)
		// another registered app's name stays refused even when the file is missing
		expect(envFileOwnerAllowed('quillbox', c, new Set(['quillbox']))).toBe(false)
	})
	it("powder's own env files are refused for every app, also through a container name", () => {
		for (const p of ['/opt/apps/powder.env', '/opt/apps/powder-worker.env', '/opt/apps/powder/.env', '/opt/apps/powder/x/y.env', '/opt/apps/zorbapp/../powder.env'])
			expect(envHits(composeViolations(cfg('zorbapp', { s: { image: 'alpine:3', container_name: 'powder-worker', env_file: [p] } }), ctxFor('zorbapp', { serverEnvFiles: [] }))).join('\n'), p).toContain('powder')
		const v = composeViolations(cfg('zorbapp', { s: { image: 'alpine:3', env_file: ['/srv/pw/main.env'] } }), ctxFor('zorbapp', { powderEnvFile: '/srv/pw/main.env' }))
		expect(envHits(v).join('\n')).toContain("powder's own env file")
		expect(powderEnvFileHit('/opt/apps/powderly/x.env', null)).toBe(false)
		expect(powderEnvFileHit('/opt/apps/zorbapp.env', '/opt/apps/powder.env')).toBe(false)
	})
})

describe('server owners in the longest-owner rule; volume labels', () => {
	const srv = { serverOwners: ['zorbapp-api', 'traefik'] }
	it('a compose project on the server that is not a registered app wins over a shorter app', () => {
		expect(ownByPrefix('zorbapp-api_data', { appName: 'zorbapp', otherApps: [] }, ['-', '_'])).toBe(true)
		expect(ownByPrefix('zorbapp-api_data', { appName: 'zorbapp', otherApps: [], ...srv }, ['-', '_'])).toBe(false)
		const v = composeViolations(cfg('zorbapp', {}, { volumes: { d: { name: 'zorbapp-api_data', external: true } } }), ctxFor('zorbapp', srv))
		expect(v.map((x) => x.code)).toContain('volume_name')
		// prefix env file of the longer owner
		expect(envFileOwnerAllowed('zorbapp-api', ctxFor('zorbapp', { ...srv, serverEnvFiles: [] }), new Set())).toBe(false)
		// own names stay own
		expect(composeViolations(cfg('zorbapp', {}, { volumes: { d: {} } }), ctxFor('zorbapp', srv)).map((x) => x.code)).not.toContain('volume_name')
	})
	it('an existing volume labelled for another project is refused; own label or no label passes', () => {
		const top = { volumes: { d: { name: 'zorbapp_data', external: true }, e: {} } }
		const other = composeViolations(cfg('zorbapp', {}, top), ctxFor('zorbapp', { serverVolumeProjects: { zorbapp_data: 'quillbox' } }))
		expect(other.filter((x) => x.code === 'volume_name').map((x) => x.message).join('\n')).toContain('belongs to the compose project "quillbox"')
		expect(composeViolations(cfg('zorbapp', {}, top), ctxFor('zorbapp', { serverVolumeProjects: { zorbapp_data: 'zorbapp', zorbapp_e: 'zorbapp' } })).map((x) => x.code)).not.toContain('volume_name')
		expect(composeViolations(cfg('zorbapp', {}, top), ctxFor('zorbapp', { serverVolumeProjects: {} })).map((x) => x.code)).not.toContain('volume_name')
	})
	it('serverOwnership: projects (any state), volume labels and compose folders, never this app', () => {
		const input = {
			containers: [
				{ name: 'zorbapp', image: 'zorbapp:latest', project: 'zorbapp', state: 'running' },
				{ name: 'old', image: 'x', project: 'zorbapp-api', state: 'exited' },
				{ name: 'loose', image: 'x', project: '' },
			],
			appsDir: { 'zorbapp.env': 'f', 'worker.env': 'l', 'zorbapp-files': 'd', 'gone-svc': 'dc', 'x.env': 'd', zorbapp: 'dc' },
			volumeProjects: { 'zorbapp-old_pg': 'zorbapp-old', zorbapp_data: 'zorbapp' },
		}
		const b = serverOwnership(input, 'zorbapp')
		expect(b.serverOwners).toEqual(['gone-svc', 'zorbapp-api', 'zorbapp-old'])
		expect([...(b.serverEnvFiles ?? [])].sort()).toEqual(['worker.env', 'zorbapp.env'])
		expect(b.serverVolumeProjects).toEqual(input.volumeProjects)
		expect(serverOwnership({ containers: [] }, 'zorbapp')).toEqual({ serverOwners: [] })
		const ctx = deployGuardContext({ ...input, resolved: {}, raw: null, hash: 'x' } as ComposeCheckInput, { appName: 'zorbapp', workingDir: '/opt/apps/zorbapp', composeFiles: ['/opt/apps/zorbapp/docker-compose.yml'], serverId: null, routeHosts: null })
		expect(ctx.serverOwners).toEqual(['gone-svc', 'zorbapp-api', 'zorbapp-old'])
		expect(ctx.serverEnvFiles).toContain('worker.env')
	})
})

describe('the probe sections', () => {
	const root = mkdtempSync(join(tmpdir(), 'apps-'))
	afterAll(() => rmSync(root, { recursive: true, force: true }))
	it('APPS_DIR_PROBE lists names and kinds; the parsers keep clean names only', () => {
		const a = join(root, 'apps')
		mkdirSync(join(a, 'withc', 'src'), { recursive: true })
		writeFileSync(join(a, 'withc', 'src', 'docker-compose.yml'), 'services: {}\n')
		mkdirSync(join(a, 'datadir'))
		writeFileSync(join(a, 'left.env'), 'A=1\n')
		const r = spawnSync('sh', ['-c', APPS_DIR_PROBE.replaceAll('/opt/apps', a)], { encoding: 'utf8' })
		expect(r.stdout.trim().endsWith(APPS_DIR_OK)).toBe(true)
		expect(parseAppsDirProbe(r.stdout)).toEqual({ withc: 'dc', datadir: 'd', 'left.env': 'f' })
		expect(parseAppsDirProbe(`ok\tf\nbad name\tf\nx\tzz\n${APPS_DIR_OK}\n`)).toEqual({ ok: 'f' })
		// no end marker (empty, cut off, unreadable dir): unknown, fail closed
		expect(parseAppsDirProbe('')).toBeUndefined()
		expect(parseAppsDirProbe('ok\tf\n')).toBeUndefined()
		const missing = spawnSync('sh', ['-c', APPS_DIR_PROBE.replaceAll('/opt/apps', join(root, 'nope'))], { encoding: 'utf8' })
		expect(parseAppsDirProbe(missing.stdout)).toBeUndefined()
		expect(parseVolumeProjectProbe('v1\tp1\nv2\t\nv3\t<no value>\nbad v\tp\n')).toEqual({ v1: 'p1' })
	})
	it('parseComposeProbe reads sections 11 and 12, and older outputs without them', () => {
		const sep = probeSeparator('ab12')
		const base = ['0'.repeat(64), '{}', '{}', 'c\tcimg\tproj\trunning', '', '', '', '', '', 'ghcr.io']
		const full = parseComposeProbe([...base, `left.env\tf\n${APPS_DIR_OK}`, 'v1\tp1'].join(`\n${sep}\n`), sep)
		expect(full?.appsDir).toEqual({ 'left.env': 'f' })
		// a section without its end marker is unknown, so env files count as existing
		const cut = parseComposeProbe([...base, '', 'v1\tp1'].join(`\n${sep}\n`), sep)
		expect(cut?.appsDir).toBeUndefined()
		expect(serverOwnership(cut as ComposeCheckInput, 'zorbapp').serverEnvFiles).toBeUndefined()
		expect(full?.volumeProjects).toEqual({ v1: 'p1' })
		const old = parseComposeProbe(base.join(`\n${sep}\n`), sep)
		expect(old).not.toBeNull()
		expect(old?.appsDir).toBeUndefined()
	})
})

describe('platform and build.pull (never exemptable)', () => {
	const svc = (extra: Record<string, unknown>, build: Record<string, unknown> = {}) =>
		cfg('zorbapp', { w: { image: 'zorbapp-w:latest', container_name: 'zorbapp-w', build: { context: '/opt/apps/zorbapp/src', ...build }, ...extra } })
	const codesOf = (doc: unknown, extra: Partial<ComposeGuardContext> = {}) => composeViolations(doc, ctxFor('zorbapp', extra)).map((v) => v.code)
	it('refuses service platform, build.platforms and build.pull', () => {
		expect(codesOf(svc({ platform: 'linux/arm64' }))).toContain('platform')
		expect(codesOf(svc({}, { platforms: ['linux/amd64'] }))).toContain('platform')
		expect(codesOf(svc({}, { pull: true }))).toContain('build_pull')
		expect(codesOf(svc({}, { pull: 'true' }))).toContain('build_pull')
		// a value for an automatic platform ARG, map and list form, any case
		expect(codesOf(svc({}, { args: { TARGETPLATFORM: 'linux/arm64' } }))).toContain('platform')
		expect(codesOf(svc({}, { args: ['buildarch=arm64'] }))).toContain('platform')
		expect(codesOf(svc({}, { args: { TARGETARCHX: '1', NODE_ENV: 'production' } }))).not.toContain('platform')
	})
	it('passes without them, and with build.pull false', () => {
		const c = codesOf(svc({}, { pull: false }))
		expect(c).not.toContain('platform')
		expect(c).not.toContain('build_pull')
	})
	it('an operator exemption does not lift them', () => {
		const ex = { exempt: ['platform', 'build_pull'], exemptValues: { platform: ['linux/arm64', 'build.platforms'], build_pull: ['build.pull'] } }
		expect(codesOf(svc({ platform: 'linux/arm64' }), ex)).toContain('platform')
		expect(codesOf(svc({}, { platforms: ['linux/amd64'], pull: true }), ex)).toEqual(expect.arrayContaining(['platform', 'build_pull']))
		expect(codesOf(svc({}, { args: { TARGETOS: 'linux' } }), { exempt: ['platform'], exemptValues: { platform: ['build.args.TARGETOS'] } })).toContain('platform')
	})
})
