// the backup and restore scripts arm their EXIT cleanup before the
// first mktemp / write, so a failure there (mktemp on a full disk, a failing
// PGPASSWORD write) never leaves the passphrase file behind.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRestoreScript, restoreDbName } from '../backup-restore-logic'
import { buildBackupScript } from '../backup-script'

const PASS = 'sekrit-passphrase-xyz'

/** Run `script` with a mktemp stub that creates files in a private dir, logs them,
 *  and fails on call number `failAt` (0 = never). Returns the files still on disk. */
function runWithMktemp(script: string, failAt: number) {
	const dir = mkdtempSync(join(tmpdir(), 'powder-tmp-'))
	const files = join(dir, 'files')
	const made = join(dir, 'made.log')
	const count = join(dir, 'count')
	writeFileSync(
		join(dir, 'mktemp'),
		[
			'#!/bin/bash',
			`n=$(( $(cat '${count}' 2>/dev/null || echo 0) + 1 )); echo $n > '${count}'`,
			`[ "$n" = "${failAt}" ] && { echo "mktemp: No space left on device" >&2; exit 1; }`,
			`mkdir -p '${files}'; f='${files}'/t.$n.$RANDOM; : > "$f"; echo "$f" >> '${made}'; echo "$f"`,
		].join('\n'),
	)
	chmodSync(join(dir, 'mktemp'), 0o755)
	writeFileSync(join(dir, 'flock'), '#!/bin/bash\nexit 0\n')
	chmodSync(join(dir, 'flock'), 0o755)
	const r = spawnSync('bash', ['-c', script], {
		encoding: 'utf8',
		timeout: 120_000,
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
	})
	const list = existsSync(made) ? readFileSync(made, 'utf8').split('\n').filter(Boolean) : []
	const left = list.filter((f) => existsSync(f))
	const withPass = left.filter((f) => readFileSync(f, 'utf8').includes(PASS))
	return { r, made: list, left, withPass, dir }
}

const restore = (preLines: string[], statusFile: string) =>
	buildRestoreScript({
		id: 'rst_t',
		mode: 'restore',
		db: { container: 'shop-db', user: 'app', liveDb: 'app', withPassword: false },
		target: restoreDbName('app', new Date('2026-11-04T09:07:00Z')),
		passB64: Buffer.from(PASS).toString('base64'),
		urlB64: Buffer.from('https://x').toString('base64'),
		sha256: null,
		preLines,
		statusFile,
		lockFile: join(tmpdir(), 'powder-lock'),
	})

const backup = (preLines: string[], statusFile: string) =>
	buildBackupScript({
		dumpCmd: 'true',
		preLines,
		passB64: Buffer.from(PASS).toString('base64'),
		urlsB64: Buffer.from('https://x/1').toString('base64'),
		uploadId: 'u1',
		statusFile,
		maxParts: 1,
	})

describe('no temp file survives an early failure', () => {
	for (const [name, build] of [
		['restore', restore],
		['backup', backup],
	] as const) {
		it(`${name}: a failing write after the passphrase (pre-lines) removes every temp file`, () => {
			const sf = join(mkdtempSync(join(tmpdir(), 'powder-sf-')), 'status')
			const res = runWithMktemp(build(['false'], sf), 0)
			expect(res.r.status).not.toBe(0)
			expect(res.made.length).toBeGreaterThan(0)
			expect(res.withPass).toEqual([])
			expect(res.left).toEqual([])
		})
		it(`${name}: a mktemp failing midway removes the files made before it`, () => {
			const sf = join(mkdtempSync(join(tmpdir(), 'powder-sf-')), 'status')
			const res = runWithMktemp(build([], sf), 2)
			expect(res.r.status).not.toBe(0)
			expect(res.made.length).toBe(1)
			expect(res.left).toEqual([])
		})
	}
})
