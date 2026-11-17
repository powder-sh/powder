import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
	backupScriptPath,
	backupScriptPattern,
	buildBackupScript,
	buildKillCommand,
	buildPollCommand,
	splitPollOutput,
} from '../backup-script'
import {
	buildRestoreKillCommand,
	buildRestorePollCommand,
	buildRestoreScript,
	restoreScriptPath,
	restoreScriptPattern,
	splitRestorePoll,
} from '../backup-restore-logic'

// The poll and kill of a detached backup / restore find the script by its path.
// The path is random (backupScriptPath / restoreScriptPath), so the pgrep
// pattern comes from the same module and must match exactly that shape: a
// pattern for a fixed name would never match, so live backups would be reaped and
// restores marked failed.

const hasPgrep = spawnSync('sh', ['-c', 'command -v pgrep']).status === 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('script path and pgrep pattern come from one module', () => {
	it('the backup pattern matches the generated path, not a fixed name or itself', () => {
		const id = 'bkp_abc123'
		const re = new RegExp(backupScriptPattern(id))
		for (let i = 0; i < 20; i++) expect(backupScriptPath(id)).toMatch(re)
		expect(`bash ${backupScriptPath(id)} /var/lib/powder/backups/x`).toMatch(re)
		expect('/tmp/powder-backup-bkp_abc123.sh').not.toMatch(re)
		expect(backupScriptPath('bkp_abc1234')).not.toMatch(re)
		expect(backupScriptPattern(id)).not.toMatch(re)
	})
	it('the restore pattern matches the generated path, not a fixed name or itself', () => {
		const id = 'brs_abc123'
		const re = new RegExp(restoreScriptPattern(id))
		for (let i = 0; i < 20; i++) expect(restoreScriptPath(id)).toMatch(re)
		expect('/tmp/powder-restore-brs_abc123.sh').not.toMatch(re)
		expect(restoreScriptPath('brs_abc1234')).not.toMatch(re)
		expect(restoreScriptPattern(id)).not.toMatch(re)
	})
	it('regex characters in an id are literal', () => {
		expect(backupScriptPath('a.b')).toMatch(new RegExp(backupScriptPattern('a.b')))
		expect(backupScriptPath('aXb')).not.toMatch(new RegExp(backupScriptPattern('a.b')))
	})
})

describe('scripts delete their own file first', () => {
	const base = { dumpCmd: 'true', preLines: [], passB64: '', urlsB64: '', uploadId: 'u', maxParts: 1 }
	it('the backup and restore scripts start with the self-delete line', () => {
		expect(buildBackupScript(base).split('\n')[0]).toBe('case "$0" in /tmp/powder-backup-*.tmp.*.sh) rm -f -- "$0";; esac')
		const r = buildRestoreScript({
			id: 'r1',
			mode: 'verify',
			db: { container: 'app-db', user: 'app', liveDb: 'app', withPassword: false },
			target: 'app_restore_20261112_1000_verify',
			passB64: '',
			urlB64: Buffer.from('https://s3/x').toString('base64'),
			sha256: null,
			preLines: [],
			statusFile: '/var/lib/powder/restores/s',
			lockFile: '/var/lib/powder/restores/l',
			objectSize: null,
		})
		expect(r.split('\n')[0]).toBe('case "$0" in /tmp/powder-restore-*.sh) rm -f -- "$0";; esac')
	})
})

describe.skipIf(!hasPgrep)('poll and kill find a process started at the real path', () => {
	const started: string[] = []
	afterEach(() => {
		for (const p of started.splice(0)) rmSync(p, { force: true })
	})
	// The first line deletes the file (as in the real scripts); the rest keeps running.
	const startAt = (path: string, firstLine: string) => {
		started.push(path)
		writeFileSync(path, `${firstLine}\nsleep 20\n`, { mode: 0o700 })
		return spawn('bash', [path, '/nonexistent'], { stdio: 'ignore', detached: true })
	}

	it('backup: ALIVE while running, the file is already gone, kill ends it', async () => {
		const id = `bkp_t${Math.random().toString(36).slice(2)}`
		const path = backupScriptPath(id)
		const child = startAt(path, buildBackupScript({ dumpCmd: 'true', preLines: [], passB64: '', urlsB64: '', uploadId: 'u', maxParts: 1 }).split('\n')[0] as string)
		try {
			await sleep(300)
			expect(existsSync(path)).toBe(false)
			const poll = () => splitPollOutput(execFileSync('bash', ['-c', buildPollCommand(id, '/nonexistent')]).toString())
			expect(poll().alive).toBe(true)
			execFileSync('bash', ['-c', buildKillCommand(id)])
			await sleep(300)
			expect(poll().alive).toBe(false)
		} finally {
			child.kill('SIGKILL')
		}
	})

	it('restore: ALIVE while running, the file is already gone, kill ends it', async () => {
		const id = `brs_t${Math.random().toString(36).slice(2)}`
		const path = restoreScriptPath(id)
		const child = startAt(path, 'case "$0" in /tmp/powder-restore-*.sh) rm -f -- "$0";; esac')
		try {
			await sleep(300)
			expect(existsSync(path)).toBe(false)
			const poll = () => splitRestorePoll(execFileSync('bash', ['-c', buildRestorePollCommand(id)]).toString())
			expect(poll().alive).toBe(true)
			execFileSync('bash', ['-c', buildRestoreKillCommand(id)])
			await sleep(300)
			expect(poll().alive).toBe(false)
		} finally {
			child.kill('SIGKILL')
		}
	})

	it('the kill also removes a script file of the id still in /tmp', () => {
		const id = `bkp_t${Math.random().toString(36).slice(2)}`
		const b = backupScriptPath(id)
		const rid = `brs_t${Math.random().toString(36).slice(2)}`
		const r = restoreScriptPath(rid)
		started.push(b, r)
		writeFileSync(b, 'x')
		writeFileSync(r, 'x')
		execFileSync('bash', ['-c', buildKillCommand(id)])
		execFileSync('bash', ['-c', buildRestoreKillCommand(rid)])
		expect(existsSync(b)).toBe(false)
		expect(existsSync(r)).toBe(false)
	})
})
