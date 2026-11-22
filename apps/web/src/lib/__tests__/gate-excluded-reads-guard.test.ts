// powder's push gate and its test gate copy the tree without docker-compose.yml,
// docker-compose.powder.yml, *.env and .env* (infra handbook hooks/powder-gate.sh
// EXCLUDES; lib/testgate copy). A test that reads one of those committed files fails
// there with ENOENT and blocks every push. Each such read must be in .powder/test.sh's
// skip list or sit behind an existsSync check (it.skipIf(!existsSync(...))).
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB = join(__dirname, '../../..')
const REPO = join(WEB, '../..')

/** True for a path the gate copy leaves out (a literal's last path segment). */
function gateExcluded(path: string): boolean {
	const base = path.split('/').pop() ?? ''
	return (
		base === 'docker-compose.yml' ||
		base === 'docker-compose.powder.yml' ||
		base.startsWith('.env') ||
		base.endsWith('.env')
	)
}

/** Lines (1-based) of `src` that read a gate-excluded file of the repo itself, with no
 *  existsSync guard. A repo read is a line with an excluded literal and a join( or
 *  resolve( on __dirname or on a path built that way (REPO, ROOT, BIN), or a call of a
 *  helper that joins on one (read('docker-compose.yml')). join(dir, '.env') on a temp
 *  dir is not a repo read. Paths that reach the read through a variable (a loop over a
 *  list of names) are not seen: such files belong in the .powder/test.sh skip list. */
function unguardedRepoReads(src: string): number[] {
	const lines = src.split('\n')
	const anchors = new Set(['__dirname'])
	const helpers = new Set<string>()
	const onAnchor = () => new RegExp(`\\b(?:join|resolve)\\(\\s*(?:${[...anchors].join('|')})\\b`)
	for (let grew = true; grew; ) {
		grew = false
		for (const l of lines) {
			const m = l.match(/\b(?:const|let)\s+(\w+)\s*=\s*(.*)$/)
			if (!m || anchors.has(m[1]) || helpers.has(m[1])) continue
			const arrow = /^(?:\([^)]*\)|\w+)\s*=>/.test(m[2])
			// a path (REPO = join(__dirname, ...)) or a helper that joins on one
			const at = m[2].search(onAnchor())
			if (at === -1 || (!arrow && at !== 0)) continue
			;(arrow ? helpers : anchors).add(m[1])
			grew = true
		}
	}
	const helperCall = helpers.size ? new RegExp(`\\b(?:${[...helpers].join('|')})\\(`) : /$^/
	const out: number[] = []
	lines.forEach((l, i) => {
		if (![...l.matchAll(/(['"`])((?:\\.|(?!\1).)*?)\1/g)].some((m) => gateExcluded(m[2]))) return
		const name = l.match(/\b(?:const|let)\s+(\w+)\s*=\s*(?:join|resolve)\(/)?.[1]
		const read =
			/\b(?:readFileSync|readFile|cpSync|copyFileSync|createReadStream|l?statSync|openSync)\(/.test(
				l,
			)
		// a read on the repo path, a helper read, or a repo path kept for a later read
		if (!((read || name) && onAnchor().test(l)) && !helperCall.test(l)) return
		if (/\bexistsSync\(/.test(l)) return
		if (name && new RegExp(`\\bexistsSync\\(\\s*${name}\\s*\\)`).test(src)) return
		out.push(i + 1)
	})
	return out
}

/** Test files .powder/test.sh skips when the excluded files are missing. */
function skipList(): Set<string> {
	const sh = readFileSync(join(REPO, '.powder/test.sh'), 'utf8')
	const m = sh.match(/for t in ([\s\S]*?); do/)
	if (!m) throw new Error('.powder/test.sh: no `for t in ...; do` skip list')
	return new Set(
		m[1]
			.replace(/\\\n/g, ' ')
			.split(/\s+/)
			.filter(Boolean)
			.map((t) => `src/lib/__tests__/${t}.test.ts`),
	)
}

function testFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory()
			? testFiles(join(dir, e.name))
			: e.name.endsWith('.test.ts')
				? [join(dir, e.name)]
				: [],
	)
}

describe('tests that read gate-excluded files', () => {
	it('the scanner flags repo reads and spares temp-dir fixtures and guarded reads', () => {
		const flagged = (s: string) => unguardedRepoReads(s).length > 0
		expect(
			flagged(
				"const REPO = join(__dirname, '../../../../..')\nreadFileSync(join(REPO, 'docker-compose.yml'))",
			),
		).toBe(true)
		expect(
			flagged("readFileSync(join(__dirname, '../../../../../docker-compose.yml'), 'utf8')"),
		).toBe(true)
		expect(
			flagged(
				"const ROOT = resolve(__dirname, '..')\nconst read = (p) => readFileSync(join(ROOT, p))\nread('docker-compose.yml')",
			),
		).toBe(true)
		expect(
			flagged(
				"const r = run(join(__dirname, 'x'))\nconfigFile: '/opt/apps/shop/docker-compose.yml',",
			),
		).toBe(false)
		expect(
			flagged(
				"const BIN = resolve(__dirname, '../bin')\nreadFileSync(resolve(BIN, '../docker-compose.powder.yml'))",
			),
		).toBe(true)
		expect(
			flagged(
				"const dir = mkdtempSync(join(tmpdir(), 'x'))\nreadFileSync(join(dir, 'docker-compose.yml'))",
			),
		).toBe(false)
		expect(
			flagged(
				"const root = resolve(__dirname, '..')\nwriteFileSync(join(root, 'secret.env'), 'x')",
			),
		).toBe(false)
		expect(
			flagged("writeFileSync(join(root, '.env'), 'A=1')\nwriteFileSync('/opt/apps/x.env', '')"),
		).toBe(false)
		expect(
			flagged(
				"const REPO = join(__dirname, '..')\nconst C = join(REPO, 'docker-compose.yml')\nreadFileSync(C)",
			),
		).toBe(true)
		expect(
			flagged(
				"const REPO = join(__dirname, '..')\nconst C = join(REPO, 'docker-compose.yml')\nit.skipIf(!existsSync(C))('x', () => {})",
			),
		).toBe(false)
		expect(
			flagged(
				"const REPO = join(__dirname, '..')\nif (existsSync(join(REPO, '.env.example'))) readFileSync(join(REPO, '.env.example'))",
			),
		).toBe(false)
		expect(
			flagged(
				"const REPO = join(__dirname, '..')\nreadFileSync(join(REPO, 'docker/powder.env.example'))",
			),
		).toBe(false)
	})

	it('every unguarded read is in the .powder/test.sh skip list', () => {
		const skip = skipList()
		for (const f of skip)
			expect(
				testFiles(join(WEB, 'src')).map((t) => relative(WEB, t)),
				`stale skip entry ${f}`,
			).toContain(f)
		const bad = testFiles(join(WEB, 'src')).flatMap((f) => {
			const rel = relative(WEB, f)
			if (skip.has(rel)) return []
			return unguardedRepoReads(readFileSync(f, 'utf8')).map((n) => `${rel}:${n}`)
		})
		expect(
			bad,
			'reads a file the gate copy leaves out: guard it with it.skipIf(!existsSync(...)) or add it to .powder/test.sh',
		).toEqual([])
	})
})
