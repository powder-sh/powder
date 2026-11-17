// the restore script writes TABLES / SIZE (psql output from the restored dump's
// database) into the status file; only digits may reach it.
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildRestoreScript } from '../backup-restore-logic'

const script = buildRestoreScript({
	id: 'rst_1',
	mode: 'restore',
	db: { container: 'shop-db', user: 'app', liveDb: 'app', withPassword: false },
	target: 'app_restore_20261104_0907',
	passB64: 'cGFzcw==',
	urlB64: 'dXJs',
	sha256: null,
	preLines: [],
	statusFile: '/var/tmp/s',
	lockFile: '/var/tmp/l',
} as never)

const lines = script.split('\n')
const filter = lines.filter((l) => /^case "\$(TABLES|SIZE)" in/.test(l)).join('\n')

describe('restore status: digits only', () => {
	it('the filter sits between the psql reads and the status write', () => {
		const at = (re: RegExp) => lines.findIndex((l) => re.test(l))
		expect(filter.split('\n')).toHaveLength(2)
		expect(at(/^case "\$SIZE"/)).toBeGreaterThan(at(/^SIZE=\$\(/))
		expect(at(/^case "\$TABLES"/)).toBeGreaterThan(at(/^TABLES=\$\(/))
		expect(at(/status=success/)).toBeGreaterThan(at(/^case "\$SIZE"/))
	})
	it.each([
		['12', '8192', '12|8192'],
		['12\nstatus=failed', '1x', '|'],
		[' 3', '', '|'],
	])('TABLES=%j SIZE=%j -> %s', (t, s, want) => {
		const r = spawnSync('bash', ['-c', `${filter}\nprintf '%s|%s' "$TABLES" "$SIZE"`], { env: { ...process.env, TABLES: t, SIZE: s }, encoding: 'utf8' })
		expect(r.stdout).toBe(want)
	})
})
