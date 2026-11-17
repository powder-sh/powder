import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	backupObjectKey,
	canDeleteObject,
	failureBackoffMs,
	landedObjectMatches,
	isBackupDue,
	isConnectFailure,
	newestLooksShrunk,
	parseStatusFile,
	planRetention,
} from '../backup-logic'
import {
	backupCleanupCommand,
	backupScriptPath,
	buildBackupFireCommand,
	buildBackupScript,
	buildPollCommand,
	varTmpStatusFile,
	splitPollOutput,
} from '../backup-script'
import { redactSecrets, safeSlice } from '../secret-text'

const H = 60 * 60 * 1000
const SHA = 'a'.repeat(64)

describe('parseStatusFile', () => {
	it('parses a pending-complete status with sha256 + parts', () => {
		const p = parseStatusFile(
			`status=uploaded_pending_complete\nsize=123\nsha256=${SHA}\nupload_id=u1\nparts=1:e1,2:e2\nfinished_at=2026-09-24T10:00:00Z\n`,
		)
		expect(p.status).toBe('uploaded_pending_complete')
		expect(p.size).toBe(123)
		expect(p.sha256).toBe(SHA)
		expect(p.parts).toEqual([
			{ part: 1, etag: 'e1' },
			{ part: 2, etag: 'e2' },
		])
		expect(p.finishedAt?.toISOString()).toBe('2026-09-24T10:00:00.000Z')
	})
	it('drops a malformed sha256 rather than storing garbage', () => {
		expect(parseStatusFile('status=success\nsha256=nothex\n').sha256).toBeUndefined()
		expect(parseStatusFile('status=success\nsha256=\n').sha256).toBeUndefined()
	})
})

describe('backoff', () => {
	it('doubles per consecutive failure, capped at 24h', () => {
		expect(failureBackoffMs(0)).toBe(0)
		expect(failureBackoffMs(1)).toBe(1 * H)
		expect(failureBackoffMs(2)).toBe(2 * H)
		expect(failureBackoffMs(5)).toBe(16 * H)
		expect(failureBackoffMs(6)).toBe(24 * H)
		expect(failureBackoffMs(40)).toBe(24 * H)
	})
	it('isBackupDue honours in-flight, success interval and failure backoff', () => {
		const now = Date.now()
		const at = (hAgo: number) => new Date(now - hAgo * H)
		expect(isBackupDue([], now)).toBe(true)
		expect(isBackupDue([{ status: 'running', startedAt: at(30) }], now)).toBe(false)
		expect(isBackupDue([{ status: 'uploaded_pending_complete', startedAt: at(30) }], now)).toBe(false)
		expect(isBackupDue([{ status: 'success', startedAt: at(22) }], now)).toBe(false)
		expect(isBackupDue([{ status: 'success', startedAt: at(23.1) }], now)).toBe(true)
		// 1 failure → retry after 1h
		expect(isBackupDue([{ status: 'failed', startedAt: at(0.5) }], now)).toBe(false)
		expect(isBackupDue([{ status: 'failed', startedAt: at(1.1) }], now)).toBe(true)
		// 3 consecutive failures → 4h
		const three = [at(3), at(5), at(8)].map((d) => ({ status: 'failed', startedAt: d }))
		expect(isBackupDue(three, now)).toBe(false)
		three[0] = { status: 'failed', startedAt: at(4.1) }
		expect(isBackupDue(three, now)).toBe(true)
		// a success breaks the failure streak
		expect(
			isBackupDue(
				[
					{ status: 'failed', startedAt: at(1.1) },
					{ status: 'success', startedAt: at(25) },
					{ status: 'failed', startedAt: at(26) },
				],
				now,
			),
		).toBe(true)
	})
})

describe('connect failures do not grow the backoff', () => {
	const now = Date.now()
	const at = (hAgo: number) => new Date(now - hAgo * H)
	// Stored exactly as runBackupForApp's catch writes app_backups.error.
	const stored = (msg: string) => safeSlice(redactSecrets(msg), 0, 1000)
	const handshake = stored('Timed out while waiting for handshake')
	const conn = (hAgo: number, error = handshake) => ({ status: 'failed', startedAt: at(hAgo), error })
	const dump = (hAgo: number) => ({
		status: 'failed',
		startedAt: at(hAgo),
		error: 'pg_dump: error: connection to server on socket failed',
	})

	it('classifies only never-connected failures', () => {
		for (const msg of [
			'Timed out while waiting for handshake',
			'connect ECONNREFUSED 203.0.113.2:22',
			'connect EHOSTUNREACH 203.0.113.2:22',
			'connect ENETUNREACH 203.0.113.2:22',
			'connect ETIMEDOUT 203.0.113.2:22',
			'getaddrinfo ENOTFOUND server.example.internal',
			'getaddrinfo EAI_AGAIN server.example.internal',
			// bare forms of the complete_failed negatives below
			'connect ETIMEDOUT 1.2.3.4:443',
			'getaddrinfo ENOTFOUND s3.example.com',
		]) {
			expect(isConnectFailure({ status: 'failed', error: stored(msg) }), msg).toBe(true)
		}
		for (const msg of [
			'All configured authentication methods failed',
			'SSH timeout to 203.0.113.2',
			'SFTP timeout to 203.0.113.2',
			'read ECONNRESET',
			'read ETIMEDOUT',
			'failed to fire detached backup (exit 1): boom',
			'[watchdog] script died',
			'pg_dump: error: connection to server on socket failed',
			// S3 complete failed after the dump ran (backups.ts complete_failed prefix)
			'complete_failed: connect ETIMEDOUT 1.2.3.4:443',
			'complete_failed: getaddrinfo ENOTFOUND s3.example.com',
			'complete_failed: Timed out while waiting for handshake',
		]) {
			expect(isConnectFailure({ status: 'failed', error: stored(msg) }), msg).toBe(false)
		}
		expect(isConnectFailure({ status: 'failed', error: null })).toBe(false)
		expect(isConnectFailure({ status: 'success', error: handshake })).toBe(false)
	})

	it('an 18h outage still retries hourly and is due right after the server returns', () => {
		const outage = Array.from({ length: 10 }, (_, i) => conn(1.1 + i))
		expect(isBackupDue(outage, now)).toBe(true)
		const justFailed = [conn(0.5), ...outage]
		expect(isBackupDue(justFailed, now)).toBe(false)
	})

	it('a dump failure after connect failures backs off from 1h', () => {
		const h = [dump(0.5), conn(1.5), conn(2.5), conn(3.5), conn(4.5)]
		expect(isBackupDue(h, now)).toBe(false)
		h[0] = dump(1.1)
		expect(isBackupDue(h, now)).toBe(true)
		// two real failures around connect failures → 2h
		expect(isBackupDue([dump(1.5), conn(2.5), dump(3.5)], now)).toBe(false)
		expect(isBackupDue([dump(2.1), conn(2.5), dump(3.5)], now)).toBe(true)
	})

	it('connect failures neither grow nor shorten an existing backoff', () => {
		// 3 real failures → 4h after the newest real one, even with a connect failure on top
		const h = [conn(1.5), dump(3), dump(5), dump(8)]
		expect(isBackupDue(h, now)).toBe(false)
		h[1] = dump(4.1)
		expect(isBackupDue(h, now)).toBe(true)
		// a connect failure under 1h ago still holds the hourly floor
		expect(isBackupDue([conn(0.5), dump(30), dump(31)], now)).toBe(false)
	})
})

describe('planRetention', () => {
	const row = (id: string, sizeBytes: number | null) => ({ id, sizeBytes })
	const big = (n: number, from = 0) =>
		Array.from({ length: n }, (_, i) => row(`big${from + i}`, 1_000_000 + i))
	const small = (n: number) => Array.from({ length: n }, (_, i) => row(`small${i}`, 2_000))

	it('plain keep-N when every backup is sizeable', () => {
		const p = planRetention(big(10), 7)
		expect(p.keep.map((r) => r.id)).toEqual(big(7).map((r) => r.id))
		expect(p.prune).toHaveLength(3)
		expect(p.held).toBe(0)
	})
	it('never lets tiny "successful" dumps push out the real ones — even when they outnumber them', () => {
		for (const nSmall of [1, 4, 7, 8, 20]) {
			const rows = [...small(nSmall), ...big(7)]
			const p = planRetention(rows, 7)
			const keptBig = p.keep.filter((r) => r.id.startsWith('big'))
			expect(keptBig, `nSmall=${nSmall}`).toHaveLength(7)
			// only surplus tiny ones get pruned, never a big one
			expect(p.prune.every((r) => r.id.startsWith('small'))).toBe(true)
		}
	})
	it('unknown sizes count as sizeable (rows without a size are not held forever)', () => {
		const rows = Array.from({ length: 9 }, (_, i) => row(`r${i}`, null))
		const p = planRetention(rows, 7)
		expect(p.keep).toHaveLength(7)
		expect(p.prune).toHaveLength(2)
	})
	it('keep floor is at least 1', () => {
		expect(planRetention(big(3), 0).keep).toHaveLength(1)
	})
})

describe('newestLooksShrunk', () => {
	const r = (s: number | null) => ({ id: String(s), sizeBytes: s })
	it('flags a newest dump under half its predecessors', () => {
		expect(newestLooksShrunk([r(100), r(1000), r(1000), r(1000)])).toBe(true)
		expect(newestLooksShrunk([r(900), r(1000), r(1000), r(1000)])).toBe(false)
	})
	it('needs 3+ sized predecessors', () => {
		expect(newestLooksShrunk([r(1), r(1000), r(1000)])).toBe(false)
		expect(newestLooksShrunk([r(null), r(1000), r(1000), r(1000)])).toBe(false)
	})
})

describe('splitPollOutput', () => {
	it('splits liveness from status', () => {
		expect(splitPollOutput('ALIVE\n---powder-status---\nstatus=running\n')).toEqual({
			alive: true,
			status: 'status=running',
		})
		expect(splitPollOutput('DEAD\n---powder-status---\nMISSING\n')).toEqual({
			alive: false,
			status: 'MISSING',
		})
		expect(splitPollOutput('status=running')).toEqual({ alive: null, status: 'status=running' })
	})
})

// ── The generated bash, executed for real ───────────────────────────────────
// Runs the backup script against a local fake S3 (PUT → ETag) with a stub
// dump command. The script targets Linux (GNU stat/mktemp); on macOS we put
// small shims first on PATH.

const work = mkdtempSync(join(tmpdir(), 'powder-backup-test-'))
const shimDir = join(work, 'bin')

function shim(name: string, body: string) {
	const p = join(shimDir, name)
	writeFileSync(p, `#!/bin/bash\n${body}\n`)
	chmodSync(p, 0o755)
}

let server: Server
let port = 0
const uploads = new Map<string, Buffer[]>()

beforeAll(async () => {
	execFileSync('mkdir', ['-p', shimDir])
	if (process.platform === 'darwin') {
		// GNU `stat -c %s FILE` → BSD `stat -f %z FILE`
		shim('stat', `[ -n "$FAIL_STAT" ] && exit 1\nif [ "$1" = "-c" ]; then exec /usr/bin/stat -f %z "$3"; fi\nexec /usr/bin/stat "$@"`)
		// GNU mktemp accepts a suffix after the X's; BSD doesn't.
		shim(
			'mktemp',
			`if [ "$1" = "-p" ]; then d="$2"; t="$3"; pre="\${t%%XXXXXX*}"; suf="\${t##*XXXXXX}"; f=$(/usr/bin/mktemp "$d/$pre""XXXXXX") && mv "$f" "$f$suf" && echo "$f$suf"; else exec /usr/bin/mktemp "$@"; fi`,
		)
	} else {
		shim('stat', `[ -n "$FAIL_STAT" ] && exit 1\nexec /usr/bin/stat "$@"`)
	}
	server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (c: Buffer) => chunks.push(c))
		req.on('end', () => {
			const key = req.url ?? ''
			uploads.set(key, chunks)
			res.writeHead(200, { ETag: `"etag-${key.replace(/\W/g, '')}"` })
			res.end()
		})
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	port = (server.address() as AddressInfo).port
})

afterAll(() => {
	server?.close()
})

function runScript(dumpCmd: string, env: Record<string, string> = {}) {
	const id = `t${Math.random().toString(36).slice(2)}`
	const statusFile = join(work, `${id}.status`)
	const urls = [1, 2, 3].map((i) => `http://127.0.0.1:${port}/${id}/part${i}`)
	const script = buildBackupScript({
		dumpCmd,
		preLines: [],
		passB64: Buffer.from('test-pass').toString('base64'),
		urlsB64: Buffer.from(urls.join('\n')).toString('base64'),
		uploadId: 'upload-1',
		statusFile,
		maxParts: 3,
	})
	const path = join(work, `powder-backup-${id}.sh`)
	writeFileSync(path, script)
	return new Promise<{ status: ReturnType<typeof parseStatusFile>; code: number | null; id: string }>(
		(resolve) => {
			const child = spawn('bash', [path], {
				env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, ...env },
				stdio: 'ignore',
			})
			child.on('exit', (code) =>
				resolve({
					status: parseStatusFile(existsSync(statusFile) ? readFileSync(statusFile, 'utf8') : ''),
					code,
					id,
				}),
			)
		},
	)
}

const GOOD_DUMP = `printf -- '--\\n-- PostgreSQL database dump\\n--\\nCREATE TABLE t (id int);\\n\\n--\\n-- PostgreSQL database dump complete\\n--\\n\\n\\\\unrestrict abc\\n\\n'`

describe('backup script (executed)', () => {
	it('syntax-checks under bash -n', () => {
		const script = buildBackupScript({
			dumpCmd: 'true',
			preLines: [],
			passB64: 'eA==',
			urlsB64: 'eA==',
			uploadId: "we'ird",
			statusFile: "/var/tmp/it's.status",
			maxParts: 500,
		})
		const p = join(work, 'syntax.sh')
		writeFileSync(p, script)
		execFileSync('bash', ['-n', p])
	})

	it('verifies, hashes and uploads a good dump; sha256 matches the uploaded bytes', async () => {
		const { status, code, id } = await runScript(GOOD_DUMP)
		expect(code).toBe(0)
		expect(status.status).toBe('uploaded_pending_complete')
		expect(status.parts).toHaveLength(1)
		const body = Buffer.concat(uploads.get(`/${id}/part1`) ?? [])
		expect(body.length).toBe(status.size)
		expect(status.sha256).toBe(createHash('sha256').update(body).digest('hex'))
	})

	it('refuses to upload a dump without the pg_dump trailer', async () => {
		const { status, code, id } = await runScript(`printf 'CREATE TABLE t (id int);\\n'`)
		expect(code).toBe(4)
		expect(status.status).toBe('failed')
		expect(status.error).toBe('verify_dump_incomplete_no_trailer')
		expect(uploads.has(`/${id}/part1`)).toBe(false)
	})

	it('reports a failed dump', async () => {
		const { status, code } = await runScript('false')
		expect(code).toBe(1)
		expect(status.error).toBe('dump_or_encrypt_failed')
	})

	it('ERR trap writes a terminal failure for an unexpected error (e.g. stat on a full disk)', async () => {
		const { status, code } = await runScript(GOOD_DUMP, { FAIL_STAT: '1' })
		expect(code).not.toBe(0)
		expect(status.status).toBe('failed')
		expect(status.error).toMatch(/^script_error_line_\d+_exit_\d+$/)
		expect(status.uploadId).toBe('upload-1')
	})

	it('presigned part URLs never appear in curl argv (they go through a 0600 -K config)', async () => {
		const argvDir = mkdtempSync(join(tmpdir(), 'powder-curl-argv-'))
		const argvLog = join(argvDir, 'argv.log')
		const real = execFileSync('bash', ['-c', 'command -v curl']).toString().trim()
		writeFileSync(
			join(argvDir, 'curl'),
			`#!/bin/bash\necho "$*" >> ${JSON.stringify(argvLog)}\nexec ${JSON.stringify(real)} "$@"\n`,
		)
		chmodSync(join(argvDir, 'curl'), 0o755)
		const { status, code, id } = await runScript(GOOD_DUMP, {
			PATH: `${argvDir}:${shimDir}:${process.env.PATH}`,
		})
		expect(code).toBe(0)
		expect(status.status).toBe('uploaded_pending_complete')
		// Uploaded to the right part URL, read from the config file.
		expect(uploads.has(`/${id}/part1`)).toBe(true)
		const argv = readFileSync(argvLog, 'utf8')
		expect(argv).toContain('-K')
		expect(argv).not.toContain('http://')
	})

	it('refuses a part URL curl -K cannot carry', () => {
		expect(() =>
			buildBackupScript({
				dumpCmd: 'true',
				preLines: [],
				passB64: 'eA==',
				urlsB64: Buffer.from('https://s3/x?a="b"').toString('base64'),
				uploadId: 'u',
				statusFile: '/var/tmp/s',
				maxParts: 1,
			}),
		).toThrow(/curl -K/)
	})
})

describe('poll command liveness', () => {
	it('reports ALIVE for a running script and DEAD otherwise — never matching its own shell', async () => {
		const id = `p${Math.random().toString(36).slice(2)}`
		// the status lives in the backup's mktemp dir under the state dir.
		mkdirSync(join(work, `${id}.Ab12Cd`))
		writeFileSync(join(work, `${id}.Ab12Cd`, 'status'), 'status=running\n')
		const cmd = buildPollCommand(id, work)
		// Run the poll through `bash -c` so the pattern sits in a live cmdline,
		// exactly like the real SSH exec.
		const dead = splitPollOutput(execFileSync('bash', ['-c', cmd]).toString())
		expect(dead).toEqual({ alive: false, status: 'status=running' })

		// the real path (random suffix in /tmp), as runBackupForApp writes it.
		const scriptPath = backupScriptPath(id)
		writeFileSync(scriptPath, 'sleep 5\n')
		const child = spawn('bash', [scriptPath], { stdio: 'ignore' })
		await new Promise((r) => setTimeout(r, 200))
		try {
			const alive = splitPollOutput(execFileSync('bash', ['-c', cmd]).toString())
			expect(alive.alive).toBe(true)
		} finally {
			child.kill()
			rmSync(scriptPath, { force: true })
		}
	})
})

describe('backup object keys', () => {
	const at = new Date('2026-11-05T10:00:00.123Z')
	const key = (serverId: string, backupId: string) =>
		backupObjectKey({ serverId, containerName: 'blog', backupId, at })
	it('includes server, container and backup id', () => {
		expect(key('server-1', 'bkp_1')).toBe('server-1/blog/2026-11-05T10-00-00Z-bkp_1.sql.gz.enc')
	})
	it('same container name on two servers in the same second never collides', () => {
		expect(key('server-1', 'bkp_1')).not.toBe(key('server-2', 'bkp_2'))
		expect(key('server-1', 'bkp_1')).not.toBe(key('server-1', 'bkp_3'))
	})
})

describe('landedObjectMatches (complete errored, object exists)', () => {
	it('needs the object size to equal the size the script uploaded', () => {
		expect(landedObjectMatches({ size: 100 }, 100)).toBe(true)
		expect(landedObjectMatches({ size: 99 }, 100)).toBe(false)
		expect(landedObjectMatches(null, 100)).toBe(false)
		expect(landedObjectMatches({ size: 100 }, undefined)).toBe(false)
		expect(landedObjectMatches({}, 100)).toBe(false)
	})
})

describe('canDeleteObject (prune)', () => {
	const k = 'blog/2026.sql.gz.enc'
	it('keeps an object another row still points at', () => {
		expect(canDeleteObject(k, new Set([k]))).toBe(false)
		expect(canDeleteObject(k, new Set(['other']))).toBe(true)
	})
})

describe('backup state in a mktemp dir under a root-only parent', () => {
	it('the fire command makes the dir, the script writes $1/status, the poll reads it, cleanup removes it', async () => {
		const parent = join(mkdtempSync(join(tmpdir(), 'powder-bkstate-')), 'backups')
		const id = `bkp_${Math.random().toString(36).slice(2)}`
		const script = join(work, `powder-backup-${id}-x.sh`)
		writeFileSync(script, 'STATUS_FILE="$1/status"; printf "status=success\\n" > "$STATUS_FILE"\n')
		// macOS has no setsid: a pass-through shim keeps the command itself unchanged.
		const shim = mkdtempSync(join(tmpdir(), 'powder-setsid-'))
		writeFileSync(join(shim, 'setsid'), '#!/bin/sh\nexec "$@"\n')
		chmodSync(join(shim, 'setsid'), 0o755)
		execFileSync('bash', ['-c', buildBackupFireCommand(script, id, parent)], {
			env: { ...process.env, PATH: `${process.env.PATH}:${shim}` },
		})
		await new Promise((r) => setTimeout(r, 300))
		expect((statSync(parent).mode & 0o777).toString(8)).toBe('700')
		const out = splitPollOutput(execFileSync('bash', ['-c', buildPollCommand(id, parent)]).toString())
		expect(out.status).toBe('status=success')
		execFileSync('bash', ['-c', backupCleanupCommand(id, parent)])
		expect(splitPollOutput(execFileSync('bash', ['-c', buildPollCommand(id, parent)]).toString()).status).toBe('MISSING')
	})
	it('a status file planted at the old /var/tmp name by a non-root user is not read', () => {
		const id = `bkp_${Math.random().toString(36).slice(2)}`
		const planted = varTmpStatusFile(id)
		if (process.getuid?.() === 0) return // root owns what it plants
		writeFileSync(planted, 'status=uploaded_pending_complete\nparts=1:x\n')
		try {
			const out = splitPollOutput(
				execFileSync('bash', ['-c', buildPollCommand(id, mkdtempSync(join(tmpdir(), 'powder-bkstate-')))]).toString(),
			)
			expect(out.status).toBe('MISSING')
		} finally {
			rmSync(planted, { force: true })
		}
	})
	it('the production script takes its state dir as $1 and refuses without one', () => {
		const s = buildBackupScript({ dumpCmd: 'true', preLines: [], passB64: '', urlsB64: '', uploadId: 'u', maxParts: 1 })
		expect(s).toContain('STATUS_FILE="$1/status"')
		expect(s).not.toContain('/var/tmp/powder-backup-')
	})
})

