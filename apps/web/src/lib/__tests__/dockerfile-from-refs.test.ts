import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DOCKERFILE_REWRITE_AWK, dockerfileImageRefReport, SYNTAX_ALLOWED_ERE } from '../build-cache'
import { FROMREF_MUST_REFUSE as MUST_REFUSE } from './fixtures/dockerfile-cases'

// Image refs as BuildKit resolves them (frontend/dockerfile/dockerfile2llb/convert.go).
// BuildKit sets automatic global args with no ARG line (defaultArgs: BUILDPLATFORM,
// BUILDOS, BUILDARCH, BUILDVARIANT, BUILDOSVERSION, TARGETPLATFORM, TARGETOS, TARGETARCH,
// TARGETVARIANT, TARGETOSVERSION, TARGETSTAGE = the last stage's name when no target is
// given); the awk cannot know their values, so a ref that uses one is refused, and a FROM
// with a variable is written back with the literal ref the awk checked. COPY --from=<n> is a stage index
// only when strconv.Atoi parses it (else it is a name, so an image ref); an index past
// the last stage fails the build. The awk (on the server) and its TS twin run on one
// table. Invented names only.

const NS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const root = mkdtempSync(join(tmpdir(), 'fromref-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0

// every awk on this machine (servers run gawk or mawk)
const AWKS = ['awk', 'mawk', 'gawk'].filter((b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0)

function run(df: string, bin: string): { out: string; rp: string[] } {
	const dir = join(root, `f${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), df)
	writeFileSync(join(dir, 'args'), '')
	writeFileSync(join(dir, 'rp'), '')
	const r = spawnSync(bin, [DOCKERFILE_REWRITE_AWK, join(dir, 'Dockerfile')], {
		encoding: 'utf8',
		env: { ...process.env, LC_ALL: 'C', DFR_NS: NS, DFR_APP: 'demoapp', DFR_TF: join(dir, 'tf'), DFR_RP: join(dir, 'rp'), DFR_ARGF: join(dir, 'args'), DFR_SYNTAX: SYNTAX_ALLOWED_ERE },
	})
	expect(r.status, r.stderr).toBe(0)
	return { out: r.stdout, rp: readFileSync(join(dir, 'rp'), 'utf8').split('\n').filter(Boolean) }
}
// BuildKit's detectRunMount resolves a mount from= by stage name only (findStateByName);
// only COPY / ADD --from= reads a number as a stage index.
const MOUNT_FROM_NUMBER = 'FROM alpine AS a\nRUN --mount=type=bind,from=0,target=/x true\nFROM alpine\nCOPY --from=0 /a /b\n'
const FROM_TRAILING_BLANKS = 'FROM alpine \nRUN true\nFROM node:20 AS b \t\n'
const FROM_CONTINUED_TRAILING_BLANK = 'FROM node:20 \\\n  AS b \nRUN true\nFROM b\n'
const refusals = (l: string[]) => l.filter((x) => x.startsWith('REFUSE'))
const imgs = (l: string[]) => [...new Set(l.filter((x) => x.startsWith('IMG ') || x.startsWith('BASE ')).map((x) => x.replace(/^(IMG|BASE \d+) /, '')))]
const fromLines = (out: string) => out.split('\n').filter((l) => /^FROM /.test(l))

describe('FROM / --from refs BuildKit resolves with values the awk cannot see', () => {
	for (const bin of AWKS) {
		for (const [name, df] of MUST_REFUSE) {
			it(`${bin}: refuses ${name}`, () => {
				expect(refusals(run(df, bin).rp).length).toBeGreaterThan(0)
			})
		}
		it(`${bin}: COPY --from=<20 digits> is an image ref, not a stage index`, () => {
			const r = run('FROM alpine AS b\nFROM alpine\nCOPY --from=99999999999999999999 /x /x\n', bin)
			expect(imgs(r.rp)).toContain('99999999999999999999')
		})
		it(`${bin}: COPY --from=0 / 00001 stay stage indexes`, () => {
			const r = run('FROM alpine AS b\nFROM alpine\nCOPY --from=0 /x /x\nCOPY --from=00001 /y /y\n', bin)
			expect(refusals(r.rp)).toEqual([])
			expect(imgs(r.rp)).toEqual(['alpine'])
		})
		it(`${bin}: a FROM with a variable naming a stage is written back as that stage`, () => {
			const r = run('ARG X=b\nFROM alpine AS b\nFROM $X AS mid\nRUN true\nFROM ${S:-scratch}\n', bin)
			expect(refusals(r.rp)).toEqual([])
			expect(fromLines(r.out)).toEqual(['FROM __POWDER_BASE_1__ AS b', 'FROM b AS mid', 'FROM scratch'])
		})
		it(`${bin}: ARG BASE=node:20 + FROM $BASE still pins`, () => {
			const r = run('ARG BASE=node:20\nFROM $BASE\nRUN true\n', bin)
			expect(refusals(r.rp)).toEqual([])
			expect(imgs(r.rp)).toContain('node:20')
			expect(fromLines(r.out)).toEqual(['FROM __POWDER_BASE_1__'])
		})
		it(`${bin}: RUN --mount from=0 is an image named 0 (mounts look stages up by name only)`, () => {
			const r = run(MOUNT_FROM_NUMBER, bin)
			expect(r.rp).toContain('IMG 0')
			expect(refusals(r.rp)).toEqual([])
			expect(r.rp.filter((x) => x.startsWith('IMG '))).toEqual(['IMG alpine', 'IMG 0'])
		})
		it(`${bin}: trailing blanks on a FROM line keep the base pin and its AS name`, () => {
			const r = run(FROM_TRAILING_BLANKS, bin)
			expect(refusals(r.rp)).toEqual([])
			expect(fromLines(r.out)).toEqual(['FROM __POWDER_BASE_1__', 'FROM __POWDER_BASE_2__ AS b'])
		})
		it(`${bin}: a continued FROM whose last line ends in a blank keeps its AS name`, () => {
			const r = run(FROM_CONTINUED_TRAILING_BLANK, bin)
			expect(refusals(r.rp)).toEqual([])
			expect(fromLines(r.out)).toEqual(['FROM __POWDER_BASE_1__ AS b', 'FROM b'])
		})
		it(`${bin}: FROM --platform=$BUILDPLATFORM node:20 AS build still works`, () => {
			const r = run('FROM --platform=$BUILDPLATFORM node:20 AS build\nRUN true\nFROM build\n', bin)
			expect(refusals(r.rp)).toEqual([])
			expect(imgs(r.rp)).toEqual(['node:20'])
			expect(fromLines(r.out)).toEqual(['FROM __POWDER_BASE_1__ AS build', 'FROM build'])
		})
	}
})

describe('the TS twin agrees', () => {
	for (const [name, df] of MUST_REFUSE) {
		it(`refuses ${name}`, () => {
			expect(refusals(dockerfileImageRefReport(df)).length).toBeGreaterThan(0)
		})
	}
	it('COPY --from=<20 digits> is an image ref', () => {
		expect(imgs(dockerfileImageRefReport('FROM alpine AS b\nFROM alpine\nCOPY --from=99999999999999999999 /x /x\n'))).toContain('99999999999999999999')
	})
	it('COPY --from=0 / 00001 stay stage indexes', () => {
		const r = dockerfileImageRefReport('FROM alpine AS b\nFROM alpine\nCOPY --from=0 /x /x\nCOPY --from=00001 /y /y\n')
		expect(refusals(r)).toEqual([])
		expect(imgs(r)).toEqual(['alpine'])
	})
	it('RUN --mount from=0 is an image named 0', () => {
		const r = dockerfileImageRefReport(MOUNT_FROM_NUMBER)
		expect(refusals(r)).toEqual([])
		expect(r.filter((x) => x.startsWith('IMG '))).toEqual(['IMG alpine', 'IMG 0'])
	})
	it('trailing blanks on a FROM line keep the base pin', () => {
		for (const df of [FROM_TRAILING_BLANKS, FROM_CONTINUED_TRAILING_BLANK]) {
			const r = dockerfileImageRefReport(df)
			expect(refusals(r)).toEqual([])
			expect(r.filter((x) => x.startsWith('BASE '))).toEqual(df === FROM_TRAILING_BLANKS ? ['BASE 1 alpine', 'BASE 2 node:20'] : ['BASE 1 node:20'])
		}
	})
	it('ARG BASE=node:20 + FROM $BASE and FROM --platform=$BUILDPLATFORM pass', () => {
		expect(refusals(dockerfileImageRefReport('ARG BASE=node:20\nFROM $BASE\n'))).toEqual([])
		expect(refusals(dockerfileImageRefReport('FROM --platform=$BUILDPLATFORM node:20 AS build\nFROM build\n'))).toEqual([])
	})
	it('reports the same image and refusal lines as the awk', () => {
		const bin = AWKS[0]
		for (const [, df] of MUST_REFUSE) {
			const keep = (l: string[]) => l.filter((x) => /^(IMG|UNRESOLVED|REFUSE image ref|REFUSE an image ref|REFUSE a stage index)/.test(x))
			expect(keep(dockerfileImageRefReport(df))).toEqual(keep(run(df, bin).rp))
		}
	})
})
