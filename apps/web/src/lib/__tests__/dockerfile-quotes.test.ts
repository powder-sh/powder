import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DOCKERFILE_REWRITE_AWK, SYNTAX_ALLOWED_ERE } from '../build-cache'

// the Dockerfile parser read flag words and image refs without unquoting
// them, so a quoted or escaped value could name another image than the one
// checked. Quotes / backslashes there are refused; an image ref with characters
// an image name cannot have is refused.

const root = mkdtempSync(join(tmpdir(), 'q-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0

function report(dockerfile: string): string[] {
	const dir = join(root, `c${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), dockerfile)
	const rp = join(dir, 'rp')
	writeFileSync(rp, '')
	const r = spawnSync('awk', [DOCKERFILE_REWRITE_AWK, join(dir, 'Dockerfile')], {
		encoding: 'utf8',
		env: {
			...process.env,
			LC_ALL: 'C',
			DFR_NS: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
			DFR_APP: 'shop',
			DFR_TF: join(dir, 'tf'),
			DFR_RP: rp,
			DFR_SYNTAX: SYNTAX_ALLOWED_ERE,
		},
	})
	expect(r.status).toBe(0)
	return readFileSync(rp, 'utf8').split('\n').filter(Boolean)
}
const refused = (df: string) => report(df).filter((l) => l.startsWith('REFUSE'))
const imgs = (df: string) => report(df).filter((l) => /^(IMG|UNRESOLVED) /.test(l))

describe('quotes and backslashes in flags and image refs', () => {
	it('refuses a quoted or escaped FROM image', () => {
		expect(refused('FROM "node:22"\n').length).toBe(1)
		expect(refused("FROM 'blog'\n").length).toBe(1)
		expect(refused('FROM bl\\og\n').length).toBe(1)
	})
	it('refuses quotes or backslashes in RUN/COPY/ADD/FROM flag words', () => {
		expect(refused('FROM x\nCOPY --from="blog" /a /a\n').length).toBeGreaterThan(0)
		expect(refused('FROM x\nCOPY --from=bl\\og /a /a\n').length).toBeGreaterThan(0)
		// a FROM --platform= other than the build's own platform is refused too
		expect(refused('FROM --platform="linux/amd64" node:22\n').length).toBeGreaterThan(0)
		expect(refused('FROM x\nRUN --network="none" true\n').length).toBe(1)
		expect(refused('FROM x\nADD --chown="a:b" f /f\n').length).toBe(1)
		expect(refused('FROM x\nONBUILD COPY --from="blog" /a /a\n').length).toBeGreaterThan(0)
	})
	it('refuses an image ref with characters an image name cannot have', () => {
		expect(refused('ARG B=bl\\og\nFROM ${B}\n').length).toBe(1)
		expect(refused('FROM x\nRUN --mount=type=bind,from=a;b,target=/s true\n').length).toBe(1)
	})
	it('passes the common shapes', () => {
		for (const df of [
			'FROM --platform=$BUILDPLATFORM node:22 AS build\nFROM build\n',
			'ARG BASE=node:22\nFROM ${BASE}\n',
			'ARG BASE="node:22-alpine"\nFROM ${BASE} AS b\nCOPY --from=b --chown=node:node /app /app\n',
			'FROM docker.io/library/node:22@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n',
			'FROM localhost:5000/team/img:1.2_3\n',
			'FROM x\nRUN echo "--from=\'q\'" && echo \\\n  done\n',
			'FROM x\nCOPY --link --chmod=755 a /a\n',
		])
			expect(refused(df)).toEqual([])
	})
	it('an unresolved variable stays UNRESOLVED (warn), as before', () => {
		expect(imgs('FROM ${NOPE}\n')).toEqual(['UNRESOLVED ${NOPE}'])
		expect(imgs('ARG BASE=node:22\nFROM ${BASE}\n')).toEqual(['IMG node:22'])
	})
})
