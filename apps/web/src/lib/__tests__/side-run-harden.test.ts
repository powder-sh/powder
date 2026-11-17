// Every container powder starts outside compose carries one
// hardening set (lib/side-run.ts). This guard reads every `docker run` / `docker create`
// powder generates (TypeScript that builds shell) or ships to servers (infra/, bin/,
// docker/ shell) and fails when one lacks a capability drop (ALL or NET_RAW) or
// no-new-privileges. A new side container cannot be added without the flags or an
// allow-list entry with its reason.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIDE_RUN_CAPS, TOOL_RUN_HARDEN } from '../side-run'
import { SIDE_RUN_HARDEN } from '../deploy-snapshots'

const REPO = join(__dirname, '../../../../..')
const RUN_RE = /\bdocker\s+(?:container\s+)?(?:run|create)\b/

/** Lines that name `docker run` / `create` but are not a command powder runs. */
const ALLOW: Array<{ file: string; includes: string; reason: string }> = [
	{
		file: 'apps/web/src/lib/deploy-runner.ts',
		includes: "started via raw 'docker run' instead of",
		reason: 'error message text shown to the operator, not a command',
	},
	{
		file: 'apps/web/src/lib/deploy-snapshots.ts',
		includes: "'docker run failed'",
		reason: 'error message text, not a command',
	},
]

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === '.next' || name === '__tests__' || name === '__snapshots__') continue
		const p = join(dir, name)
		const st = statSync(p)
		if (st.isDirectory()) walk(p, out)
		else if (/\.(ts|tsx|mts|sh)$/.test(name) && !/\.test\./.test(name)) out.push(p)
	}
	return out
}

function shippedFiles(): string[] {
	const files = [
		...walk(join(REPO, 'apps/web/src')),
		...walk(join(REPO, 'packages')),
		...walk(join(REPO, 'infra')),
		...walk(join(REPO, 'bin')),
		...walk(join(REPO, 'docker')),
		join(REPO, 'infra/powder-migrate'),
	]
	return [...new Set(files)]
}

/** Physical lines, with shell `\` continuations joined. */
function logicalLines(text: string, shell: boolean): Array<{ n: number; line: string }> {
	const raw = text.split('\n')
	const out: Array<{ n: number; line: string }> = []
	for (let i = 0; i < raw.length; i++) {
		let line = raw[i] ?? ''
		const n = i + 1
		while (shell && /\\$/.test(line) && i + 1 < raw.length) line = `${line.slice(0, -1)} ${raw[++i] ?? ''}`
		out.push({ n, line })
	}
	return out
}

const CAP_OK = /--cap-drop[ =](?:ALL|NET_RAW)\b|\$\{(?:SIDE_RUN_CAPS|TOOL_RUN_HARDEN|SIDE_RUN_HARDEN)\}/
const NNP_OK = /--security-opt[ =]no-new-privileges\b|\$\{(?:SIDE_RUN_CAPS|TOOL_RUN_HARDEN|SIDE_RUN_HARDEN)\}/

function unhardenedRuns(files: string[]): string[] {
	const bad: string[] = []
	for (const f of files) {
		const rel = relative(REPO, f)
		const shell = !/\.(ts|tsx|mts)$/.test(f)
		for (const { n, line } of logicalLines(readFileSync(f, 'utf8'), shell)) {
			if (!RUN_RE.test(line)) continue
			const t = line.trim()
			if (shell ? t.startsWith('#') : /^(\/\/|\*|\/\*)/.test(t)) continue
			if (ALLOW.some((a) => a.file === rel && line.includes(a.includes))) continue
			if (!CAP_OK.test(line) || !NNP_OK.test(line)) bad.push(`${rel}:${n}: ${t.slice(0, 160)}`)
		}
	}
	return bad
}

describe('one hardening set for every side container', () => {
	it('the authority carries a capability drop and no-new-privileges', () => {
		for (const s of [SIDE_RUN_CAPS, TOOL_RUN_HARDEN, SIDE_RUN_HARDEN]) {
			expect(s).toMatch(CAP_OK)
			expect(s).toMatch(NNP_OK)
		}
		expect(TOOL_RUN_HARDEN).toContain('--cap-drop ALL')
	})

	it('finds the docker run / create sites it is meant to guard', () => {
		const files = shippedFiles()
		let n = 0
		for (const f of files) n += (readFileSync(f, 'utf8').match(new RegExp(RUN_RE.source, 'g')) ?? []).length
		// snapshot, rollback bridge, zero-downtime bridge, test gate, pg_dump, psql size,
		// restore instructions, Traefik bootstrap (TS and bin/), powder-migrate
		expect(n).toBeGreaterThanOrEqual(10)
		const migrate = readFileSync(join(REPO, 'infra/powder-migrate'), 'utf8')
		expect(migrate).toMatch(RUN_RE)
	})

	it('every docker run / docker create powder generates or ships is hardened', () => {
		expect(unhardenedRuns(shippedFiles())).toEqual([])
	})

	it('allow-list entries still match a line (no stale exception)', () => {
		for (const a of ALLOW) expect(readFileSync(join(REPO, a.file), 'utf8')).toContain(a.includes)
	})

	it('powder-migrate psql: no capability, no privilege gain, uid 70, read-only root', () => {
		const m = readFileSync(join(REPO, 'infra/powder-migrate'), 'utf8')
		const run = m.split('\n').find((l) => /^PSQL\(\) \{ docker run/.test(l)) ?? ''
		for (const flag of ['--cap-drop ALL', '--security-opt no-new-privileges', '--user 70:70', '--read-only', '--tmpfs /tmp', '--pids-limit 256', '--memory 512m', '-e HOME=/tmp'])
			expect(run).toContain(flag)
		expect(m).toContain('exec psql -X -v ON_ERROR_STOP=1')
	})
})
