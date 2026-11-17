// the github.com known_hosts is never written through a fixed
// `/opt/apps/.powder_known_hosts.tmp`, which a pre-created file or symlink there
// could hijack. It goes through a mktemp file in the same dir, then mv.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GITHUB_KNOWN_HOSTS_SETUP } from '../ssh/git'

function run(dir: string, env: Record<string, string> = {}) {
	const sh = GITHUB_KNOWN_HOSTS_SETUP.replaceAll('/opt/apps/.powder_known_hosts', `${dir}/.powder_known_hosts`)
	// a copy in <dir>/../seen taken while the shell runs: the mktemp fallback is removed on exit
	return execFileSync('bash', ['-c', `${sh}printf '%s' "$PKH"; if [ -f "$PKH" ]; then cp "$PKH" "$SEEN"; fi`], {
		env: { ...process.env, ...env, SEEN: join(dir, '..', 'seen') },
	}).toString()
}

describe('known_hosts temp file', () => {
	it('a planted .powder_known_hosts.tmp symlink is not written through', () => {
		const d = mkdtempSync(join(tmpdir(), 'powder-r25kh-'))
		const apps = join(d, 'apps')
		mkdirSync(apps)
		writeFileSync(join(d, 'victim'), 'keep\n')
		symlinkSync(join(d, 'victim'), join(apps, '.powder_known_hosts.tmp'))
		const pkh = run(apps)
		expect(pkh).toBe(join(apps, '.powder_known_hosts'))
		expect(readFileSync(join(d, 'victim'), 'utf8')).toBe('keep\n')
		expect(readFileSync(pkh, 'utf8')).toContain('github.com ssh-ed25519 ')
		expect(readdirSync(apps).sort()).toEqual(['.powder_known_hosts', '.powder_known_hosts.tmp'])
	})
	it('a failed mv leaves no temp file behind and falls back', () => {
		const d = mkdtempSync(join(tmpdir(), 'powder-r25kh-'))
		const apps = join(d, 'apps')
		const bin = join(d, 'bin')
		mkdirSync(apps)
		mkdirSync(bin)
		writeFileSync(join(bin, 'mv'), '#!/bin/bash\nexit 1\n')
		chmodSync(join(bin, 'mv'), 0o755)
		const pkh = run(apps, { PATH: `${bin}:${process.env.PATH}` })
		expect(pkh).not.toBe(join(apps, '.powder_known_hosts'))
		expect(readdirSync(apps)).toEqual([])
		expect(readFileSync(join(d, 'seen'), 'utf8')).toContain('github.com ssh-ed25519 ')
		expect(existsSync(pkh)).toBe(false)
	})
})
