import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DOCKERFILE_REWRITE_AWK, dockerfileImageRefReport, SYNTAX_ALLOWED_ERE } from '../build-cache'
import { CONT_MUST_READ, CONT_MUST_REFUSE, FROMREF_MUST_REFUSE, HEREDOC_MUST_READ, HEREDOC_MUST_REFUSE } from './fixtures/dockerfile-cases'

// The awk (DOCKERFILE_REWRITE_AWK, the authority on the server) and its TS twin
// (dockerfileImageRefReport) on every Dockerfile of the continuation, heredoc and FROM ref
// tables plus the sample Dockerfiles in fixtures/dockerfiles. Compared, for every case:
// - the image lines IMG <ref>, BASE <k> <ref>, UNRESOLVED <ref>, VARREF <ref> <resolved>,
//   in order;
// - the refusals of the image-ref pass (TWIN_REFUSALS, the only ones the TS twin writes):
//   the same lines in both. Every TS refusal is also an awk refusal.
// Intentional differences (the TS twin reads plain syntax: escape \, no heredocs):
// - the awk's other refusals (heredoc forms, Unicode spaces, control bytes, escape
//   directives, glued flags or keywords, two escape characters, ADD sources, RUN flags)
//   have no TS twin; the image lines still have to agree there.
// - a FROM inside a heredoc body: the awk refuses it and writes no BASE line for it (no
//   pin is needed, the build never runs), the TS twin reads it as a stage. BASE lines are
//   left out when the awk wrote that refusal; IMG lines are still compared.

const root = mkdtempSync(join(tmpdir(), 'parity-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0

const AWKS = ['awk', 'mawk', 'gawk'].filter((b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0)

function awkReport(df: string, bin: string): string[] {
	const dir = join(root, `p${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), df)
	writeFileSync(join(dir, 'rp'), '')
	const r = spawnSync(bin, [DOCKERFILE_REWRITE_AWK, join(dir, 'Dockerfile')], {
		encoding: 'utf8',
		env: { ...process.env, LC_ALL: 'C', DFR_NS: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', DFR_APP: 'shop', DFR_TF: join(dir, 'tf'), DFR_RP: join(dir, 'rp'), DFR_ARGF: '', DFR_SYNTAX: SYNTAX_ALLOWED_ERE },
	})
	expect(r.status, r.stderr).toBe(0)
	return readFileSync(join(dir, 'rp'), 'utf8').split('\n').filter(Boolean)
}

// the refusals the TS twin writes (the image-ref pass)
const TWIN_REFUSALS = /^REFUSE (image ref |an image ref that uses|a stage index|a FROM image ref that does not resolve|a FROM flag other than|a value for the build platform ARG|a build arg for the build platform ARG)/
const HEREDOC_FROM = /^REFUSE a FROM line inside a heredoc body/
const imageLines = (l: string[], base: boolean) => l.filter((x) => /^(IMG|UNRESOLVED|VARREF) /.test(x) || (base && /^BASE \d+ /.test(x)))
const refusals = (l: string[]) => l.filter((x) => x.startsWith('REFUSE'))

const FIXTURES = join(__dirname, 'fixtures', 'dockerfiles')
const CASES: Array<[string, string]> = [
	...CONT_MUST_REFUSE.map(([k, df]): [string, string] => [`continuation refuse: ${k}`, df]),
	...CONT_MUST_READ.map(([k, df]): [string, string] => [`continuation read: ${k}`, df]),
	...HEREDOC_MUST_REFUSE.map(([k, df]): [string, string] => [`heredoc refuse: ${k}`, df]),
	...HEREDOC_MUST_READ.map(([k, df]): [string, string] => [`heredoc read: ${k}`, df]),
	...FROMREF_MUST_REFUSE.map(([k, df]): [string, string] => [`from-ref refuse: ${k}`, df]),
	...readdirSync(FIXTURES)
		.filter((f) => f.endsWith('.df'))
		.sort()
		.map((f): [string, string] => [`fixture ${f}`, readFileSync(join(FIXTURES, f), 'utf8')]),
]

describe('the awk and its TS twin report the same image refs', () => {
	it('has an awk and cases to run', () => {
		expect(AWKS.length).toBeGreaterThan(0)
		expect(CASES.length).toBeGreaterThan(100)
	})
	for (const bin of AWKS) {
		for (const [name, df] of CASES) {
			it(`${bin}: ${name}`, () => {
				const a = awkReport(df, bin)
				const t = dockerfileImageRefReport(df)
				const aRef = refusals(a)
				const tRef = refusals(t)
				for (const x of tRef) expect(aRef).toContain(x)
				expect(tRef).toEqual(aRef.filter((x) => TWIN_REFUSALS.test(x)))
				const base = !aRef.some((x) => HEREDOC_FROM.test(x))
				expect(imageLines(t, base)).toEqual(imageLines(a, base))
			})
		}
	}
})
