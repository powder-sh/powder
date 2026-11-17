// guard: app_domains.status_error / applied_error and domain_redirects.applied_error
// hold `docker compose up` output on a failed apply (interpolated env values). Like the
// deploys text columns (finishDeploy), every write goes through the redactor, and the
// project domain list (GET /api/projects/<id>/domains, an MCP read scope) masks on read.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..')

function files(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) {
			if (name !== '__tests__' && name !== 'node_modules') out.push(...files(p))
		} else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p)
	}
	return out
}

const SAFE_VALUE = /^(null|undefined|redactSecrets\(|redactNullable\()/

/** Every statusError / appliedError entry inside a `.set({...})` or `.values({...})` block. */
function unmaskedWrites(src: string): string[] {
	const bad: string[] = []
	const blockRe = /\.(?:set|values)\(\{/g
	for (let m = blockRe.exec(src); m; m = blockRe.exec(src)) {
		// the object literal up to its matching brace
		let depth = 1
		let i = m.index + m[0].length
		const start = i
		for (; i < src.length && depth > 0; i++) {
			if (src[i] === '{') depth++
			else if (src[i] === '}') depth--
		}
		const body = src.slice(start, i - 1)
		for (const e of body.matchAll(/\b(statusError|appliedError)\b\s*(:\s*([^,\n]+)|(?=\s*[,\n}]|$))/g)) {
			const value = (e[3] ?? e[1]).trim()
			if (e[3] === undefined || !SAFE_VALUE.test(value)) bad.push(`${e[1]}: ${value}`)
		}
	}
	return bad
}

describe('domain error columns are masked', () => {
	const all = files(SRC)
	it('the scan finds the writers', () => {
		const writers = all.filter((f) => /\.(set|values)\(\{[^}]*\b(statusError|appliedError)\b/.test(readFileSync(f, 'utf8')))
		const rel = writers.map((f) => relative(SRC, f))
		for (const known of [
			'lib/app-domains.ts',
			'app/api/servers/[id]/containers/[name]/domains/[domainId]/route.ts',
			'app/api/domains/[serverId]/[name]/[hostname]/route.ts',
		])
			expect(rel).toContain(known)
	})
	it('the scan flags a raw value and a shorthand', () => {
		expect(unmaskedWrites(`db.update(t).set({ status: 'x', appliedError: msg })`)).toEqual(['appliedError: msg'])
		expect(unmaskedWrites("db.update(t).set({\n appliedAt: null,\n appliedError,\n})")).toEqual(['appliedError: appliedError'])
		expect(unmaskedWrites("db.update(t).set({ statusError: redactSecrets(msg), appliedError: null })")).toEqual([])
	})
	it.each(all.map((f) => [relative(SRC, f), f]))('%s', (_rel, f) => {
		expect(unmaskedWrites(readFileSync(f, 'utf8'))).toEqual([])
	})
	it('listDomainsForRepo selects explicit columns and masks both error columns', () => {
		const src = readFileSync(join(SRC, 'lib/app-domains.ts'), 'utf8')
		const fn = src.slice(src.indexOf('export async function listDomainsForRepo'))
		const body = fn.slice(0, fn.indexOf('\n}\n'))
		expect(body).not.toMatch(/db\.select\(\)/)
		expect(body).toMatch(/statusError: redactNullable\(r\.statusError\)/)
		expect(body).toMatch(/appliedError: redactNullable\(r\.appliedError\)/)
	})
	it('the domain apply error is masked where it is thrown', () => {
		const src = readFileSync(join(SRC, 'lib/app-domains.ts'), 'utf8')
		expect(src).toMatch(/throw new Error\(redactSecrets\(up\.stderr \|\| up\.stdout/)
	})
})
