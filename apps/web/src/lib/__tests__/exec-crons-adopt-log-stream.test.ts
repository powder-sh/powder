import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Exec crons need an admin browser session; the adopt flows refuse powder's
// names and project; the log stream masks whole lines; raw error text is
// masked; an unreadable env restore marker fails closed. Invented names.

let run: { stdout: string; code: number; stderr: string } = { stdout: '', code: 0, stderr: '' }
vi.mock('../ssh/connection', () => ({ runCommand: async () => run, withConnection: async () => undefined }))
vi.mock('../ssh/discovery', () => ({ inspectContainer: async () => ({}) }))
vi.mock('../ssh-host-keys', () => ({ explainSshError: (_h: string, e: Error) => e }))

import { adoptContainerProblem } from '../app-names'
import { execCronDenied } from '../cron-exec-gate'
import { lineRedactor } from '../log-line-redact'
import { readEnvRestoreMarker } from '../ssh/files'

const API = join(__dirname, '../../app/api')
const src = (p: string) => readFileSync(join(API, p), 'utf8')
const admin = { isAdmin: true }
const token = { isAdmin: true, viaToken: true }

describe('exec crons need an admin browser session', () => {
	it('execCronDenied: exec from a token is 403; http from a token and exec from a session pass', () => {
		expect(execCronDenied('exec', token)?.status).toBe(403)
		expect(execCronDenied('exec', { isAdmin: false })?.status).toBe(403)
		expect(execCronDenied('http', token)).toBeNull()
		expect(execCronDenied('exec', admin)).toBeNull()
	})
	it('create, import, PATCH (edit and resume) and run-now call the gate', () => {
		const c = 'servers/[id]/containers/[name]/crons/'
		// the gate moved into the session-only registry (cronSessionOnlyDenied)
		expect(src(`${c}route.ts`)).toMatch(/cronSessionOnlyDenied\(parsed\.job, user\)[\s\S]*insertCronJob\(/)
		expect(src(`${c}import/route.ts`)).toMatch(/cronSessionOnlyDenied\(parsed\.job, user\)[\s\S]*insertCronJob\(/)
		const patch = src(`${c}[cronId]/route.ts`)
		expect(patch).toMatch(/if \(body\.enabled\) \{\s*const denied = cronSessionOnlyDenied\(job, access\.user\)/)
		expect(patch).toMatch(/cronSessionOnlyDenied\(parsed\.job, access\.user\)[\s\S]*\.update\(cronJobs\)/)
		expect(src(`${c}[cronId]/run/route.ts`)).toMatch(/cronSessionOnlyDenied\(job, access\.user\)[\s\S]*runJobNow/)
	})
})

describe('adopt flows', () => {
	it('refuses reserved names, powder containers and powder compose projects', () => {
		const env = { POWDER_SELF_CONTAINER: 'hqdeploy' }
		expect(adoptContainerProblem('traefik', 'traefik', env)).toContain('reserved')
		expect(adoptContainerProblem('pv-quillbox-x', 'pv-quillbox-x', env)).not.toBeNull()
		expect(adoptContainerProblem('hqdeploy-worker', 'hqdeploy', env)).toContain("powder's own container")
		expect(adoptContainerProblem('sidecar', 'hqdeploy', env)).toContain("powder's own compose project")
		expect(adoptContainerProblem('sidecar', 'powder', env)).toContain("powder's own compose project")
		expect(adoptContainerProblem('quillbox', 'quillbox', env)).toBeNull()
		expect(adoptContainerProblem('quillbox', null, env)).toBeNull()
	})
	it('repo connect and repo import call it before anything is stored', () => {
		for (const r of ['servers/[id]/containers/[name]/repo/route.ts', 'servers/[id]/containers/[name]/repo/import/route.ts'])
			expect(src(r), r).toMatch(/adoptContainerProblem\(name, detail\.compose\.project\)[\s\S]*createRepo\(/)
	})
})

describe('the log stream masks whole lines', () => {
	const SECRET = 'API_TOKEN=s3cr3tvalue1234567890'
	it('a secret split over two chunks is masked', () => {
		const out: string[] = []
		const l = lineRedactor((t) => out.push(t))
		l.push('hello\nAPI_TO')
		l.push('KEN=s3cr3tval')
		l.push('ue1234567890\nbye')
		expect(out).toEqual(['hello\n', 'API_TOKEN=[redacted]\n'])
		l.flush()
		const all = out.join('')
		expect(all).not.toContain('s3cr3t')
		expect(all).toContain('[redacted]')
		expect(all.endsWith('bye')).toBe(true)
		expect(out[0]).toBe('hello\n')
	})
	it('the tail without a newline waits for flush; a long tail is flushed masked', () => {
		const out: string[] = []
		const l = lineRedactor((t) => out.push(t), 64)
		l.push(SECRET)
		expect(out).toEqual([])
		l.flush()
		expect(out.join('')).not.toContain('s3cr3t')
		const out2: string[] = []
		const l2 = lineRedactor((t) => out2.push(t), 16)
		l2.push(SECRET)
		expect(out2.length).toBe(1)
		expect(out2[0]).not.toContain('s3cr3t')
	})
	it('a secret straddling the overflow cut is never emitted as an unmasked half', () => {
		const out: string[] = []
		const l = lineRedactor((t) => out.push(t), 64)
		l.push(`${'x'.repeat(60)} API_TOKEN=`)
		l.push('s3cr3tvalue1234567890')
		l.push('more\nnext line\n')
		l.flush()
		const all = out.join('')
		expect(all).not.toContain('s3cr3t')
		expect(all).toContain('\nnext line\n')
	})
	it('a PEM key block is held back until its END line', () => {
		const out: string[] = []
		const l = lineRedactor((t) => out.push(t))
		l.push('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n')
		expect(out).toEqual([])
		l.push('AASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\nnext\n')
		expect(out.join('')).not.toContain('MIIEvQ')
		expect(out.join('')).toContain('next')
	})
	it('the route pushes chunks through it and masks error text', () => {
		const r = src('servers/[id]/containers/[name]/logs/stream/route.ts')
		expect(r).toContain('onData: (chunk) => lines.push(chunk)')
		expect(r).toContain("send('error', redactSecrets(err.message))")
		expect(r).toMatch(/onClose: \(\) => \{\s*lines\.flush\(\)/)
		expect(r).not.toMatch(/send\('log', chunk\)/)
	})
})

describe('raw error text is masked', () => {
	it('env-file GET / PUT and the crons list and import', () => {
		const e = src('servers/[id]/containers/[name]/env-file/route.ts')
		// PUT redacts inline; GET answers through containerReadError, which redacts too.
		expect(e.match(/redactSecrets\(clientErrorMessage\(err, 'unknown error', '[^']+'\)\)/g)?.length).toBe(1)
		expect(e).toContain('return containerReadError(err)')
		expect(e).not.toMatch(/\{ error: err instanceof Error \? err\.message/)
		expect(src('servers/[id]/containers/[name]/crons/route.ts')).toContain("hostError = redactSecrets(clientErrorMessage(err, 'crontab read failed', 'servers/:id/containers/:name/crons'))")
		expect(src('servers/[id]/containers/[name]/crons/import/route.ts')).toContain("redactSecrets(clientErrorMessage(err, 'crontab read failed', 'servers/:id/containers/:name/crons/import'))")
	})
})

describe('readEnvRestoreMarker fails closed', () => {
	const sha = 'a'.repeat(64)
	it("a failed read is 'unreadable', never null", async () => {
		run = { stdout: '', code: 1, stderr: 'boom' }
		expect(await readEnvRestoreMarker({} as never, '/opt/apps/quillbox.env')).toBe('unreadable')
		run = { stdout: 'not-a-sha', code: 0, stderr: '' }
		expect(await readEnvRestoreMarker({} as never, '/opt/apps/quillbox.env')).toBe('unreadable')
		run = { stdout: `${sha}\n`, code: 0, stderr: '' }
		expect(await readEnvRestoreMarker({} as never, '/opt/apps/quillbox.env')).toBe(sha)
		run = { stdout: '', code: 0, stderr: '' }
		expect(await readEnvRestoreMarker({} as never, '/opt/apps/quillbox.env')).toBeNull()
	})
})
