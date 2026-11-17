import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DOCKERFILE_REWRITE_AWK, dockerfileImageRefReport, SYNTAX_ALLOWED_ERE } from '../build-cache'

// BuildKit resolves a FROM only against the stages declared on EARLIER FROM lines,
// never against its own AS name; COPY --from / --mount from= read any stage. A FROM whose
// name equals its own or a later stage's AS reads the local image of that name, so the
// image check must see it. The awk (on the server) and its TS twin run on one table.
// Invented names only.

const NS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const root = mkdtempSync(join(tmpdir(), 'stage-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0

// every awk on this machine (servers run gawk or mawk)
const AWKS = ['awk', 'mawk', 'gawk'].filter((b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0)

function awkReport(df: string, bin: string): string[] {
	const dir = join(root, `a${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), df)
	const argf = join(dir, 'args')
	writeFileSync(argf, '')
	const rp = join(dir, 'rp')
	writeFileSync(rp, '')
	const r = spawnSync(bin, [DOCKERFILE_REWRITE_AWK, join(dir, 'Dockerfile')], {
		encoding: 'utf8',
		env: { ...process.env, LC_ALL: 'C', DFR_NS: NS, DFR_APP: 'demoapp', DFR_TF: join(dir, 'tf'), DFR_RP: rp, DFR_ARGF: argf, DFR_SYNTAX: SYNTAX_ALLOWED_ERE },
	})
	expect(r.status, r.stderr).toBe(0)
	return readFileSync(rp, 'utf8')
		.split('\n')
		.filter((l) => /^IMG /.test(l))
}
function awkLines(df: string, bin: string, re: RegExp): string[] {
	const dir = join(root, `b${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), df)
	writeFileSync(join(dir, 'args'), '')
	writeFileSync(join(dir, 'rp'), '')
	const r = spawnSync(bin, [DOCKERFILE_REWRITE_AWK, join(dir, 'Dockerfile')], {
		encoding: 'utf8',
		env: { ...process.env, LC_ALL: 'C', DFR_NS: NS, DFR_APP: 'demoapp', DFR_TF: join(dir, 'tf'), DFR_RP: join(dir, 'rp'), DFR_ARGF: join(dir, 'args'), DFR_SYNTAX: SYNTAX_ALLOWED_ERE },
	})
	expect(r.status, r.stderr).toBe(0)
	return readFileSync(join(dir, 'rp'), 'utf8').split('\n').filter((l) => re.test(l))
}

type Case = { name: string; df: string; img: string[] }
const TABLE: Case[] = [
	// a FROM never reads its own AS name: the local image "zorbweb" is read
	{ name: 'own-as', df: 'FROM zorbweb AS zorbweb\nRUN true\n', img: ['IMG zorbweb'] },
	{ name: 'own-as-case', df: 'FROM ZorbWeb AS zorbweb\nRUN true\n', img: ['IMG ZorbWeb'] },
	// a stage declared on a LATER FROM line is not in scope for an earlier FROM
	{ name: 'later-as', df: 'FROM zorbweb AS build\nRUN true\nFROM node:22-alpine AS zorbweb\nCOPY --from=build /a /b\n', img: ['IMG zorbweb', 'IMG node:22-alpine'] },
	// an earlier stage is a stage (also case-insensitively)
	{ name: 'earlier', df: 'FROM node:22-alpine AS base\nFROM base AS build\nFROM BUILD\n', img: ['IMG node:22-alpine'] },
	// a number in FROM is an image name, never a stage index
	{ name: 'from-number', df: 'FROM node:22-alpine AS a\nFROM 0\n', img: ['IMG node:22-alpine', 'IMG 0'] },
	// COPY --from and --mount from= keep reading any stage, by name or index, before or after
	{ name: 'copy-later', df: 'FROM node:22-alpine AS a\nCOPY --from=b /x /y\nRUN --mount=type=bind,from=b,target=/m true\nFROM alpine:3.20 AS b\n', img: ['IMG node:22-alpine', 'IMG alpine:3.20'] },
	{ name: 'copy-index', df: 'FROM node:22-alpine\nFROM alpine:3.20\nCOPY --from=0 /x /y\n', img: ['IMG node:22-alpine', 'IMG alpine:3.20'] },
	// a variable FROM that resolves to its own AS name is the image too
	{ name: 'var-own-as', df: 'ARG B=zorbweb\nFROM $B AS zorbweb\n', img: ['IMG zorbweb'] },
	{ name: 'var-earlier', df: 'ARG B=base\nFROM alpine:3.20 AS base\nFROM $B\n', img: ['IMG alpine:3.20'] },
	// scratch is no image; a stage built FROM scratch is a stage for a later FROM
	{ name: 'scratch', df: 'FROM scratch AS scratchy\nFROM scratchy\n', img: [] },
]

describe('FROM resolves only against earlier stages (awk and TS twin, one table)', () => {
	for (const c of TABLE) {
		it(c.name, () => {
			for (const bin of AWKS) expect(awkReport(c.df, bin), bin).toEqual(c.img)
			const t = dockerfileImageRefReport(c.df).filter((l) => /^IMG /.test(l))
			expect(t).toEqual(c.img)
		})
	}
})

describe('BASE and FROM-flag lines, awk and TS twin', () => {
	const RE = /^(BASE|REFUSE a FROM|REFUSE a value for the build platform)/
	for (const df of [
		'FROM nodeish:22 AS a\nFROM a\nFROM --platform=linux/arm64 other:1\nARG B\nFROM ${B:-alpine:3}\n',
		'FROM zorbweb AS zorbweb\nFROM --platform=${TARGETPLATFORM} x:1 AS b\nFROM b\nFROM scratch\n',
		'ARG B\nFROM $B\nFROM --platform x:1\n',
		'ARG TARGETPLATFORM=linux/arm64\nARG BUILDARCH\nFROM --platform=$TARGETPLATFORM x:1\nARG targetos=linux\n',
	])
		it(df.split('\n')[0] as string, () => {
			const t = dockerfileImageRefReport(df).filter((l) => RE.test(l))
			expect(t.length).toBeGreaterThan(0)
			for (const bin of AWKS) expect(awkLines(df, bin, RE), bin).toEqual(t)
		})
})
