import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
	DOCKERFILE_REWRITE_AWK,
	SYNTAX_ALLOWED_ERE,
	dockerfileRewriteFunctions,
} from '../build-cache'
import { bridgeShellFunctions } from '../deploy/fragments'
import { writeFakeDocker } from './fixtures/fake-docker'

// BuildKit reads \r (and \v, \f) as whitespace: the directive regex uses \s
// and splitCommand splits on [\t\v\f\r ]+, while the rewrite awk splits on space
// and tab. A mid-line \r would hide a syntax directive, a cache mount and FROM / COPY
// --from image refs. Every control byte other than tab is refused.

const root = mkdtempSync(join(tmpdir(), 'control-bytes-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const NS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const STUB = join(root, 'bin')
mkdirSync(STUB)
writeFakeDocker(STUB, '#!/bin/sh\nexit 1\n')
const CTL = 'REFUSE a Dockerfile with control characters other than tab is not supported'

function rewrite(dockerfile: string | Buffer): { out: string; report: string[] } {
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
			DFR_NS: NS,
			DFR_APP: 'shop',
			DFR_TF: join(dir, 'tf'),
			DFR_RP: rp,
			DFR_SYNTAX: SYNTAX_ALLOWED_ERE,
		},
	})
	expect(r.status).toBe(0)
	return { out: r.stdout, report: readFileSync(rp, 'utf8').split('\n').filter(Boolean) }
}
const refused = (df: string | Buffer) => rewrite(df).report.filter((l) => l.startsWith('REFUSE'))

// The whole dfr_one path (shell + awk), for bytes some awks drop (NUL).
function dfrOne(dockerfile: string | Buffer) {
	const dir = join(root, `s${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), dockerfile)
	const script = `DFR_NS=${NS}; DFR_APP=shop; DFR_DIR=$(mktemp -d); DFR_MODE=enforce; DFR_PULL=1; DFR_OWN=""; ${dockerfileRewriteFunctions('shop')}dfr_one ${JSON.stringify(join(dir, 'Dockerfile'))} ${JSON.stringify(join(dir, 'out'))}`
	// stub docker: no local images (the IMG check runs in every pull mode)
	const r = spawnSync('bash', ['-c', script], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${STUB}:${process.env.PATH}` },
	})
	const out = existsSync(join(dir, 'out')) ? readFileSync(join(dir, 'out'), 'utf8') : ''
	return { code: r.status, log: r.stdout + r.stderr, out }
}

describe('control bytes BuildKit reads as whitespace', () => {
	it('refuses every line of the control-byte example', () => {
		for (const df of [
			'#\rsyntax=docker.io/attacker/frontend:1\nFROM node:22\n',
			'FROM node:22\nRUN\r--mount=type=cach\\e,target=/root/.npm ls /root/.npm\n',
			'FROM\rvictim-app:latest\n',
			'FROM node:22\nCOPY\r--from=victim-app:latest /app /x\n',
		]) {
			expect(refused(df), JSON.stringify(df)).toContain(CTL)
		}
		const all =
			'#\rsyntax=docker.io/attacker/frontend:1\nFROM node:22\nRUN\r--mount=type=cach\\e,target=/root/.npm ls /root/.npm\nFROM\rvictim-app:latest\nCOPY\r--from=victim-app:latest /app /x\n'
		expect(refused(all)).toContain(CTL)
		expect(dfrOne(all).code).not.toBe(0)
	})
	it('refuses #\\rescape=`', () => {
		expect(refused('#\rescape=`\nFROM x\nRUN `\n--mount=type=cache,target=/x true\n')).toContain(
			CTL,
		)
	})
	it('refuses a mid-line CR even in a CRLF file, and a CR before the CRLF', () => {
		expect(refused('FROM x\r\nRUN\r--mount=type=cache,target=/x true\r\n')).toContain(CTL)
		expect(refused('FROM x\r\r\nRUN true\r\n')).toContain(CTL)
	})
	it('refuses ESC, and NUL through dfr_one', () => {
		expect(refused('FROM x\nRUN echo \x1b[31m red\n')).toContain(CTL)
		const nul = Buffer.from('FROM x\nRUN\0--mount=type=cache,target=/root/.npm npm ci\n', 'latin1')
		const r = dfrOne(nul)
		expect(r.code).not.toBe(0)
		expect(r.log).toContain('a Dockerfile with control characters other than tab is not supported')
	})
	it('refuses every control byte except tab and newline, mid-line in a RUN with a cache mount', () => {
		const bytes = [...Array.from({ length: 32 }, (_, i) => i), 0x7f].filter(
			(b) => b !== 0x09 && b !== 0x0a,
		)
		for (const b of bytes) {
			const df = Buffer.concat([
				Buffer.from('FROM x\nRUN --mount=type=cache,target=/root/.npm', 'latin1'),
				Buffer.from([b]),
				Buffer.from('npm ci\n', 'latin1'),
			])
			// NUL: some awks (macOS) end the line at it, so the shell check refuses it
			if (b === 0) {
				expect(dfrOne(df).code, 'byte 0').not.toBe(0)
				continue
			}
			expect(refused(df), `byte ${b}`).toContain(CTL)
			expect(dfrOne(df).code, `byte ${b}`).not.toBe(0)
		}
	})
	it('refuses a control byte in a heredoc body', () => {
		expect(
			refused('# syntax=docker/dockerfile:1\nFROM x\nRUN <<EOF\necho a\x0bb\nEOF\n'),
		).toContain(CTL)
	})
})

describe('what still passes', () => {
	it('CRLF files pass and are rewritten', () => {
		const r = rewrite(
			'# syntax=docker/dockerfile:1\r\nFROM node:22\r\nRUN --mount=type=cache,target=/root/.npm npm ci\r\n',
		)
		expect(r.report.filter((l) => l.startsWith('REFUSE'))).toEqual([])
		expect(r.report).toContain('REWROTE 1')
		expect(r.out).toContain('id=')
		const s = dfrOne('FROM node:22\r\nRUN --mount=type=cache,target=/root/.npm npm ci\r\n')
		expect(s.code).toBe(0)
		expect(s.out).toContain('id=')
	})
	it('tabs pass', () => {
		const r = rewrite('FROM\tnode:22\nRUN\t--mount=type=cache,target=/root/.npm\tnpm ci\n')
		expect(r.report.filter((l) => l.startsWith('REFUSE'))).toEqual([])
		expect(r.report).toContain('REWROTE 1')
	})
	it('UTF-8 text passes', () => {
		const df =
			'FROM node:22\nRUN --mount=type=cache,target=/root/.npm echo "déjà vu, über" && npm ci\n'
		expect(refused(df)).toEqual([])
		expect(dfrOne(df).code).toBe(0)
	})
})

// the bridge is created from the app's image, so an image LABEL
// com.docker.compose.project=<other app> would land on it; the create sets every
// compose label powder reads to empty (empty = no compose project).
describe('bridge container compose labels', () => {
	it('docker create overrides the image compose labels with empty values', () => {
		const f = bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')
		const create = f.slice(f.indexOf('docker create --pull=never --name "$__name"'))
		const cmd = create.slice(0, create.indexOf('"$__img"'))
		for (const k of [
			'com.docker.compose.project',
			'com.docker.compose.service',
			'com.docker.compose.project.config_files',
			'com.docker.compose.project.working_dir',
			'com.docker.compose.oneoff',
		]) {
			expect(cmd).toContain(`--label ${k}= `)
		}
	})
})
