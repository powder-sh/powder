// A compose rule, restart, and cron import query secrets. Invented names.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type ComposeGuardContext, composeViolations } from '../compose-safety'
import { parseCrontab } from '../crons'
import { deployGuardContext, parseComposeProbe, parseVolumeProbe } from '../deploy/compose-check'
import { mapHostCron } from '../managed-crons'
import { restartCommand } from '../ssh/logs'
import { writeFakeDocker } from './fixtures/fake-docker'

describe('external volume with a device on the server', () => {
	const ctx: ComposeGuardContext = { appName: 'shop', projectDir: '/opt/apps/shop', otherApps: ['acme'] }
	const doc = {
		name: 'shop',
		services: { shop: { image: 'shop:latest', volumes: [{ type: 'volume', source: 'up', target: '/up' }] } },
		volumes: { up: { name: 'shop_up', external: true } },
	}
	it('refuses an external volume whose server copy has a device option', () => {
		const v = composeViolations(doc, { ...ctx, serverVolumeDevices: { shop_up: '/opt/apps/shop-w/sub' } })
		expect(v.map((x) => x.code)).toEqual(['volume_driver'])
		expect(v[0]?.message).toContain('device=/opt/apps/shop-w/sub')
	})
	it('passes the common shape: external volumes without a device, and no probe data', () => {
		expect(composeViolations(doc, { ...ctx, serverVolumeDevices: { acme_other: '/srv/x' } })).toEqual([])
		expect(composeViolations(doc, ctx)).toEqual([])
	})
	it('a non-external volume is left to the on-server guard (its options are in the config)', () => {
		const d = { ...doc, volumes: { up: { name: 'shop_up' } } }
		expect(composeViolations(d, { ...ctx, serverVolumeDevices: { shop_up: '/opt/apps/shop/up' } })).toEqual([])
	})
	it('the probe section reaches the context', () => {
		expect(parseVolumeProbe('shop_up\t{"device":"/x","o":"bind","type":"none"}\nplain\tnull\nother\t{}\nbad\tnot-json\n')).toEqual({ shop_up: '/x' })
		const sep = '__S__'
		const out = ['a'.repeat(64), JSON.stringify(doc), '', 'c1\tshop\tshop\trunning', '', '', '', '', 'shop_up\t{"device":"/x"}'].join(`\n${sep}\n`)
		const input = parseComposeProbe(out, sep)
		expect(input?.volumeDevices).toEqual({ shop_up: '/x' })
		if (!input) throw new Error('the probe did not parse')
		const c = deployGuardContext(input, { appName: 'shop', workingDir: '/opt/apps/shop', composeFiles: ['/opt/apps/shop/docker-compose.yml'], serverId: null, routeHosts: null })
		expect(c.serverVolumeDevices).toEqual({ shop_up: '/x' })
		// an 8-section probe (older) still parses, without volume data
		const old = out.split(`\n${sep}\n`).slice(0, 8).join(`\n${sep}\n`)
		expect(parseComposeProbe(old, sep)?.volumeDevices).toBeUndefined()
	})
})

describe('restart', () => {
	const dir = mkdtempSync(join(tmpdir(), 'restart-'))
	const bin = join(dir, 'bin')
	mkdirSync(bin)
	const log = join(dir, 'log')
	const fake = (running: boolean) => {
		writeFakeDocker(bin, `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\ncase "$1" in inspect) echo ${running ? 'true' : 'false'};; esac\nexit 0\n`)
		writeFileSync(log, '')
	}
	const run = (cmd: string) => spawnSync('sh', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
	it('refuses a container that is not running, restarts a running one', () => {
		fake(false)
		const r = run(restartCommand('shop-db', null))
		expect(r.status).not.toBe(0)
		expect(r.stdout).toContain('restart refused: shop-db is not running')
		expect(spawnSync('cat', [log], { encoding: 'utf8' }).stdout).not.toContain('restart')
		fake(true)
		expect(run(restartCommand('shop-db', null)).status).toBe(0)
		expect(spawnSync('cat', [log], { encoding: 'utf8' }).stdout).toContain('restart -- shop-db')
	})
	it('fails closed: a working dir that cannot be entered refuses, and so does a failing guard', () => {
		fake(true)
		const gone = join(dir, 'no-such-app')
		const r = run(restartCommand('shop-db', { cf: `-f '${gone}/docker-compose.yml'`, app: 'shop', workingDir: gone }))
		expect(r.status).not.toBe(0)
		expect(r.stdout).toContain('restart refused: cannot enter the compose working dir')
		expect(spawnSync('cat', [log], { encoding: 'utf8' }).stdout).not.toContain('restart --')
		// a real dir whose compose config cannot be read: the env file guard refuses
		const wd = join(dir, 'shop')
		mkdirSync(wd, { recursive: true })
		writeFileSync(join(wd, 'docker-compose.yml'), 'services:\n  shop:\n    image: shop\n')
		writeFileSync(
			join(bin, 'docker'),
			`#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\ncase "$1" in inspect) echo true;; compose) exit 1;; esac\nexit 0\n`,
		)
		writeFileSync(log, '')
		const g = run(restartCommand('shop-db', { cf: `-f '${wd}/docker-compose.yml'`, app: 'shop', workingDir: wd }))
		expect(g.status).not.toBe(0)
		expect(g.stdout).toContain('env file guard: refusing')
		expect(spawnSync('cat', [log], { encoding: 'utf8' }).stdout).not.toContain('restart --')
		// not running refuses before the cd and the guards
		fake(false)
		const n = run(restartCommand('shop-db', { cf: `-f '${wd}/docker-compose.yml'`, app: 'shop', workingDir: wd }))
		expect(n.status).not.toBe(0)
		expect(n.stdout).toContain('is not running')
		expect(spawnSync('cat', [log], { encoding: 'utf8' }).stdout).not.toContain('compose')
	})
	it('a managed compose project runs the on-server compose guards before the restart', () => {
		const c = restartCommand('shop-db', { cf: "-f '/opt/apps/shop/docker-compose.yml'", app: 'shop', workingDir: '/opt/apps/shop' })
		const g = c.indexOf('bind guard: refusing')
		expect(c.indexOf('env file guard: refusing')).toBeGreaterThan(0)
		expect(g).toBeGreaterThan(0)
		expect(c.indexOf('docker restart --')).toBeGreaterThan(g)
		expect(restartCommand('shop-db', null)).not.toContain('bind guard')
	})
})

describe('cron import: secret query parameters are not stored', () => {
	const map = (line: string) => {
		const [c] = parseCrontab(line)
		if (!c) throw new Error('no cron line parsed')
		return mapHostCron(c.schedule, c.command, 'shop', c.comment)
	}
	it('drops ?token=... (and other secret-named params) with a note, keeps the rest', () => {
		const r = map('*/5 * * * * curl -fsS "http://127.0.0.1:3000/api/cron/run?job=digest&token=s3cr3tvalue&api_key=k9&page=2"')
		expect(r.ok).toBe(true)
		if (!r.ok) return
		expect(r.draft.urlPath).toBe('/api/cron/run?job=digest&page=2')
		expect(r.warnings.join(' ')).toContain('token, api_key dropped')
		expect(r.warnings.join(' ')).toContain('bearer')
	})
	it('a URL without secret params keeps its query; an all-secret query leaves the bare path', () => {
		const a = map('0 * * * * curl http://127.0.0.1:3000/api/tick?job=a')
		expect(a.ok && a.draft.urlPath).toBe('/api/tick?job=a')
		const b = map('0 * * * * curl http://127.0.0.1:3000/api/tick?secret=x')
		expect(b.ok && b.draft.urlPath).toBe('/api/tick')
	})
})
