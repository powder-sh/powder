import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// powder's own build context: every COPY source of docker/web.Dockerfile must
// exist and survive .dockerignore, while host dependencies and build output stay
// out of the context. (The .dockerignore powder writes for deployed apps is a
// different file: lib/app-runtime-files.ts.)

const REPO = resolve(__dirname, '../../../../..')

/** One .dockerignore rule as a regex, with Docker's pattern syntax. */
function toRegex(pattern: string): RegExp {
	let p = pattern.replace(/^\/+/, '').replace(/\/+$/, '')
	let re = ''
	while (p.length) {
		if (p.startsWith('**/')) {
			re += '(?:.*/)?'
			p = p.slice(3)
		} else if (p.startsWith('**')) {
			re += '.*'
			p = p.slice(2)
		} else if (p[0] === '*') {
			re += '[^/]*'
			p = p.slice(1)
		} else if (p[0] === '?') {
			re += '[^/]'
			p = p.slice(1)
		} else {
			re += p[0].replace(/[.+^${}()|[\]\\]/g, '\\$&')
			p = p.slice(1)
		}
	}
	return new RegExp(`^${re}$`)
}

const RULES = readFileSync(join(REPO, '.dockerignore'), 'utf8')
	.split('\n')
	.map((l) => l.trim())
	.filter((l) => l && !l.startsWith('#'))
	.map((l) => (l.startsWith('!') ? { neg: true, re: toRegex(l.slice(1)) } : { neg: false, re: toRegex(l) }))

/** Docker semantics: the last rule matching the path or one of its parent dirs wins. */
function ignored(path: string): boolean {
	const parts = path.split('/')
	const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
	let out = false
	for (const r of RULES) if (prefixes.some((x) => r.re.test(x))) out = !r.neg
	return out
}

// Host artefacts the walk skips: they are not in a clean checkout either.
const ARTEFACT = /(^|\/)(node_modules|\.next|\.turbo|dist)(\/|$)|\.tsbuildinfo$|(^|\/)\.env(?!\.example$)[^/]*$/

function files(rel: string): string[] {
	const abs = join(REPO, rel)
	if (!statSync(abs).isDirectory()) return [rel]
	return readdirSync(abs).flatMap((n) => {
		const r = `${rel}/${n}`
		return ARTEFACT.test(r) ? [] : files(r)
	})
}

/** Context sources of every COPY without --from, globs expanded. */
function copySources(): string[] {
	const df = readFileSync(join(REPO, 'docker/web.Dockerfile'), 'utf8')
	const out: string[] = []
	for (const line of df.split('\n')) {
		const m = line.match(/^\s*COPY\s+(.*)$/)
		if (!m || /--from=/.test(m[1])) continue
		const args = m[1].split(/\s+/).filter((a) => a && !a.startsWith('--'))
		for (const src of args.slice(0, -1)) {
			const s = src.replace(/^\.\//, '').replace(/\/$/, '')
			if (!s.includes('*')) {
				out.push(s)
				continue
			}
			const dir = s.slice(0, s.lastIndexOf('/'))
			const re = toRegex(s)
			const hits = readdirSync(join(REPO, dir)).map((n) => `${dir}/${n}`).filter((p) => re.test(p))
			expect(hits.length, `${s} matches nothing`).toBeGreaterThan(0)
			out.push(...hits)
		}
	}
	return out
}

describe('.dockerignore vs docker/web.Dockerfile', () => {
	it('every COPY source exists and no file under it is ignored', () => {
		const srcs = copySources()
		for (const s of ['apps/web', 'packages/db', 'pnpm-lock.yaml', 'bin/lib-migrations.sh', 'docker/powder-entrypoint.sh'])
			expect(srcs).toContain(s)
		for (const s of srcs) {
			expect(existsSync(join(REPO, s)), `${s} missing`).toBe(true)
			const bad = files(s).filter(ignored)
			expect(bad, `${s}: ignored by .dockerignore`).toEqual([])
		}
	})

	it('keeps host dependencies, build output and env files out of the context', () => {
		for (const p of [
			'node_modules/x',
			'apps/web/node_modules/next/package.json',
			'packages/db/node_modules/x',
			'apps/web/.next/standalone/server.js',
			'.turbo/x',
			'apps/web/.turbo/x',
			'packages/db/dist/index.js',
			'apps/web/tsconfig.tsbuildinfo',
			'apps/web/.env.local',
			'.env',
			'key.pem',
		])
			expect(ignored(p), p).toBe(true)
		for (const p of ['apps/web/.env.example', 'apps/web/src/app/page.tsx', 'packages/db/drizzle/0000_init.sql'])
			expect(ignored(p), p).toBe(false)
	})
})
