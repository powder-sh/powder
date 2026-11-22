// One authority for "where is this app's git checkout".
//
// An app's compose working dir (/opt/apps/<app>) holds the runtime compose file,
// the deploy key, data dirs and, in the standard layout, the git checkout in
// `src/`. An older layout has the checkout in the working dir itself. The rule,
// as the deploy script applies it (cwd = the working dir):
//
//   1. `src` is a symlink: refused (the deploy's preflight stops on it).
//   2. `src/.git` is a directory: the checkout is `<working dir>/src`. A `.git`
//      left in the working dir by an older layout is stale and ignored.
//   3. `.git` is a directory: the working dir itself is the checkout.
//   4. otherwise: no checkout.
//
// The shell side is appCheckoutDirShell (byte-for-byte the deploy preflight's
// PF_GITDIR line, used by the deploy script, self-deploy and the auto-rollback
// preflight). The TypeScript side is resolveAppCheckout over the facts that
// appCheckoutProbeShell reads on the server. app-checkout.test.ts runs both on the
// same directory trees and requires the same answer.
import { shq } from './shell'

/** Shell test for rule 1 (cwd = the working dir). The deploy preflight refuses on it
 *  before appCheckoutDirShell runs. */
export const APP_SRC_LINK_TEST = '[ -L src ]'

/** Shell (cwd = the working dir, one line, no trailing separator): set `v` to `src`
 *  (rule 2), `.` (rule 3) or the empty string (rule 4). Rule 1 is the caller's
 *  APP_SRC_LINK_TEST. */
export function appCheckoutDirShell(v: string): string {
	if (!/^[A-Z_][A-Z0-9_]*$/.test(v)) throw new Error('bad shell variable name')
	return `${v}=""; if [ -d src/.git ]; then ${v}=src; elif [ -d .git ]; then ${v}=.; fi`
}

/** What the probe reads in the working dir. */
export interface CheckoutFacts {
	/** `src` is a symlink */
	srcLink: boolean
	/** `src` exists (any type, a dangling link included) */
	srcExists: boolean
	/** `src/.git` is a directory */
	srcGit: boolean
	/** `.git` in the working dir is a directory */
	workdirGit: boolean
}

export type AppCheckout =
	/** the standard layout; `staleWorkdirGit`: an older layout's `.git` also sits in the working dir */
	| { kind: 'src'; dir: string; staleWorkdirGit: boolean }
	/** the older layout: the working dir is the checkout */
	| { kind: 'workdir'; dir: string }
	/** no checkout; `srcExists`: a `src` that is not a git checkout is there */
	| { kind: 'none'; srcExists: boolean }
	/** `src` is a symlink: the deploy refuses it, so nothing reads through it */
	| { kind: 'src-link' }
	/** the working dir could not be read */
	| { kind: 'unknown' }

const MARK = '::app-checkout::'

/** Shell (one line, ends with `; `): print one marker line with the facts of the
 *  working dir, or `<mark> nowd` when it cannot be entered. Runs in a subshell, so
 *  the caller's cwd is unchanged. Writes nothing. */
export function appCheckoutProbeShell(workingDir: string): string {
	const b = (t: string) => `"$(if ${t}; then echo 1; else echo 0; fi)"`
	return (
		`( if cd ${shq(workingDir)} 2>/dev/null; then ` +
		`printf '%s %s %s %s %s\\n' ${shq(MARK)} ${b(APP_SRC_LINK_TEST)} ${b('[ -e src ] || [ -L src ]')} ${b('[ -d src/.git ]')} ${b('[ -d .git ]')}; ` +
		`else printf '%s nowd\\n' ${shq(MARK)}; fi ); `
	)
}

/** The facts from a probe's output, or null when it has no (valid) marker line. Pure. */
export function parseCheckoutFacts(stdout: string): CheckoutFacts | null {
	for (const line of stdout.split('\n')) {
		const m = line.trim().match(/^::app-checkout:: ([01]) ([01]) ([01]) ([01])$/)
		if (m)
			return { srcLink: m[1] === '1', srcExists: m[2] === '1', srcGit: m[3] === '1', workdirGit: m[4] === '1' }
	}
	return null
}

/** The rule, for TypeScript callers. `facts` null = could not tell. Pure. */
export function resolveAppCheckout(workingDir: string, facts: CheckoutFacts | null): AppCheckout {
	if (!facts) return { kind: 'unknown' }
	const wd = workingDir.replace(/\/+$/, '')
	if (facts.srcLink) return { kind: 'src-link' }
	if (facts.srcGit) return { kind: 'src', dir: `${wd}/src`, staleWorkdirGit: facts.workdirGit }
	if (facts.workdirGit) return { kind: 'workdir', dir: wd }
	return { kind: 'none', srcExists: facts.srcExists }
}

/** What the repo card says about the app's checkout, one line per state. Pure. */
export function checkoutNote(workingDir: string | null, co: AppCheckout): string {
	const wd = workingDir?.replace(/\/+$/, '') ?? null
	if (!wd || co.kind === 'unknown')
		return wd ? `powder could not read the app's layout on the server (${wd}).` : "powder could not read the app's layout on the server."
	switch (co.kind) {
		case 'src':
			return co.staleWorkdirGit
				? `the git checkout is ${wd}/src. An older .git in ${wd} is ignored.`
				: `the git checkout is ${wd}/src.`
		case 'workdir':
			return `the git checkout is ${wd} itself (the older layout, no src/).`
		case 'none':
			return co.srcExists
				? `no git checkout: ${wd}/src exists but is not one, so powder will not clone into it. Move it away yourself if it is not needed.`
				: `no git checkout: neither ${wd}/src nor ${wd} is one.`
		case 'src-link':
			return `${wd}/src is a symlink: deploys refuse it, and powder does not clone through it.`
	}
}

/** Why the clone action (POST) refuses for this layout, or null when it may clone
 *  into `<working dir>/src` (no checkout anywhere and no `src`). Pure. */
export function cloneRefusal(workingDir: string, co: AppCheckout): string | null {
	const wd = workingDir.replace(/\/+$/, '')
	switch (co.kind) {
		case 'none':
			return co.srcExists
				? `${wd}/src exists but is not a git checkout; powder does not clone over it, nothing was changed. Move it away yourself if it is not needed, then clone again.`
				: null
		case 'src':
			return `the app already has a git checkout in ${wd}/src; nothing to clone, nothing was changed`
		case 'workdir':
			return `${wd} is already a git checkout; nothing to clone, nothing was changed`
		case 'src-link':
			return `${wd}/src is a symlink; powder does not clone through it, nothing was changed`
		case 'unknown':
			return `powder could not read the app's layout on the server (${wd}), so the clone did not run; nothing was changed`
	}
}
