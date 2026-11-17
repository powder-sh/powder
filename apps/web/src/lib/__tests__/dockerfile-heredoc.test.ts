import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DOCKERFILE_REWRITE_AWK, SYNTAX_ALLOWED_ERE } from '../build-cache'
import { HEREDOC_BODY as BODY, HEREDOC_MUST_READ as MUST_READ, HEREDOC_MUST_REFUSE as MUST_REFUSE } from './fixtures/dockerfile-cases'

// Heredocs as BuildKit reads them (frontend/dockerfile/parser/parser.go heredocsFromLine,
// reHeredoc ^(\d*)<<(-?)\s*([^<]*)$; shell/lex.go processPossibleHeredoc). BuildKit splits
// the joined RUN / COPY / ADD line into shell words (quotes, backslash escapes, ${...},
// Unicode spaces, blanks right after << kept in the word) and reads every word that
// matches the regex as a marker; its body runs to the first line equal to the name
// (leading tabs dropped for <<-), the markers of one line in order. The awk accepts only
// [0-9]*<<[-]NAME, <<"NAME" and <<'NAME' (NAME: [A-Za-z_][A-Za-z0-9_]*) as a whole word
// outside quotes: any other << on such a line is refused, so a body this parser misses
// can never be read as instructions. Invented names only.

const root = mkdtempSync(join(tmpdir(), 'hd-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0

// every awk on this machine (servers run gawk or mawk)
const AWKS = ['awk', 'mawk', 'gawk'].filter((b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0)

function report(df: string, bin: string): string[] {
	const dir = join(root, `h${++n}`)
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

describe('Dockerfile heredocs (BuildKit semantics)', () => {
	it('has an awk to run', () => expect(AWKS.length).toBeGreaterThan(0))
	for (const bin of AWKS) {
		for (const [name, df] of MUST_REFUSE) {
			it(`${bin}: refuses ${name}`, () => {
				expect(refusals(report(df, bin)).length).toBeGreaterThan(0)
			})
		}
		for (const [name, df, b] of MUST_READ) {
			it(`${bin}: reads ${name}`, () => {
				const l = report(df, bin)
				expect(refusals(l)).toEqual([])
				expect(bases(l)).toEqual(b)
			})
		}
		it(`${bin}: names the heredoc marker in the refusal`, () => {
			expect(refusals(report(`FROM alpine\nRUN cat << EOF${BODY}`, bin)).some((x) => x.includes('heredoc marker'))).toBe(true)
		})
		it(`${bin}: names the Unicode space in the refusal`, () => {
			expect(refusals(report('FROM alpine\nCOPY a b /x\n', bin)).some((x) => x.includes('Unicode space'))).toBe(true)
		})
	}
})
