import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { dockerfileRewriteFunctions, syntaxAllowed } from '../build-cache'
import { composeViolations } from '../compose-safety'

// a `# syntax=` custom BuildKit frontend receives the whole build context and
// need not honour .dockerignore (the deploy key, rendered env files). Only Docker's
// own Dockerfile frontend is allowed; the BUILDKIT_SYNTAX build arg is refused.

const root = mkdtempSync(join(tmpdir(), 'syn-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
function check(dockerfile: string) {
	const dir = join(root, `d${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), dockerfile)
	const script = `DFR_NS=a1b2c3d4e5f60718293a4b5c6d7e8f90; DFR_APP=shop; DFR_DIR=$(mktemp -d); DFR_MODE=warn; DFR_PULL=1; DFR_OWN=""; ${dockerfileRewriteFunctions('shop')}dfr_one ${JSON.stringify(join(dir, 'Dockerfile'))} ${JSON.stringify(join(dir, 'out'))}`
	const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
	return { code: r.status, log: r.stdout + r.stderr }
}

describe('# syntax= allow-list', () => {
	it.each([
		'docker/dockerfile:1',
		'docker/dockerfile:1.4',
		'docker/dockerfile:1.7',
		'docker/dockerfile:1.7-labs',
		'docker/dockerfile',
		'docker.io/docker/dockerfile:1',
		`docker/dockerfile:1@sha256:${'a'.repeat(64)}`,
	])('allows %s', (v) => {
		expect(syntaxAllowed(v)).toBe(true)
		expect(check(`# syntax=${v}\nFROM node:22\n`).code).toBe(0)
	})

	it.each([
		'evil/frontend:1',
		'docker/dockerfile-upstream:master',
		'ghcr.io/docker/dockerfile:1',
		'docker/dockerfile:1@sha256:abc',
		'localhost:5000/docker/dockerfile:1',
	])('refuses %s, in every guard mode', (v) => {
		expect(syntaxAllowed(v)).toBe(false)
		const r = check(`# syntax=${v}\nFROM node:22\n`)
		expect(r.code).not.toBe(0)
		expect(r.log).toContain('is not allowed')
	})

	it('reads directive spellings BuildKit accepts', () => {
		expect(check('#syntax=evil/fe\nFROM x\n').code).not.toBe(0)
		expect(check('# SYNTAX = evil/fe\nFROM x\n').code).not.toBe(0)
		expect(check('# escape=`\n# syntax=evil/fe\nFROM x\n').code).not.toBe(0)
		// after the first instruction a comment is only a comment
		expect(check('FROM x\n# syntax=evil/fe\n').code).toBe(0)
	})
})

describe('BuildKit syntax detection variants', () => {
	it('strips a UTF-8 BOM before reading the directive', () => {
		expect(check('﻿# syntax=evil/fe\nFROM x\n').code).not.toBe(0)
		expect(check('﻿# syntax=docker/dockerfile:1\nFROM x\n').code).toBe(0)
	})
	it('reads // syntax= lines like # lines', () => {
		expect(check('// syntax=evil/fe\nFROM x\n').code).not.toBe(0)
		expect(check('//syntax = evil/fe\nFROM x\n').code).not.toBe(0)
		expect(check('// syntax=docker/dockerfile:1.7\nFROM x\n').code).toBe(0)
	})
	it('refuses a JSON-form Dockerfile', () => {
		const r = check('{"syntax": "evil/fe", "x": 1}\n')
		expect(r.code).not.toBe(0)
		expect(r.log).toContain('JSON-form')
		expect(check('\n  {"syntax":"docker/dockerfile:1"}\n').code).not.toBe(0)
	})
	it('a digest pin is exactly 64 hex characters (no interval expression: mawk has none)', () => {
		expect(check(`# syntax=docker/dockerfile:1@sha256:${'a'.repeat(63)}\nFROM x\n`).code).not.toBe(
			0,
		)
		expect(check(`# syntax=docker/dockerfile:1@sha256:${'a'.repeat(65)}\nFROM x\n`).code).not.toBe(
			0,
		)
		expect(check(`# syntax=docker/dockerfile:1@sha256:${'a'.repeat(64)}\nFROM x\n`).code).toBe(0)
		expect(syntaxAllowed(`docker/dockerfile:1@sha256:${'a'.repeat(63)}`)).toBe(false)
	})
	it('the awk program and the syntax ERE use no interval expressions or gawk-only features', async () => {
		const { DOCKERFILE_REWRITE_AWK, SYNTAX_ALLOWED_ERE } = await import('../build-cache')
		expect(SYNTAX_ALLOWED_ERE).not.toMatch(/\{\d/)
		const regexes = [...DOCKERFILE_REWRITE_AWK.matchAll(/\/(\^|\[)[^\n]*?\//g)].map((m) => m[0])
		expect(regexes.length).toBeGreaterThan(5)
		for (const re of regexes) expect(re).not.toMatch(/\{\d+(,\d*)?\}/)
		expect(DOCKERFILE_REWRITE_AWK).not.toMatch(/gensub|strftime|systime|asort|PROCINFO|IGNORECASE/)
	})
})

describe('BUILDKIT_SYNTAX build arg', () => {
	const ctx = { appName: 'shop', projectDir: '/opt/apps/shop', resolved: true } as never
	const cfg = (args: unknown) => ({
		name: 'shop',
		services: { shop: { image: 'shop:latest', build: { context: '/opt/apps/shop/src', args } } },
	})
	it('is refused by the compose guard (map and list forms)', () => {
		expect(
			composeViolations(cfg({ BUILDKIT_SYNTAX: 'evil/fe' }), ctx).map((v) => v.code),
		).toContain('build')
		expect(composeViolations(cfg(['BUILDKIT_SYNTAX=evil/fe']), ctx).map((v) => v.code)).toContain(
			'build',
		)
		expect(
			composeViolations(cfg({ NODE_ENV: 'production' }), ctx).map((v) => v.code),
		).not.toContain('build')
	})
})
