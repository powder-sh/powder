import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DOCKERFILE_REWRITE_AWK, SYNTAX_ALLOWED_ERE } from '../build-cache'
import { CONT_MUST_READ as MUST_READ, CONT_MUST_REFUSE as MUST_REFUSE } from './fixtures/dockerfile-cases'

// Line continuation as BuildKit reads it (frontend/dockerfile/parser/parser.go): a line
// continues when its last non-blank character is the escape character and the one before
// it is not (or the escape character stands alone on the line); a continued line keeps its
// leading whitespace; comment lines and blank lines inside a continuation are skipped. A
// line ending in two or more escape characters is refused (older frontends read it
// differently), and so is a RUN flag glued to a continuation (rewrite() reads the
// physical line). Every Dockerfile here must be refused, or read with exactly the
// instructions BuildKit sees. Invented names only.

const root = mkdtempSync(join(tmpdir(), 'cont-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0

// every awk on this machine (servers run gawk or mawk)
const AWKS = ['awk', 'mawk', 'gawk'].filter((b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0)

function report(df: string, bin: string): string[] {
	const dir = join(root, `c${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), df)
	const rp = join(dir, 'rp')
	writeFileSync(rp, '')
	const r = spawnSync(bin, [DOCKERFILE_REWRITE_AWK, join(dir, 'Dockerfile')], {
		encoding: 'utf8',
		env: {
			...process.env,
			LC_ALL: 'C',
			DFR_NS: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
			DFR_APP: 'shop',
			DFR_TF: join(dir, 'tf'),
			DFR_RP: rp,
			DFR_ARGF: '',
			DFR_SYNTAX: SYNTAX_ALLOWED_ERE,
		},
	})
	expect(r.status).toBe(0)
	return readFileSync(rp, 'utf8').split('\n').filter(Boolean)
}
const refusals = (l: string[]) => l.filter((x) => x.startsWith('REFUSE'))
const bases = (l: string[]) => l.filter((x) => x.startsWith('BASE ')).map((x) => x.replace(/^BASE \d+ /, ''))
const imgs = (l: string[]) => l.filter((x) => x.startsWith('IMG ')).map((x) => x.slice(4))

describe('Dockerfile line continuation (BuildKit semantics)', () => {
	it('has an awk to run', () => expect(AWKS.length).toBeGreaterThan(0))
	for (const bin of AWKS) {
		for (const [name, df] of MUST_REFUSE) {
			it(`${bin}: refuses ${name}`, () => {
				expect(refusals(report(df, bin)).length).toBeGreaterThan(0)
			})
		}
		for (const [name, df, b, i] of MUST_READ) {
			it(`${bin}: reads ${name}`, () => {
				const l = report(df, bin)
				expect(refusals(l)).toEqual([])
				expect(bases(l)).toEqual(b)
				expect(imgs(l)).toEqual(i)
			})
		}
		it(`${bin}: a double backslash ends the line, so the FROM after it is an instruction`, () => {
			const l = report('FROM alpine\nRUN echo x\\\\\nFROM evil:1\n', bin)
			expect(refusals(l).length).toBeGreaterThan(0)
			expect(bases(l)).toEqual(['alpine', 'evil:1'])
		})
		it(`${bin}: a continued line keeps its leading whitespace`, () => {
			const l = report('FROM alpine\nADD --chown=0\\\n\tgit@github.com:org/priv.git /x\n', bin)
			expect(refusals(l).some((x) => x.includes('git remote'))).toBe(true)
		})
	}
})
