// restore status, log and lock files live under a root-only dir, not at
// predictable /var/tmp names; the poll still reads a pre-upgrade /var/tmp status
// only when root owns it and it is no symlink.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	RESTORE_STATE_DIR,
	buildRestorePollCommand,
	restoreCleanupCommand,
	restoreLockFile,
	restoreLogFile,
	restoreStateDirShell,
	restoreStatusFile,
} from '../backup-restore-logic'

describe('restore state dir', () => {
	it('status, log and lock are under the root-only dir', () => {
		expect(RESTORE_STATE_DIR).toBe('/var/lib/powder/restores')
		for (const f of [restoreStatusFile('r1'), restoreLogFile('r1'), restoreLockFile('shop')])
			expect(f.startsWith(`${RESTORE_STATE_DIR}/`)).toBe(true)
	})
	it('the dir is made 0700 and a symlinked dir is refused', () => {
		const root = mkdtempSync(join(tmpdir(), 'rs-'))
		const d = join(root, 'restores')
		const ok = spawnSync('bash', ['-c', `set -e\n${restoreStateDirShell(d)}\necho made`], {
			encoding: 'utf8',
		})
		expect(ok.stdout).toContain('made')
		expect(statSync(d).mode & 0o777).toBe(0o700)
		const l = join(root, 'linked')
		symlinkSync(root, l)
		const bad = spawnSync('bash', ['-c', `${restoreStateDirShell(l)}\necho made`], {
			encoding: 'utf8',
		})
		expect(bad.status).toBe(1)
		expect(bad.stdout).toContain('is a symlink, refusing')
	})
	it('poll reads the new paths first, the /var/tmp ones only root-owned', () => {
		const s = buildRestorePollCommand('r1')
		expect(s).toContain(`if [ -f '${RESTORE_STATE_DIR}/powder-restore-r1.status' ]`)
		expect(s).toContain(
			`[ ! -L '/var/tmp/powder-restore-r1.status' ] && [ "$(stat -c %u '/var/tmp/powder-restore-r1.status' 2>/dev/null)" = 0 ]`,
		)
		expect(restoreCleanupCommand('r1')).toContain('/var/tmp/powder-restore-r1.log')
		expect(restoreCleanupCommand('r1')).toContain(`${RESTORE_STATE_DIR}/powder-restore-r1.status`)
	})
})
