// Case-insensitive names, safe name characters, nonce-separated JSON alias
// probe, Dockerfile image authority, scoped exemptions, <app>-db clashes, the foreign
// image residual and the pinned dump-check image. Invented names only.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { appNameDbClash, dbContainerOwnShell } from '../backup-db-owner'
import { buildDownloadCommands } from '../backup-restore-logic'
import { DFR_FOREIGN_AWK, dockerfileAuthorityShell, dockerfileRewriteFunctions } from '../build-cache'
import {
	type ComposeGuardContext,
	composeViolations,
	dockerfileImageForeign,
	exemptCodesFor,
	exemptionFor,
	neverExemptable,
} from '../compose-safety'
import { type ComposeCheckInput, deployGuardContext, parseAliasProbe, parseComposeProbe, probeSeparator } from '../deploy/compose-check'
import { postgresToolImage } from '../tool-images'
import { writeFakeDocker } from './fixtures/fake-docker'

const root = mkdtempSync(join(tmpdir(), 'rules-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ctx: ComposeGuardContext = {
	appName: 'shopx',
	projectDir: '/opt/apps/shopx',
	otherApps: ['blogx', 'mailx'],
	foreignContainers: ['blogx', 'blogx-db'],
	ownProjectContainers: ['shopx', 'shopx-db'],
	foreignNamesByNetwork: { infra: ['blogx-db', 'db'] },
	resolved: true,
}
const codes = (d: unknown, c: ComposeGuardContext = ctx) => composeViolations(d, c).map((v) => v.code)
const on = (net: string, aliases: string[]) => ({
	name: 'shopx',
	services: { shopx: { image: 'shopx:latest', networks: { [net]: { aliases } } } },
	networks: { [net]: { external: true, name: net } },
})

describe('names compare case-insensitively', () => {
	it('an alias DB is refused where db is', () => {
		expect(codes(on('infra', ['db']))).toContain('network_alias')
		expect(codes(on('infra', ['DB']))).toContain('network_alias')
		expect(codes(on('infra', ['Blogx-DB']))).toContain('network_alias')
		expect(codes(on('infra', ['POSTGRES']))).toContain('network_alias')
	})
	it('service keys and container_name too', () => {
		const svc = (key: string) => ({ name: 'shopx', services: { [key]: { image: 'shopx:latest', networks: ['infra'] } }, networks: { infra: { external: true } } })
		expect(codes(svc('DB'))).toContain('service_key')
		expect(codes(svc('Traefik'))).toContain('service_key')
		const cn = (n: string) => ({ name: 'shopx', services: { shopx: { image: 'shopx:latest', container_name: n } } })
		expect(codes(cn('BLOGX'))).toContain('container_name')
		expect(codes(cn('Powder'))).toContain('container_name')
		expect(codes(cn('MailX-db'))).toContain('container_name')
		expect(codes(cn('ShopX'))).not.toContain('container_name')
	})
	it("the app's own names in any case pass", () => {
		expect(codes(on('infra', ['shopx', 'SHOPX-db']))).toEqual([])
	})
})

describe('name characters and the probe', () => {
	it('refuses aliases, container_name, hostname and service keys outside [A-Za-z0-9._-]', () => {
		expect(codes(on('shopx_own', ['zz;internal=db']))).toContain('network_alias')
		expect(codes(on('shopx_own', ['a\n__POWDER_CG_SEP__\nb']))).toContain('network_alias')
		expect(codes({ name: 'shopx', services: { shopx: { image: 'shopx:latest', container_name: 'a b' } } })).toContain('container_name')
		expect(codes({ name: 'shopx', services: { shopx: { image: 'shopx:latest', hostname: 'x;y' } } })).toContain('hostname')
		expect(codes({ name: 'shopx', services: { 'a,b': { image: 'shopx:latest' } } })).toContain('service_key')
		expect(codes({ name: 'shopx', services: { shopx: { image: 'shopx:latest', hostname: 'shop-x.internal' } } })).toEqual([])
	})
	it('aliases are parsed as JSON: a hostile alias stays one alias of one container', () => {
		const line = `${JSON.stringify('/evil')}\t${JSON.stringify('evil')}\t${JSON.stringify({ infra: { Aliases: ['zz;internal=db', 'x\n__POWDER_CG_SEP__\ny'] } })}`
		const out = parseAliasProbe(`${line}\n`)
		expect(out).toEqual([{ name: 'evil', project: 'evil', networks: { infra: ['zz;internal=db', 'x\n__POWDER_CG_SEP__\ny'] } }])
	})
	it('the section separator is a fresh nonce; the fixed constant in content splits nothing', () => {
		const a = probeSeparator()
		expect(a).toMatch(/^__POWDER_CG_SEP_[0-9a-f]{32}__$/)
		expect(probeSeparator()).not.toBe(a)
		const cfg = JSON.stringify({ name: 'shopx', services: {} })
		const ps = 'x\tnode\t\trunning\n__POWDER_CG_SEP__\nmore'
		const parsed = parseComposeProbe(['h'.repeat(64), cfg, cfg, ps].join(`\n${a}\n`), a)
		expect(parsed?.containers.map((c) => c.name)).toEqual(['x', '__POWDER_CG_SEP__', 'more'])
	})
})

describe('Dockerfile image refs against the image authority', () => {
	const auth = { self: 'shopx', foreign: ['ghcr.io/acme/blogx-web', 'mailx-worker', 'acme/jobs'], others: ['blogx', 'mailx'] }
	const awk = (ref: string, a = auth) =>
		spawnSync('awk', [DFR_FOREIGN_AWK], {
			input: `${ref}\n`,
			encoding: 'utf8',
			env: { ...process.env, LC_ALL: 'C', DFR_FOREIGN: a.foreign.join(' '), DFR_OTHERS: a.others.join(' '), DFR_SELF: a.self },
		}).stdout.trim()
	const COMMON = [
		'node:22-alpine', 'node:20-alpine', 'node:22.23.3-bookworm-slim', 'node:20-bookworm-slim', 'node:24-alpine',
		'node:22-bookworm-slim', `node:22-alpine@sha256:${'0'.repeat(64)}`, 'node:22.23-alpine', 'node:20-alpine3.22',
		'node:20-bookworm', 'alpine/git:latest', 'oven/bun:1.2.14-alpine',
	]
	const VICTIM = [
		'blogx:latest', 'blogx', 'ghcr.io/acme/blogx', `ghcr.io/acme/blogx@sha256:${'1'.repeat(64)}`, 'blogx-web:1',
		'ghcr.io/acme/blogx-web:latest', 'docker.io/library/mailx-worker:2', 'acme/jobs', 'MAILX_cron', `sha256:${'2'.repeat(64)}`,
	]
	it('common base images pass, other apps images are refused (TS and awk agree)', () => {
		for (const r of COMMON) {
			expect(dockerfileImageForeign(r, auth), r).toBeNull()
			expect(awk(r), r).toBe('')
		}
		for (const r of VICTIM) {
			expect(dockerfileImageForeign(r, auth), r).not.toBeNull()
			expect(awk(r), r).not.toBe('')
		}
		// own images and own-prefixed names pass
		for (const r of ['shopx:latest', 'shopx-base', 'ghcr.io/acme/shopx']) {
			expect(dockerfileImageForeign(r, auth), r).toBeNull()
			expect(awk(r), r).toBe('')
		}
	})
	it('the longest app name decides a prefix', () => {
		const a = { self: 'blogx-v2', foreign: [], others: ['blogx'] }
		expect(dockerfileImageForeign('blogx-v2-web', a)).toBeNull()
		expect(awk('blogx-v2-web', a)).toBe('')
		expect(dockerfileImageForeign('blogx-web', a)).not.toBeNull()
		expect(awk('blogx-web', a)).not.toBe('')
	})
	it('dfr_one refuses FROM / COPY --from a victim image even with a RepoDigest; stage names pass', () => {
		const bin = join(root, 'bin3')
		mkdirSync(bin, { recursive: true })
		// docker 29 containerd store: every local image has a RepoDigest
		writeFakeDocker(bin, '#!/bin/bash\nif [ "$1 $2" = "image inspect" ]; then echo 1; exit 0; fi\nexit 0\n')
		const run = (df: string, mode = 'enforce') => {
			const dir = mkdtempSync(join(root, 'df-'))
			writeFileSync(join(dir, 'Dockerfile'), df)
			const script = `DFR_NS=a1b2c3d4e5f60718293a4b5c6d7e8f90; DFR_APP=shopx; DFR_DIR=$(mktemp -d); DFR_MODE=${mode}; DFR_PULL=1; DFR_OWN='shopx:latest'; ${dockerfileAuthorityShell(auth)}${dockerfileRewriteFunctions('shopx')}dfr_one ${JSON.stringify(join(dir, 'Dockerfile'))} ${JSON.stringify(join(dir, 'out'))}`
			const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
			return { code: r.status, log: r.stdout + r.stderr }
		}
		const ok = run('FROM node:22-alpine AS deps\nFROM deps AS builder\nCOPY --from=deps /a /a\nFROM node:22-alpine\nCOPY --from=builder /app /app\nCOPY --from=alpine/git:latest /usr/bin/git /git\n')
		expect(ok.code, ok.log).toBe(0)
		const a = run('FROM blogx:latest\n')
		expect(a.code).not.toBe(0)
		expect(a.log).toContain('reads the local image blogx:latest')
		expect(run('FROM node:22\nCOPY --from=ghcr.io/acme/blogx /app /app\n').code).not.toBe(0)
		expect(run('FROM node:22\nRUN --mount=type=bind,from=acme/jobs,target=/s true\n').code).not.toBe(0)
		const w = run('FROM blogx:latest\n', 'warn')
		expect(w.code).toBe(0)
		expect(w.log).toContain('[compose-guard] WARN shopx dockerfile_image')
	})
})

describe('exemptions', () => {
	const raw = JSON.stringify({ formsx: ['network_mode'], 'boxa/shopx': { network_mode: ['host'], bind: ['/srv/data/'] } })
	it('the live code-list form keeps working, with a bare-key warning', () => {
		expect(exemptCodesFor('boxa', 'formsx', raw)).toEqual(['network_mode'])
		const e = exemptionFor('boxa', 'formsx', raw)
		expect(e.warnings[0]).toContain('bare key "formsx"')
		const host = { name: 'formsx', services: { app: { image: 'formsx:latest', network_mode: 'host' } } }
		expect(codes(host, { ...ctx, appName: 'formsx', exempt: e.codes })).toEqual([])
	})
	it('the value form allows only the named values; serverId keys warn nothing', () => {
		const e = exemptionFor('boxa', 'shopx', raw)
		expect(e.warnings).toEqual([])
		const c = { ...ctx, exempt: e.codes, exemptValues: e.values }
		const svc = (x: Record<string, unknown>) => ({ name: 'shopx', services: { shopx: { image: 'shopx:latest', ...x } } })
		expect(codes(svc({ network_mode: 'host' }), c)).toEqual([])
		expect(codes(svc({ volumes: ['/srv/data/uploads:/u'] }), c)).toEqual([])
		expect(codes(svc({ volumes: ['/srv/other:/u'] }), c)).toContain('bind')
	})
	it('no exemption opens another container namespace, the host root, system dirs or another app', () => {
		const all = {
			...ctx,
			exempt: ['network_mode', 'pid', 'ipc', 'bind'],
			exemptValues: { bind: ['/'], network_mode: ['container:blogx'] },
		}
		const svc = (x: Record<string, unknown>) => ({ name: 'shopx', services: { shopx: { image: 'shopx:latest', ...x } } })
		for (const x of [
			{ network_mode: 'container:blogx' },
			{ network_mode: 'container:Traefik' },
			{ network_mode: 'service:nothere' },
			{ pid: 'container:blogx' },
			{ ipc: 'container:blogx-db' },
			{ volumes: ['/:/host'] },
			{ volumes: ['/etc:/e'] },
			{ volumes: ['/var:/v'] },
			{ volumes: ['/var/lib/docker/volumes:/v'] },
			{ volumes: ['/run/docker.sock:/d'] },
			{ volumes: ['/opt/apps/blogx:/b'] },
			{ volumes: ['/opt/apps/blogx.env:/b'] },
			{ volumes: ['/opt/apps:/a'] },
			{ volumes: ['/opt/apps/powder:/p'] },
			{ volumes: ['/proc:/p'] },
		])
			expect(codes(svc(x), all), JSON.stringify(x)).not.toEqual([])
		// still exemptable: host networking, an own sidecar namespace, own data dirs
		expect(codes(svc({ network_mode: 'host' }), all)).toEqual([])
		expect(codes(svc({ pid: 'container:shopx-db' }), all)).toEqual([])
		expect(codes(svc({ volumes: ['/opt/apps/shopx-data:/d'] }), all)).toEqual([])
		expect(neverExemptable({ code: 'bind', message: '', value: '/srv/x' }, ctx)).toBe(false)
	})
})

describe('more paths no exemption opens', () => {
	const c: ComposeGuardContext = {
		...ctx,
		protectedPaths: ['/opt/apps/shopx/docker-compose.yml', '/opt/apps/shopx/.deploy-key', '/opt/apps/shopx.env', '/opt/apps/shopx/src/.git', '/opt/apps/shopx/.git'],
		exempt: ['bind'],
	}
	const svc = (src: string) => ({ name: 'shopx', services: { shopx: { image: 'shopx:latest', volumes: [`${src}:/m`] } } })
	it('system folders, the app dir itself and its compose / key / git stay refused', () => {
		for (const src of [
			'/var/spool/cron', '/usr', '/usr/local/bin', '/bin', '/sbin', '/lib', '/lib64/x', '/libx32', '/home/u', '/var/lib',
			'/var/lib/postgresql', '/var/log', '/opt/apps/shopx', '/opt/apps/shopx/docker-compose.yml', '/opt/apps/shopx/.deploy-key',
			'/opt/apps/shopx/src', '/opt/apps/shopx/.git',
		])
			expect(codes(svc(src), c), src).toContain('bind')
	})
	it('sibling data dirs and other app-dir subfolders stay exemptable', () => {
		for (const src of ['/opt/apps/shopx-data', '/opt/apps/shopx/uploads', '/opt/apps/shopx/src/public', '/srv/data', '/var/shopx', '/library'])
			expect(codes(svc(src), c), src).toEqual([])
	})
})

describe('a writable bind inside git metadata', () => {
	const c: ComposeGuardContext = {
		...ctx,
		protectedPaths: ['/opt/apps/shopx/docker-compose.yml', '/opt/apps/shopx/src/.git', '/opt/apps/shopx/.git'],
	}
	const svc = (v: unknown) => ({ name: 'shopx', services: { shopx: { image: 'shopx:latest', volumes: [v] } } })
	it('is a high bind finding like at / above it; :ro and read_only pass', () => {
		for (const src of ['./src/.git/hooks', './src/.git/modules/x', '/opt/apps/shopx/.git/info', '/opt/apps/shopx/.git/objects'])
			expect(codes(svc(`${src}:/m`), c), src).toContain('bind')
		expect(codes(svc('./src/.git/hooks:/m:ro'), c)).toEqual([])
		expect(codes(svc({ type: 'bind', source: '/opt/apps/shopx/.git/info', target: '/m', read_only: true }), c)).toEqual([])
		expect(codes(svc('./src/public:/m'), c)).toEqual([])
		expect(codes(svc('./src/.gitkeep-dir:/m'), c)).toEqual([])
	})
})

describe('<app>-db', () => {
	it('refuses <other>-db and <name> when <name>-db is registered', () => {
		expect(appNameDbClash('blogx-db', ['blogx', 'mailx'])).toContain('default database container')
		expect(appNameDbClash('BlogX-DB', ['blogx'])).not.toBeNull()
		expect(appNameDbClash('notes', ['notes-db'])).toContain('registered')
		expect(appNameDbClash('notes', ['blogx', 'notesdb'])).toBeNull()
	})
	it('the backup DB container must be in the app own compose project', () => {
		const bin = join(root, 'bin6')
		mkdirSync(bin, { recursive: true })
		writeFakeDocker(bin, '#!/bin/bash\necho "$PROJ"\n')
		const run = (proj: string) =>
			spawnSync('bash', ['-c', dbContainerOwnShell('shopx-db', 'shopx')], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROJ: proj } })
		expect(run('shopx').status).toBe(0)
		expect(run('').status).toBe(0)
		const bad = run('blogx')
		expect(bad.status).toBe(1)
		expect(bad.stdout).toContain('belongs to the compose project blogx')
	})
})

describe('any image of another compose project is foreign unless public', () => {
	const d = (name: string, project: string, image: string) => ({ name, project, image, imageId: `id:${name}`, ports: [] })
	const pin = `@sha256:${'a'.repeat(64)}`
	const input: ComposeCheckInput = {
		resolved: {},
		raw: null,
		hash: 'x',
		containers: [],
		details: [
			d('blogx-jobs', 'blogx', 'acme/jobs:latest'),
			d('blogx-db', 'blogx', `pgvector/pgvector:pg16${pin}`),
			d('mailx-db', 'mailx', 'pgvector/pgvector:pg17'),
			d('blogx-cron', 'blogx', 'alpine:3.21'),
			d('mailx-cron', 'mailx', 'alpine:3.20'),
			d('postgres', 'powder', 'pgvector/pgvector:pg16'),
			d('notesx-redis', 'notesx', 'redis:7'),
		],
		imageProjects: {},
	}
	const c = deployGuardContext(input, { appName: 'shopx', workingDir: '/opt/apps/shopx', composeFiles: ['/opt/apps/shopx/docker-compose.yml'], serverId: 'b', routeHosts: null, otherApps: ['blogx', 'mailx', 'notesx'] })
	it('a sidecar local build under a name that is no app is foreign; public images are not', () => {
		expect(c.foreignBuiltImages).toContain('acme/jobs:latest')
		expect(c.foreignBuiltImages).not.toContain(`pgvector/pgvector:pg16${pin}`)
		expect(c.foreignBuiltImages).not.toContain('pgvector/pgvector:pg17')
		expect(c.foreignBuiltImages).not.toContain('alpine:3.21')
		expect(c.foreignBuiltImages).not.toContain('pgvector/pgvector:pg16')
		const svc = (image: string) => ({ name: 'shopx', services: { shopx: { image } } })
		expect(codes(svc('acme/jobs:2'), c)).toContain('image')
		expect(codes(svc(`pgvector/pgvector:pg16${pin}`), c)).toEqual([])
		expect(codes(svc('alpine:3.21'), c)).toEqual([])
	})
	it('residual: a library image only one other project runs counts as that project build', () => {
		expect(c.foreignBuiltImages).toContain('redis:7')
	})
})

describe('the manual dump check uses the pinned postgres image', () => {
	it('buildDownloadCommands', () => {
		const t = buildDownloadCommands({ url: 'https://s3.example.invalid/x', s3Key: 'a/b.sql.gz.enc', containerName: 'shopx', sha256: null, dbUser: 'app', dbContainer: 'shopx-db', newDb: 'app_r' })
		expect(t).toContain(postgresToolImage())
		expect(t).not.toMatch(/ro postgres:17-alpine$/m)
	})
})
