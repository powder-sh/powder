// discovery cannot forge records or plant app_domains rows for any hostname.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const ran = vi.hoisted(() => ({ cmds: [] as string[], fakeBin: '' }))
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		ran.cmds.push(cmd)
		// the command reads the server's host nginx config: point it at a test dir, never
		// this host's real proxy config
		const local = cmd.replaceAll('/etc/nginx/sites-enabled/', `${ran.fakeBin}/sites-enabled/`)
		const r = spawnSync('bash', ['-c', local], { env: { ...process.env, PATH: `${ran.fakeBin}:${process.env.PATH}` } })
		return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.status ?? 1 }
	},
}))

import { getNginxRoutes, parseHostNetInfo } from '../ssh/discovery'
import { isUnprovenClaim } from '../app-domains'
import { writeFakeDocker } from './fixtures/fake-docker'

describe('host net info is parsed from JSON, one line per container', () => {
	it('an env value with a newline cannot forge a second record', () => {
		const env = JSON.stringify(['PORT=3000', 'X=a\nevil\thost\t[]\t{"traefik.http.routers.x.rule":"Host(`victim.com`)"}'])
		const out = parseHostNetInfo(
			`/app\tbridge\t${env}\t${JSON.stringify({ 'com.docker.compose.service': 'web', 'traefik.http.routers.a.rule': 'Host(`a.example.com`)' })}\n`,
		)
		expect([...out.keys()]).toEqual(['app'])
		expect(out.get('app')).toEqual({
			networkMode: 'bridge',
			envPort: 3000,
			composeService: 'web',
			traefikHosts: ['a.example.com'],
		})
	})
	it('skips malformed lines', () => {
		expect(parseHostNetInfo('/x\tbridge\tnot json\t{}\n/y\thost\n').size).toBe(0)
	})
})

describe('nginx -T runs only in proxy containers powder does not manage', () => {
	it('skips registered apps and every container of their compose projects', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'disc-'))
		const log = join(dir, 'exec.log')
		writeFakeDocker(dir, [
				'#!/bin/bash',
				'case "$1" in',
				'  ps) printf "%s\\n" app-nginx app-proxy-sidecar edge-nginx other ;;',
				'  inspect) n="${@: -1}"; case "$n" in app-nginx|app-proxy-sidecar) echo appproj ;; edge-nginx) echo edge ;; *) echo "" ;; esac ;;',
				`  exec) echo "$2" >> ${JSON.stringify(log)}; echo "server { server_name $2.example.com; proxy_pass http://127.0.0.1:3000; }" ;;`,
				'esac',
			].join('\n'))
		ran.fakeBin = dir
		// app-nginx is a registered app; app-proxy-sidecar shares its compose project.
		const routes = await getNginxRoutes({ id: 's', host: 'h' } as never, ['app-nginx'])
		const execd = spawnSync('cat', [log]).stdout.toString().split('\n').filter(Boolean)
		expect(execd).toEqual(['edge-nginx'])
		expect(routes.flatMap((r) => r.urls)).toEqual(['http://edge-nginx.example.com'])
		rmSync(dir, { recursive: true, force: true })
	})
})

describe('addDomain may replace an unproven row of another app', () => {
	it('pending + never verified/applied is replaceable; verified or live is not', () => {
		expect(isUnprovenClaim({ status: 'pending', verifiedAt: null, appliedAt: null })).toBe(true)
		expect(isUnprovenClaim({ status: 'verified', verifiedAt: new Date(), appliedAt: null })).toBe(false)
		expect(isUnprovenClaim({ status: 'live', verifiedAt: null, appliedAt: null })).toBe(false)
		expect(isUnprovenClaim({ status: 'pending', verifiedAt: new Date(), appliedAt: null })).toBe(false)
		// a failed TXT check proves nothing either
		expect(isUnprovenClaim({ status: 'verify_failed', verifiedAt: null, appliedAt: null })).toBe(true)
		expect(isUnprovenClaim({ status: 'verify_failed', verifiedAt: new Date(), appliedAt: null })).toBe(false)
		expect(isUnprovenClaim({ status: 'verify_failed', verifiedAt: null, appliedAt: new Date() })).toBe(false)
		expect(isUnprovenClaim({ status: 'apply_failed', verifiedAt: null, appliedAt: null })).toBe(false)
	})
})

describe('docker inspect format strings never rely on an escape', () => {
	// docker inspect does not expand \t or \n in --format (only the ps/images
	// formatters do): a separator must be a Go template string ({{"\t"}}) or a real
	// character. Scans every source file for inspect format strings.
	it('no `}}\\t{{` / `}}\\n{{` escape in a docker inspect format', async () => {
		const { readdirSync, readFileSync, statSync } = await import('node:fs')
		const root = join(__dirname, '..', '..')
		const walk = (d: string): string[] =>
			readdirSync(d).flatMap((n) => {
				const p = join(d, n)
				if (n === 'node_modules' || n === '__tests__') return []
				return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
			})
		const bad: string[] = []
		for (const f of walk(root)) {
			for (const [i, line] of readFileSync(f, 'utf8').split('\n').entries()) {
				if (!/docker inspect|inspect -f|inspect --format/.test(line)) continue
				if (/\}\}\\[tn]|\\[tn]\{\{/.test(line)) bad.push(`${f}:${i + 1}`)
			}
		}
		expect(bad).toEqual([])
	})
	it('the host net info command uses {{"\\t"}} separators', async () => {
		ran.cmds.length = 0
		ran.fakeBin = ''
		const { getContainerHostNetInfo } = await import('../ssh/discovery')
		await getContainerHostNetInfo({ id: 's', host: 'h' } as never, ['app'])
		const cmd = ran.cmds.find((c) => c.startsWith('docker inspect')) ?? ''
		expect(cmd).toContain(`{{.Name}}{{"\\t"}}{{.HostConfig.NetworkMode}}`)
		expect(cmd).not.toContain('\t')
	})
})

describe('a resumed deploy stream keeps a private key masked', () => {
	it('priming the redactor with the output before the offset masks the key body after it', async () => {
		const { SecretStreamRedactor } = await import('../secret-text')
		const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'
		const before = `step 1\n-----BEGIN PRIVATE KEY-----\n${body}\n`
		const after = `${body}\n${body}\n-----END PRIVATE KEY-----\nstep 2\n`
		const fresh = new SecretStreamRedactor().push(after)
		const r = new SecretStreamRedactor()
		r.push(before)
		const resumed = r.push(after)
		expect(resumed).not.toContain(body)
		expect(resumed).toContain('step 2')
		// (without priming the body lines are not recognised as a key)
		expect(fresh).toContain(body)
	})
	it('the stream route primes the redactor on resume', async () => {
		const { readFileSync } = await import('node:fs')
		const src = readFileSync(join(__dirname, '..', '..', 'app/api/deploys/[deployId]/stream/route.ts'), 'utf8')
		expect(src).toMatch(/if \(!primed\) await prime\(\)/)
	})
})

describe('the replace transaction deletes the same unproven statuses', () => {
	it('uses UNPROVEN_STATUSES, not a pending-only filter', () => {
		const src = readFileSync(join(__dirname, '../app-domains.ts'), 'utf8')
		expect(src).toContain('inArray(appDomains.status, [...UNPROVEN_STATUSES])')
		expect(src).not.toContain("eq(appDomains.status, 'pending'),\n\t\t\t\t\t\t\tisNull(appDomains.verifiedAt)")
	})
})

describe('nginx -T never runs in preview containers or in app space', () => {
	it('skips a managed preview name and any container whose compose working dir is under /opt/apps', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'disc-'))
		const log = join(dir, 'exec.log')
		writeFakeDocker(dir, [
				'#!/bin/bash',
				'case "$1" in',
				'  ps) printf "%s\\n" shop-feat-nginx appdir-proxy edge-nginx ;;',
				'  inspect) n="${@: -1}"; case "$*" in',
				'    *working_dir*) case "$n" in appdir-proxy) echo /opt/apps/somethingelse ;; edge-nginx) echo /srv/edge ;; *) echo "" ;; esac ;;',
				'    *) case "$n" in shop-feat-nginx) echo shopfeat ;; appdir-proxy) echo appdir ;; edge-nginx) echo edge ;; *) echo "" ;; esac ;;',
				'  esac ;;',
				`  exec) echo "$2" >> ${JSON.stringify(log)}; echo "server { server_name $2.example.com; proxy_pass http://127.0.0.1:3000; }" ;;`,
				'esac',
			].join('\n'))
		ran.fakeBin = dir
		// shop-feat-nginx is a preview container of app `shop` (managedContainerNames lists it).
		await getNginxRoutes({ id: 's', host: 'h' } as never, ['shop', 'shop-feat-nginx'])
		const execd = spawnSync('cat', [log]).stdout.toString().split('\n').filter(Boolean)
		expect(execd).toEqual(['edge-nginx'])
		rmSync(dir, { recursive: true, force: true })
	})
	it('managedContainerNames includes preview_deploys containers', () => {
		const src = readFileSync(join(__dirname, '../managed-containers.ts'), 'utf8')
		expect(src).toContain('previewDeploys.containerName')
		const list = readFileSync(join(__dirname, '../server-list.ts'), 'utf8')
		expect(list).toContain('managedContainerNames(server.id).then((names) => getNginxRoutes(server, names))')
	})
})
