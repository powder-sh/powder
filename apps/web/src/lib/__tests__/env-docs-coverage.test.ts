// Every environment variable powder reads must be documented: in
// docker/powder.env.example or in the env table of the self-hosting docs page
// ("The env file", including its "Settings of the scripts" table). Sources:
//   - process.env.NAME / process.env['NAME'] and env.NAME / env['NAME'] (the
//     `env: Env = process.env` parameter pattern) under apps/web/src and
//     packages/*/src, tests excluded;
//   - ${NAME} in docker-compose.yml;
//   - ${NAME:-...} / ${NAME:?...} reads of POWDER_*, GITHUB_*, SSH_KEY_PATH and
//     DATABASE_URL in the user-facing scripts below.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../../../../..')

// Read on purpose but not powder settings, each with the reason.
const IGNORED: Record<string, string> = {
	NODE_ENV: 'set by the image (and listed in the example as "leave as is")',
	NEXT_PHASE: 'set by next build',
	NEXT_RUNTIME: 'set by Next.js per runtime',
	NEXT_PUBLIC_POWDER_VERSION: 'baked by next.config.ts from package.json',
	PORT: 'set by the image',
	HOSTNAME: 'set by the image',
	CI: 'set by CI runners',
	POWDER_BUILD_CACHE_ID: 'exported by bin/install.sh and bin/self-deploy.sh from POWDER_BUILD_CACHE_ID_FILE',
	POWDER_SKIP_BOOT_MIGRATIONS: 'set by bin/self-deploy.sh --skip-migrations for one recreate (docs/upgrading)',
	POWDER_MIGRATIONS_LIB: 'test-only path override in docker/powder-entrypoint.sh',
	POWDER_MEMINFO_FILE: 'test-only path override for /proc/meminfo in bin/install.sh',
	POWDER_SINGLE_TENANT: 'removed; only read to log that it is ignored',
}

const SCRIPTS = [
	'bin/install.sh',
	'bin/server-bootstrap.sh',
	'bin/self-deploy.sh',
	'bin/db-init.sh',
	'bin/fleet-check.sh',
	'docker/powder-entrypoint.sh',
]

function walk(dir: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out
	for (const e of readdirSync(dir)) {
		if (e === 'node_modules' || e === '__tests__' || e.startsWith('.')) continue
		const p = join(dir, e)
		if (statSync(p).isDirectory()) walk(p, out)
		else if (/\.(ts|tsx|mts)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p)
	}
	return out
}

function codeNames(): Map<string, string> {
	const found = new Map<string, string>()
	const add = (name: string, where: string) => {
		if (!found.has(name)) found.set(name, where)
	}
	const dirs = [join(ROOT, 'apps/web/src')]
	for (const p of readdirSync(join(ROOT, 'packages'))) dirs.push(join(ROOT, 'packages', p, 'src'))
	const re = /\b(?:process\.env|env)(?:\.([A-Z][A-Z0-9_]+)\b|\[['"]([A-Z][A-Z0-9_]+)['"]\])/g
	for (const f of dirs.flatMap((d) => walk(d))) {
		for (const m of readFileSync(f, 'utf8').matchAll(re)) add((m[1] ?? m[2]) as string, f.slice(ROOT.length + 1))
	}
	for (const m of readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8').matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g))
		add(m[1] as string, 'docker-compose.yml')
	const sh = /\$\{((?:POWDER|GITHUB)_[A-Z0-9_]+|SSH_KEY_PATH|DATABASE_URL):?[-=?]/g
	for (const s of SCRIPTS) {
		const f = join(ROOT, s)
		if (!existsSync(f)) continue
		for (const m of readFileSync(f, 'utf8').matchAll(sh)) add(m[1] as string, s)
	}
	return found
}

function documented(): string {
	const example = readFileSync(join(ROOT, 'docker/powder.env.example'), 'utf8')
	const page = readFileSync(join(ROOT, 'apps/web/content/docs/self-hosting.md'), 'utf8')
	const start = page.indexOf('\n## The env file')
	const end = page.indexOf('\n## ', start + 1)
	expect(start).toBeGreaterThan(-1)
	return `${example}\n${page.slice(start, end === -1 ? undefined : end)}`
}

describe('env variables are documented', () => {
	const names = codeNames()
	const docs = documented()
	it('finds the variables (the scan works)', () => {
		for (const n of ['DATABASE_URL', 'POWDER_SITE_HOST', 'POWDER_ENV_FILE', 'POWDER_MIGRATE_POST_WAIT', 'POWDER_GET_DOCKER_SHA256'])
			expect(names.has(n), n).toBe(true)
	})
	it('every variable read is in powder.env.example or the env table', () => {
		const missing = [...names]
			.filter(([n]) => !(n in IGNORED) && !new RegExp(`\\b${n}\\b`).test(docs))
			.map(([n, where]) => `${n} (read in ${where})`)
		expect(missing).toEqual([])
	})
	it('the ignore list has no stale entries', () => {
		const stale = Object.keys(IGNORED).filter((n) => !names.has(n) && !['CI', 'HOSTNAME', 'PORT'].includes(n))
		expect(stale).toEqual([])
	})
	it('POWDER_SELF_SERVER_ID is required with POWDER_SELF_SERVICE in the example', () => {
		expect(readFileSync(join(ROOT, 'docker/powder.env.example'), 'utf8')).toMatch(/required with POWDER_SELF_SERVICE/)
	})
})
