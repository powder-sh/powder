import { execFileSync } from 'node:child_process'
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GITHUB_KNOWN_HOSTS_SETUP } from '../ssh/git'

// The /opt/apps write fails when that directory is not writable (as on a dev
// machine or for a non-root SSH user), which is exactly the fallback case. The
// path is pointed at a missing dir, so this runs the same on any host (root
// included) and never writes the host's /opt/apps.
// A bare `mktemp` creates its file in $TMPDIR: GNU mktemp does, and hermetic.ts
// wraps the host mktemp so the BSD one on macOS does too.
const MKTEMP_DIR = tmpdir()

const SEEN = () => join(mkdtempSync(join(tmpdir(), 'powder-pkh-seen-')), 'seen')

/** $PKH, plus a copy (mode kept) of the file taken while the shell still runs: the
 *  mktemp fallback is removed when the shell exits. */
function run(env: Record<string, string> = {}) {
	const sh = GITHUB_KNOWN_HOSTS_SETUP.replaceAll('/opt/apps/.powder_known_hosts', `${tmpdir()}/no-such-dir/.powder_known_hosts`)
	const seen = SEEN()
	const out = execFileSync('bash', ['-c', `${sh}printf '%s' "$PKH"; if [ -f "$PKH" ]; then cp -p "$PKH" "$SEEN"; fi`], {
		env: { ...process.env, ...env, SEEN: seen },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	return { pkh: out.toString(), seen }
}

describe('known_hosts fallback when /opt/apps is not writable', () => {
	it('uses a fresh mktemp file, not the predictable /tmp/.powder_known_hosts, removed on exit', () => {
		const { pkh, seen } = run()
		expect(pkh).not.toBe('/tmp/.powder_known_hosts')
		expect(pkh.startsWith(`${MKTEMP_DIR}/tmp.`)).toBe(true)
		expect(readFileSync(seen, 'utf8')).toContain('github.com ssh-ed25519 ')
		expect(statSync(seen).mode & 0o077).toBe(0)
		expect(existsSync(pkh)).toBe(false)
	})

	it('if the fallback write fails, $PKH points at a missing file so the strict check fails', () => {
		const bin = mkdtempSync(join(tmpdir(), 'powder-pkh-'))
		writeFileSync(join(bin, 'mktemp'), '#!/bin/bash\nexit 1\n')
		chmodSync(join(bin, 'mktemp'), 0o755)
		const { pkh, seen } = run({ PATH: `${bin}:${process.env.PATH}` })
		expect(existsSync(pkh)).toBe(false)
		expect(existsSync(seen)).toBe(false)
		expect(pkh).toContain('/nonexistent/')
	})
})
