import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { dockerfileImageForeign } from '../compose-safety'
import { DOCKERFILE_REWRITE_AWK, dockerfileAuthorityShell, dockerfileImageRefReport, dockerfileRewriteFunctions, SYNTAX_ALLOWED_ERE } from '../build-cache'
import { writeFakeDocker } from './fixtures/fake-docker'

// image refs from variables resolve with BuildKit's ARG scope and order (meta
// ARGs for FROM, the stage's ARGs above the line for COPY --from / --mount from=), plus a
// fail-closed backstop over every value a name is ever given. The awk (on the server) and
// its TS twin run on one table. Invented names only.

const NS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const root = mkdtempSync(join(tmpdir(), 'scope-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0

const VICTIM = 'ghcr.io/victimorg/otherapp:latest'

function awkReport(df: string, args: Record<string, string> = {}): string[] {
	const dir = join(root, `a${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), df)
	const argf = join(dir, 'args')
	writeFileSync(argf, Object.entries(args).map(([k, v]) => `${k}=${v}\n`).join(''))
	const rp = join(dir, 'rp')
	writeFileSync(rp, '')
	const r = spawnSync('awk', [DOCKERFILE_REWRITE_AWK, join(dir, 'Dockerfile')], {
		encoding: 'utf8',
		env: { ...process.env, LC_ALL: 'C', DFR_NS: NS, DFR_APP: 'demoapp', DFR_TF: join(dir, 'tf'), DFR_RP: rp, DFR_ARGF: argf, DFR_SYNTAX: SYNTAX_ALLOWED_ERE },
	})
	expect(r.status, r.stderr).toBe(0)
	return readFileSync(rp, 'utf8')
		.split('\n')
		.filter((l) => /^(IMG|UNRESOLVED|VARREF|AT|REFUSE image ref) /.test(l))
}

type Case = { name: string; df: string; args?: Record<string, string>; has: string[]; not?: string[] }
const TABLE: Case[] = [
	// t1: the meta ARG at the FROM line decides; a later ARG of the same name does not hide it
	{ name: 't1', df: `ARG BASE=${VICTIM}\nFROM \${BASE}\nRUN echo hi\nARG BASE=node:22-alpine\n`, has: [`IMG ${VICTIM}`] },
	// t2: a stage ARG is not a meta ARG
	{ name: 't2', df: `ARG BASE=${VICTIM}\nFROM alpine AS a\nARG BASE=alpine\nFROM $BASE\n`, has: [`IMG ${VICTIM}`, `VARREF $BASE ${VICTIM}`] },
	// t3: the stage ARG above the COPY decides; a later stage's ARG does not hide it
	{
		name: 't3',
		df: `FROM alpine\nARG X=${VICTIM}\nCOPY --from=$X /app /stolen\nRUN --mount=type=bind,from=$X,target=/m cp -r /m /stolen2\nFROM alpine\nARG X=alpine\n`,
		has: [`IMG ${VICTIM}`, `VARREF $X ${VICTIM}`],
	},
	// t4: FROM reads the meta value, not the redeclared stage ARG of the stage before it
	{ name: 't4', df: 'ARG BASE=otherapp:latest\nFROM alpine AS a\nARG BASE\nFROM a\nARG BASE=node:22\nFROM ${BASE}\n', has: ['IMG otherapp:latest', 'VARREF ${BASE} otherapp:latest'] },
	// scope: a meta ARG without a value stays unresolved for FROM, whatever a stage sets later
	{ name: 'meta-unset', df: 'ARG BASE\nFROM $BASE\nFROM alpine\nARG BASE=node:22\n', has: ['UNRESOLVED $BASE'] },
	// order: an ARG below the COPY is not in scope at the COPY
	{ name: 'arg-after-use', df: 'FROM alpine\nCOPY --from=$X /a /a\nARG X=node:22\n', has: ['UNRESOLVED $X'] },
	// a stage ARG without a default inherits the meta value
	{ name: 'inherit', df: `ARG X=${VICTIM}\nFROM alpine\nARG X\nCOPY --from=$X /a /b\n`, has: [`IMG ${VICTIM}`, `VARREF $X ${VICTIM}`] },
	// a meta ARG is not in a stage unless redeclared there (backstop still checks the value)
	{ name: 'meta-not-in-stage', df: `ARG X=${VICTIM}\nFROM alpine\nCOPY --from=$X /a /b\n`, has: ['UNRESOLVED $X', `IMG ${VICTIM}`] },
	// build args override a meta ARG and a declared stage ARG
	{ name: 'ovr-meta', df: 'ARG BASE=alpine\nFROM $BASE\n', args: { BASE: VICTIM }, has: [`IMG ${VICTIM}`, 'IMG alpine'] },
	{ name: 'ovr-stage', df: 'FROM alpine\nARG X=alpine\nCOPY --from=$X /a /b\n', args: { X: VICTIM }, has: [`VARREF $X ${VICTIM}`] },
	{ name: 'ovr-stage-inherit', df: 'ARG X=alpine\nFROM alpine\nARG X\nCOPY --from=$X /a /b\n', args: { X: VICTIM }, has: [`VARREF $X ${VICTIM}`] },
	{ name: 'ovr-resolves-meta', df: 'ARG BASE\nFROM $BASE\n', args: { BASE: 'node:22' }, has: ['IMG node:22'], not: ['UNRESOLVED'] },
	{ name: 'ovr-resolves-stage', df: 'FROM alpine\nARG X\nCOPY --from=$X /a /b\n', args: { X: 'node:22' }, has: ['IMG node:22'], not: ['UNRESOLVED'] },
	// a stage's ARGs end at the next FROM
	{ name: 'stage-reset', df: 'FROM alpine\nARG X=node:22\nFROM alpine\nCOPY --from=$X /a /b\n', has: ['UNRESOLVED $X', 'IMG node:22'] },
	// a build arg for an ARG that is not declared in scope does not resolve the ref, but is checked
	{ name: 'ovr-undeclared', df: 'FROM alpine\nCOPY --from=$X /a /b\n', args: { X: VICTIM }, has: ['UNRESOLVED $X', `IMG ${VICTIM}`] },
	// backstop: an ENV value of the same name is checked too
	{ name: 'env', df: `FROM alpine\nARG X=alpine\nENV X=${VICTIM}\nCOPY --from=$X /a /b\n`, has: ['VARREF $X alpine', `IMG ${VICTIM}`] },
	{ name: 'env-legacy', df: `FROM alpine\nARG X=alpine\nENV X ${VICTIM}\nCOPY --from=$X /a /b\n`, has: [`IMG ${VICTIM}`] },
	// a default is expanded at its line
	{ name: 'nested', df: 'ARG R=ghcr.io/victimorg\nARG B=$R/app:1\nFROM $B\n', has: ['IMG ghcr.io/victimorg/app:1'] },
	{ name: 'nested-unset', df: 'ARG B=$R/app:1\nARG R=ghcr.io/victimorg\nFROM $B\n', has: ['UNRESOLVED $B'], not: ['IMG ghcr.io/victimorg/app:1'] },
	{ name: 'default-form', df: 'FROM ${X:-node:22}\n', has: ['IMG node:22'] },
	// :+ gives its word when the name is set, nothing otherwise
	{ name: 'plus-form', df: 'ARG X=a\nFROM ${X:+node:22}\n', has: ['IMG node:22'] },
	{ name: 'plus-form-unset', df: 'ARG X\nFROM ${X:+node:22}\n', has: ['UNRESOLVED ${X:+node:22}'] },
	// nested defaults (resolved by the earlier parser too)
	{ name: 'nested-default', df: 'ARG A\nARG B=node:22\nFROM ${A:-${B}}\n', has: ['IMG node:22'], not: ['UNRESOLVED', 'IMG node:22}'] },
	{ name: 'nested-default-set', df: 'ARG A=node:22\nARG B=x\nFROM ${A:-${B}}\n', has: ['IMG node:22'], not: ['UNRESOLVED', 'IMG node:22}'] },
	{ name: 'nested-deep', df: 'ARG C=node:22\nFROM ${A:-${B:-${C}}}\n', has: ['IMG node:22'], not: ['UNRESOLVED'] },
	{ name: 'nested-unclosed', df: 'ARG B=node:22\nFROM ${A:-${B}\n', has: ['UNRESOLVED ${A:-${B}'] },
	// the ENV-from-ARG idiom is expanded at its line (it was refused as unresolved)
	{ name: 'envself', df: 'ARG NODE_VERSION=22\nFROM node:${NODE_VERSION}-alpine\nARG NODE_VERSION\nENV NODE_VERSION=${NODE_VERSION}\n', has: ['IMG node:22-alpine'], not: ['UNRESOLVED'] },
	{ name: 'envself2', df: 'ARG NODE_VERSION=22\nFROM node:${NODE_VERSION}-alpine AS b\nENV NODE_VERSION=$NODE_VERSION\nFROM node:${NODE_VERSION}-alpine\n', has: ['IMG node:22-alpine'], not: ['UNRESOLVED'] },
	{ name: 'envself3', df: 'ARG PY=3.12\nFROM python:${PY}-slim\nARG PY\nENV PY=$PY\n', has: ['IMG python:3.12-slim'], not: ['UNRESOLVED'] },
	{ name: 'env-builder', df: 'FROM node:22 AS builder\nARG X=node:20\nENV X=$X\nFROM alpine\nARG X=node:20\nCOPY --from=$X /a /b\n', has: ['IMG node:20'], not: ['UNRESOLVED'] },
	{ name: 'env-chain', df: 'FROM alpine\nARG R=ghcr.io/victimorg\nENV X=$R/otherapp:1\nARG X=alpine\nCOPY --from=$X /a /b\n', has: ['IMG ghcr.io/victimorg/otherapp:1', 'IMG alpine'] },
	// an ENV value in scope is what BuildKit reads: a value with a space is refused
	{ name: 'env-space-legacy', df: 'FROM node:22 AS b\nARG X=b\nENV X b c\nCOPY --from=$X /a /a\n', has: ['AT 4 $X b c', 'REFUSE image ref $X has characters an image name cannot have (quotes, backslashes, spaces): write it plainly'] },
	// a backstop value (ENV below the line) that is no image name is skipped, not refused
	{ name: 'env-space-later', df: 'FROM node:22 AS b\nARG X=b\nCOPY --from=$X /a /a\nENV X b c\n', has: [], not: ['REFUSE', 'UNRESOLVED'] },
	{ name: 'env-space', df: 'FROM node:22 AS b\nARG X=b\nENV X="b c"\nCOPY --from=$X /a /a\n', has: [], not: ['REFUSE', 'UNRESOLVED'] },
	// an ENV form this parser cannot expand keeps its raw value: refs using it
	// are unresolved (BuildKit would expand it, and ENV wins over ARG)
	{ name: 'envpct', df: 'FROM alpine\nARG P=ghcr.io/victimorg/otherapp:latestZ\nARG X=alpine\nENV X=${P%Z}\nCOPY --from=$X /a /b\n', has: ['UNRESOLVED $X', 'AT 5 $X -'] },
	{ name: 'envq', df: 'FROM alpine\nARG P=ghcr.io/victimorg/otherapp:latest\nARG X=alpine\nENV X=${P:?e}\nCOPY --from=$X /a /b\n', has: ['UNRESOLVED $X', 'AT 5 $X -'] },
	// backstop: the raw value is kept for a ref anywhere that uses the name
	{ name: 'envpct-later', df: 'FROM alpine\nARG X=alpine\nCOPY --from=$X /a /b\nARG P=ghcr.io/victimorg/otherapp:latestZ\nENV X=${P%Z}\n', has: ['AT 3 $X alpine', 'UNRESOLVED $X'] },
	{ name: 'env-slash', df: 'FROM alpine\nARG P=a\nENV X=${P/a/b}\nCOPY --from=$X /a /b\n', has: ['UNRESOLVED $X'] },
	// a legitimately empty ENV value is dropped
	{ name: 'env-empty', df: 'FROM alpine\nARG X=node:22\nENV Y=${UNSET}\nCOPY --from=$X /a /b\n', has: ['IMG node:22'], not: ['UNRESOLVED'] },
	// bypass cases
	{ name: 'ev-p1', df: 'FROM --platform=$BUILDPLATFORM node:22 AS build\nRUN true\nFROM node:22-alpine\nCOPY --from=build /a /a\n', has: ['IMG node:22', 'IMG node:22-alpine'] },
	{ name: 'ev-p2', df: 'ARG X=node:22\nFROM --platform=$BUILDPLATFORM ${X}\n', has: ['IMG node:22'] },
	{ name: 'ev-p3', df: 'FROM --platform=$BUILDPLATFORM node:22 AS b\nARG TARGETARCH\nARG TARGETPLATFORM\nRUN echo $TARGETARCH\nFROM --platform=$TARGETPLATFORM gcr.io/distroless/nodejs22\nCOPY --from=b /a /a\n', has: ['IMG gcr.io/distroless/nodejs22'] },
	{ name: 'ev-reuse', df: 'ARG BASE=node:22\nFROM ${BASE} AS a\nFROM ${BASE} AS b\nARG BASE=other\nFROM ${BASE}\n', has: ['IMG node:22', 'IMG other'] },
	{ name: 'ev-twovar', df: 'ARG BASE=node\nARG TAG=22\nFROM ${BASE}:${TAG}-alpine\n', has: ['IMG node:22-alpine'] },
	{ name: 'ev-multi', df: `FROM alpine\nCOPY --from=alpine --from=${VICTIM} /a /b\n`, has: [`IMG ${VICTIM}`] },
	{ name: 'ev-mount2', df: `FROM alpine\nRUN --mount=type=cache,target=/x --mount=from=${VICTIM},target=/m true\n`, has: [`IMG ${VICTIM}`] },
	{ name: 'ev-onbuild', df: `FROM alpine\nONBUILD COPY --from=${VICTIM} /a /b\n`, has: [`IMG ${VICTIM}`] },
	{ name: 'ev-shelltext', df: `FROM alpine\nRUN echo --from=${VICTIM}\n`, has: [`IMG ${VICTIM}`] },
	{ name: 'continued-mount', df: `FROM alpine\nARG X=${VICTIM}\nRUN --network=none \\\n  --mount=type=bind,from=$X,target=/m true\n`, has: [`IMG ${VICTIM}`, `AT 4 $X ${VICTIM}`] },
	// a variable naming a stage is the stage
	{ name: 'stage-var', df: 'FROM node:22 AS build\nFROM alpine\nARG S=build\nCOPY --from=$S /a /b\n', has: ['IMG node:22', 'IMG alpine'], not: ['IMG build'] },
	// an ONBUILD ARG runs in a child build: a backstop value, not in scope here
	{ name: 'onbuild-arg', df: 'FROM alpine\nONBUILD ARG X=node:22\nCOPY --from=$X /a /b\n', has: ['UNRESOLVED $X', 'IMG node:22'] },
	{ name: 'mount-scope', df: `FROM alpine\nARG X=${VICTIM}\nRUN --mount=type=bind,from=$X,target=/m true\nFROM alpine\nARG X=alpine\n`, has: [`IMG ${VICTIM}`] },
	{ name: 'continued', df: `ARG BASE=${VICTIM}\nFROM \\\n  \${BASE} AS b\nARG BASE=alpine\n`, has: [`IMG ${VICTIM}`] },
	// common shape: no variables
	{
		name: 'template',
		df: 'FROM node:22-alpine AS deps\nWORKDIR /app\nRUN yarn install --frozen-lockfile --network-timeout 300000\nFROM node:22-alpine AS builder\nCOPY --from=deps /app/node_modules ./node_modules\nFROM node:22-alpine AS runner\nCOPY --from=builder /app/.next ./.next\n',
		has: ['IMG node:22-alpine'],
		not: ['UNRESOLVED', 'VARREF'],
	},
	{ name: 'quoted-ref', df: 'ARG X="a b"\nFROM alpine\nCOPY --from=x$X /a /b\n', has: ['UNRESOLVED x$X'] },
]

describe('Dockerfile ARG scope (awk and TS twin, one table)', () => {
	for (const c of TABLE) {
		it(c.name, () => {
			const a = awkReport(c.df, c.args)
			// the twin also reports BASE and FROM-flag lines; this table compares the image-ref lines
			const t = dockerfileImageRefReport(c.df, c.args).filter((l) => /^(IMG|UNRESOLVED|VARREF|AT|REFUSE image ref) /.test(l))
			expect([...new Set(a)].sort(), 'awk vs TS').toEqual([...new Set(t)].sort())
			for (const h of c.has) expect(t, h).toContain(h)
			for (const x of c.not ?? []) expect(t.some((l) => l.startsWith(x)), x).toBe(false)
		})
	}
})

// each ref as resolved AT ITS LINE, before the backstop (so the backstop
// cannot hide a scope bug): the exact `AT <line> <ref> <resolved>` lines, awk and TS.
const AT_TABLE: { name: string; df: string; args?: Record<string, string>; at: string[] }[] = [
	{ name: 't1', df: `ARG BASE=${VICTIM}\nFROM \${BASE}\nRUN echo hi\nARG BASE=node:22-alpine\n`, at: [`AT 2 \${BASE} ${VICTIM}`] },
	{ name: 't2', df: `ARG BASE=${VICTIM}\nFROM alpine AS a\nARG BASE=alpine\nFROM $BASE\n`, at: ['AT 2 alpine alpine', `AT 4 $BASE ${VICTIM}`] },
	{
		name: 't3',
		df: `FROM alpine\nARG X=${VICTIM}\nCOPY --from=$X /app /stolen\nRUN --mount=type=bind,from=$X,target=/m cp -r /m /stolen2\nFROM alpine\nARG X=alpine\n`,
		at: ['AT 1 alpine alpine', `AT 3 $X ${VICTIM}`, `AT 4 $X ${VICTIM}`, 'AT 5 alpine alpine'],
	},
	{ name: 't4', df: 'ARG BASE=otherapp:latest\nFROM alpine AS a\nARG BASE\nFROM a\nARG BASE=node:22\nFROM ${BASE}\n', at: ['AT 2 alpine alpine', 'AT 4 a a', 'AT 6 ${BASE} otherapp:latest'] },
	{ name: 'stage scope', df: 'ARG X=node:20\nFROM alpine\nARG X=node:22\nCOPY --from=$X /a /b\nFROM ${X}\nCOPY --from=$X /a /b\nARG X\nCOPY --from=$X /a /b\n', at: ['AT 2 alpine alpine', 'AT 4 $X node:22', 'AT 5 ${X} node:20', 'AT 6 $X -', 'AT 8 $X node:20'] },
	{ name: 'build args', df: 'ARG B=alpine\nFROM $B\nARG X\nCOPY --from=$X /a /b\nCOPY --from=$Y /a /b\n', args: { B: 'node:22', X: 'node:20', Y: 'node:18' }, at: ['AT 2 $B node:22', 'AT 4 $X node:20', 'AT 5 $Y -'] },
	{ name: 'continued', df: 'ARG B=node:22\nFROM \\\n  # c\n  $B\n', at: ['AT 4 $B node:22'] },
	// ENV above the line wins over an ARG of the same name, below it does not count
	{ name: 'env over arg', df: 'FROM alpine\nARG X=node:20\nCOPY --from=$X /a /b\nENV X=node:22\nARG X=node:18\nCOPY --from=$X /a /b\nFROM alpine\nARG X=node:16\nCOPY --from=$X /a /b\n', at: ['AT 1 alpine alpine', 'AT 3 $X node:20', 'AT 6 $X node:22', 'AT 7 alpine alpine', 'AT 9 $X node:16'] },
]

describe('refs resolved at their line, without the backstop (awk and TS)', () => {
	for (const c of AT_TABLE) {
		it(c.name, () => {
			const at = (l: string[]) => l.filter((x) => x.startsWith('AT ')).sort()
			expect(at(awkReport(c.df, c.args)), 'awk').toEqual([...c.at].sort())
			expect(at(dockerfileImageRefReport(c.df, c.args)), 'TS').toEqual([...c.at].sort())
		})
	}
})

describe('the deploy refuses these cases on the server (dfr_one, registry login)', () => {
	const bin = join(root, 'bin')
	mkdirSync(bin)
	writeFakeDocker(bin, '#!/bin/bash\nexit 1\n')
	const dc = join(root, 'dc')
	mkdirSync(dc)
	writeFileSync(join(dc, 'config.json'), '{"auths":{"ghcr.io":{"auth":"eDp5"}}}')
	const run = (df: string) => {
		const dir = join(root, `d${++n}`)
		mkdirSync(dir)
		writeFileSync(join(dir, 'Dockerfile'), df)
		const script = `DFR_NS=${NS}; DFR_APP=demoapp; DFR_DIR=$(mktemp -d); DFR_MODE=warn; DFR_PULL=1; DFR_OWN=''; ${dockerfileAuthorityShell({ self: 'demoapp', foreign: [], others: ['otherapp'], loginHosts: ['ghcr.io'] })}${dockerfileRewriteFunctions('demoapp')}dfr_one ${JSON.stringify(join(dir, 'Dockerfile'))} ${JSON.stringify(join(dir, 'out'))}`
		const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_CONFIG: dc } })
		return { code: r.status, log: r.stdout + r.stderr, out: existsSync(join(dir, 'out')) }
	}
	it('t1 and t3 (login rule) and the unresolved scope cases refuse in warn mode too', () => {
		for (const name of ['t1', 't2', 't3', 'meta-unset', 'arg-after-use', 'meta-not-in-stage', 'onbuild-arg', 'envpct', 'envq', 'env']) {
			const c = TABLE.find((x) => x.name === name) as Case
			const r = run(c.df)
			expect(r.code, `${name}: ${r.log}`).not.toBe(0)
			expect(r.log, name).toContain('refused in every guard mode')
		}
	})
	it('a ghcr ref named after another registered app gets the every-mode login refusal, not a warn-mode WARN', () => {
		const r = run('FROM ghcr.io/victimorg/otherapp:1\n')
		expect(r.code, r.log).not.toBe(0)
		expect(r.log).toContain('refused in every guard mode')
		expect(dockerfileImageForeign('ghcr.io/victimorg/otherapp:1', { self: 'demoapp', foreign: [], others: ['otherapp'], loginHosts: ['ghcr.io'] })).toContain('where root is logged in')
	})
	it('t4 (another registered app on Docker Hub) is a dockerfile_image finding', () => {
		const r = run((TABLE.find((x) => x.name === 't4') as Case).df)
		expect(r.log).toContain('otherapp:latest')
	})
	it('a common template, the ENV-from-ARG idiom and nested defaults pass (warn and login known)', () => {
		for (const name of ['template', 'envself', 'envself2', 'envself3', 'env-builder', 'nested-default', 'nested-default-set', 'ev-p3', 'ev-twovar']) {
			const r = run((TABLE.find((x) => x.name === name) as Case).df)
			expect(r.code, `${name}: ${r.log}`).toBe(0)
		}
	})
})
