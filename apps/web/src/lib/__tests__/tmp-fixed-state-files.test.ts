// Guard: no lock or state file powder keeps on a server has a fixed name under /tmp.
// /tmp is world-writable, so any local user could create such a file first or plant a
// symlink there. Locks and state live under /run or /var/lib (root) or the ssh user's
// $HOME (rootOrHomePathShell in build-lock.ts); temp files use mktemp.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builderCapPruneShell } from '../builder-prune'
import { plockFn } from '../builder'
import { lockedPruneShell } from '../deploy/prune-lock'

const ROOT = join(__dirname, '../../../../..')

/** A fixed /tmp path with a lock or state suffix, or a shell fd opened on a fixed
 *  /tmp path (`exec 9>/tmp/x`). mktemp templates (XXXXXX) are not fixed names. */
const FIXED_TMP_STATE =
	/\/tmp\/(?![^\s'"`]*XXXXXX)[A-Za-z0-9._-]+\.(?:lock|last|attempt|stuck|after|state|pid|stamp|count)\b|\bexec [0-9]+>\s*\/tmp\//

/** Exact "<file>|<trimmed line>" entries. The upgrade scripts also wait on the build
 *  lock at its older path, opened only when it is a regular root-owned file (only root
 *  can create or remove such a file in sticky /tmp). */
const ALLOW = new Set([
	'bin/install.sh|OLDER_BUILD_LOCK=/tmp/powder-build.lock',
	'bin/self-deploy.sh|OLDER_BUILD_LOCK=/tmp/powder-build.lock',
	'apps/web/src/lib/build-lock.ts|// bin/install.sh and bin/self-deploy.sh also take /tmp/powder-build.lock when it is a',
])

function hits(file: string, text: string): string[] {
	return text
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => FIXED_TMP_STATE.test(l) && !ALLOW.has(`${file}|${l}`))
		.map((l) => `${file}: ${l}`)
}

function walk(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
	for (const e of readdirSync(dir)) {
		if (e === 'node_modules' || e === '__tests__' || e === '.next') continue
		const p = join(dir, e)
		if (statSync(p).isDirectory()) walk(p, keep, out)
		else if (keep(p)) out.push(p)
	}
	return out
}

describe('no fixed-name lock or state file under /tmp', () => {
	it('the pattern catches the shapes it guards against', () => {
		for (const l of [
			'{ exec 9>/run/x.lock; } 2>/dev/null || exec 9>/tmp/powder-image-prune.lock',
			"wr '/var/lib/powder/builder-prune.last' '/tmp/powder-builder-prune.last'",
			'STATE=/tmp/powder-builder-prune.stuck',
		])
			expect(FIXED_TMP_STATE.test(l), l).toBe(true)
		for (const l of ['T=$(mktemp /tmp/powder-stage.XXXXXX)', 'exec 9>/run/powder-image-prune.lock'])
			expect(FIXED_TMP_STATE.test(l), l).toBe(false)
	})

	it('in the web sources, the infra helpers and the bin scripts', () => {
		const files = [
			...walk(join(ROOT, 'apps/web/src'), (p) => /\.(ts|tsx)$/.test(p)),
			...walk(join(ROOT, 'infra'), () => true),
			...walk(join(ROOT, 'bin'), (p) => /\.sh$/.test(p)),
		]
		const bad = files.flatMap((p) => hits(relative(ROOT, p), readFileSync(p, 'utf8')))
		expect(bad).toEqual([])
	})

	it('in the rendered prune and build-slot shell', () => {
		const rendered = [
			builderCapPruneShell(),
			lockedPruneShell({ label: '[t]', lockWaitSec: 1, busyWaitSec: 1, imagePrune: 'docker image prune -f', rest: ['true'] }),
			plockFn(2),
		]
		for (const sh of rendered) {
			expect(sh).not.toMatch(FIXED_TMP_STATE)
			expect(sh).not.toContain('/tmp/')
		}
		// the cap prune: root paths under /run and /var/lib, else under $HOME
		const prune = builderCapPruneShell()
		for (const p of [
			'/run/powder-builder-prune.lock',
			'$HOME/.powder-builder-prune.lock',
			'/var/lib/powder/builder-prune.last',
			'$HOME/.powder-builder-prune.last',
			'/var/lib/powder/builder-prune.attempt',
			'$HOME/.powder-builder-prune.stuck',
			'$HOME/.powder-builder-prune.after',
			'/var/lib/powder/builder-prune.root',
			'$HOME/.powder-builder-prune.root',
		])
			expect(prune).toContain(p)
	})
})
