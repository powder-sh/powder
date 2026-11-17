import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// class guard: data must never become PROGRAM TEXT of sed / awk / grep /
// find -regex in the shell powder generates and runs as root. `sed "s@^$PG_DIR/@@"`
// put a compose-controlled path into a sed program (GNU sed `e` runs a command).
// Data belongs in a quoted FILE argument, an `awk -v` value, an environment
// variable, or shell parameter expansion; never in the program.
//
// The scan reads every non-test .ts file under src/lib, finds sed/awk/grep (and
// find -regex) in string literals, takes the program argument (the first operand
// after the options, or the -e value) and flags it when it holds:
//   - a shell expansion ($x, ${x}, $(..)) outside single quotes, or
//   - a TS interpolation `${...}` that is not `${shq(...)}`.
// Static cases that are known safe are listed in ALLOW with the reason; an allow
// entry that no longer matches anything fails the test too, so the list stays true.

const LIB = join(__dirname, '..')

type Hit = { file: string; line: number; cmd: string; program: string; text: string }

const ALLOW: { file: string; contains: string; why: string }[] = [
	{ file: 'backup-script.ts', contains: 'sed -n "\\${i}p"', why: 'integer loop counter' },
	{
		file: 'build-cache.ts',
		contains: 'awk "$DFR_AWK"',
		why: 'program is a shq() constant held in a shell var',
	},
	{
		file: 'build-cache.ts',
		contains: 'awk "$DFR_FOREIGN_AWK"',
		why: 'program is a shq() constant held in a shell var; the ref is stdin, the lists env',
	},
	{
		file: 'crontab.ts',
		contains: '"$SYSD_NOISE"',
		why: 'static literal regex held in a shell var',
	},
	{
		file: 'fragments.ts',
		contains: 'awk ${awk}',
		why: 'awk = shq(COMPOSE_JSON_MOUNTS_AWK), a constant',
	},
	{
		file: 'target-links.ts',
		contains: 'awk ${awk}',
		why: 'awk = shq(COMPOSE_JSON_MOUNTS_AWK), a constant',
	},
	{
		file: 'target-links.ts',
		contains: 'awk "$TL_AWK"',
		why: 'TL_AWK is shq(TARGET_LINK_AWK), a constant passed in the environment; the data is stdin',
	},
	{
		file: 'target-links.ts',
		contains: '"$TL_BATCH_AWK"',
		why: 'TL_BATCH_AWK is shq(TARGET_LINK_BATCH_AWK), a constant passed in the environment; the data is stdin and -v file paths',
	},
	{
		file: 'fragments.ts',
		contains: 'grep ${pathLine}',
		why: 'pathLine is a static single-quoted regex',
	},
	{
		file: 'fragments.ts',
		contains: 'grep -v ${pathLine}',
		why: 'pathLine is a static single-quoted regex',
	},
	{ file: 'fragments.ts', contains: `grep -q "$(printf '\\r')"`, why: 'a static CR byte' },
	{
		file: 'self-deploy.ts',
		contains: 'grep -qx ${w}',
		why: 'w = shq(workerSvc), operator config (same as the inline shq form below it)',
	},
	{
		file: 'git-harden.ts',
		contains: 'grep -vqE "$__pgre"',
		why: '__pgre is set from shq() constants on the line above',
	},
	{
		file: 'server-bootstrap.ts',
		contains: 'grep -Eq ":$p\\\\$"',
		why: '$p is the static loop list 80 443',
	},
]

function walk(dir: string, out: string[] = []): string[] {
	for (const n of readdirSync(dir)) {
		const p = join(dir, n)
		if (n === '__tests__' || n === 'node_modules') continue
		if (statSync(p).isDirectory()) walk(p, out)
		else if (n.endsWith('.ts') && !n.endsWith('.test.ts') && !n.endsWith('.d.ts')) out.push(p)
	}
	return out
}

/** One shell word starting at i: quoted segments, unquoted chars and TS `${...}` units. */
function readWord(s: string, i: number): { word: string; end: number } {
	let j = i
	while (j < s.length) {
		const c = s[j] ?? ''
		if (
			/\s/.test(c) ||
			c === '|' ||
			c === ';' ||
			c === '&' ||
			c === ')' ||
			c === '`' ||
			c === '<' ||
			c === '>'
		)
			break
		if (c === '$' && s[j + 1] === '{' && s[j - 1] !== '\\') {
			let depth = 0
			for (; j < s.length; j++) {
				if (s[j] === '{') depth++
				else if (s[j] === '}' && --depth === 0) break
			}
			j++
			continue
		}
		if (c === "'" || c === '"') {
			const close = s.indexOf(c, j + 1)
			j = close === -1 ? s.length : close + 1
			continue
		}
		j++
	}
	return { word: s.slice(i, j), end: j }
}

const OPTS_WITH_ARG: Record<string, string[]> = {
	sed: ['-f', '-l'],
	awk: ['-v', '-F', '-f'],
	grep: ['-f', '-m', '-A', '-B', '-C', '--color'],
}

/** The program operand of the command whose name ends at i, or null. */
function programOf(cmd: string, s: string, i: number): string | null {
	const base = cmd === 'gawk' ? 'awk' : cmd === 'egrep' ? 'grep' : cmd
	let j = i
	for (;;) {
		while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++
		if (j >= s.length) return null
		const { word, end } = readWord(s, j)
		if (!word) return null
		j = end
		if (word === '--') {
			while (j < s.length && s[j] === ' ') j++
			return readWord(s, j).word || null
		}
		if (word.startsWith('-')) {
			// grep -F: the operand is a fixed string, not a program or regex
			if (base === 'grep' && (/^-[A-Za-z]*F/.test(word) || word === '--fixed-strings')) return null
			if (word === '-e' && base !== 'awk') {
				while (j < s.length && s[j] === ' ') j++
				return readWord(s, j).word || null
			}
			if ((OPTS_WITH_ARG[base] ?? []).includes(word)) {
				while (j < s.length && s[j] === ' ') j++
				j = readWord(s, j).end
			}
			continue
		}
		return word
	}
}

/** Why a program word carries data, or null when it is static. */
function dataInProgram(program: string): string | null {
	// TS interpolation that is not an escaped shell `\${`
	for (const m of program.matchAll(/(?<!\\)\$\{([^}]*)\}/g)) {
		if (!/^shq\(/.test(m[1] ?? '')) return `TS interpolation \${${m[1]}}`
	}
	// shell expansion outside single quotes
	let q: string | null = null
	for (let k = 0; k < program.length; k++) {
		const c = program[k] ?? ''
		if (q === "'") {
			if (c === "'") q = null
			continue
		}
		if (c === "'" && q === null) {
			q = "'"
			continue
		}
		if (c === '"') {
			q = q === '"' ? null : '"'
			continue
		}
		if (c === '$' && /[A-Za-z_{(0-9@*#?!$-]/.test(program[k + 1] ?? '')) {
			// a TS `${shq(..)}` already passed above; the shq output is a single-quoted word
			if (program[k + 1] === '{' && program[k - 1] !== '\\') continue
			return 'shell expansion outside single quotes'
		}
	}
	return null
}

/** Scan one source text (also used by the self-test below). */
function scanSource(file: string, src: string): Hit[] {
	const hits: Hit[] = []
	const lines = src.split('\n')
	lines.forEach((raw, idx) => {
		const t = raw.trim()
		if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
		// TS `\'` and `\"` are shell quotes inside TS single/double-quoted strings
		const line = raw.replace(/\\'/g, "'").replace(/\\"/g, '"')
		for (const m of line.matchAll(/(?:^|[\s|;(`'"&])(sed|awk|gawk|grep|egrep)(?=\s)/g)) {
			const cmd = m[1] ?? ''
			const end = (m.index ?? 0) + m[0].length
			const program = programOf(cmd, line, end)
			if (!program) continue
			const why = dataInProgram(program)
			if (why) hits.push({ file, line: idx + 1, cmd, program, text: `${why}: ${t.slice(0, 200)}` })
		}
		for (const m of line.matchAll(/\s-i?regex\s+/g)) {
			const program = readWord(line, (m.index ?? 0) + m[0].length).word
			const why = dataInProgram(program)
			if (why)
				hits.push({
					file,
					line: idx + 1,
					cmd: 'find -regex',
					program,
					text: `${why}: ${t.slice(0, 200)}`,
				})
		}
	})
	return hits
}

function allowed(h: Hit, raw: string): (typeof ALLOW)[number] | undefined {
	return ALLOW.find(
		(a) => h.file.endsWith(a.file) && raw.includes(a.contains) && a.contains.includes(h.program),
	)
}

describe('no data in sed/awk/grep/find -regex program text (generated shell)', () => {
	it('every program argument under src/lib is static or allow-listed', () => {
		const used = new Set<string>()
		const bad: string[] = []
		for (const f of walk(LIB)) {
			const src = readFileSync(f, 'utf8')
			const lines = src.split('\n')
			for (const h of scanSource(relative(LIB, f), src)) {
				const a = allowed(h, lines[h.line - 1] ?? '')
				if (a) used.add(a.contains)
				else bad.push(`${h.file}:${h.line} ${h.cmd} program ${h.program} - ${h.text}`)
			}
		}
		expect(bad).toEqual([])
		expect(ALLOW.map((a) => a.contains).filter((c) => !used.has(c))).toEqual([])
	})

	it('flags a preflight sed line with a data path in its program, and shapes like it', () => {
		const old =
			'`    PG_FIRST=$(printf \'%s\\\\n\' "$PG_HITS" | head -1 | sed "s@^$PG_DIR/@@"); ` +'
		expect(scanSource('script.ts', old).map((h) => h.program)).toEqual(['"s@^$PG_DIR/@@"'])
		expect(scanSource('x.ts', '`sed -e "s/${name}/x/" f`')).toHaveLength(1)
		expect(scanSource('x.ts', '`grep -q -- "$NEEDLE" f`')).toHaveLength(1)
		expect(scanSource('x.ts', '`grep -qx "$SVC"`')).toHaveLength(1)
		expect(scanSource('x.ts', '`grep -qxF -- "$SVC"`')).toHaveLength(0)
		expect(scanSource('x.ts', "`awk -v svc=${shq(s)} '/x/{print $1}' f`")).toHaveLength(0)
		expect(scanSource('x.ts', '`awk -v svc="$S" ${shq(PROG)} f`')).toHaveLength(0)
		expect(scanSource('x.ts', '`find . -regex ".*/$X"`')).toHaveLength(1)
		expect(scanSource('x.ts', '`sed -n 1p; grep -c \'^x\' "$F"`')).toHaveLength(0)
	})

	it('the current preflight strips the prefix with parameter expansion, not sed', () => {
		const src = readFileSync(join(LIB, 'deploy', 'script.ts'), 'utf8')
		expect(src).not.toMatch(/sed "s@\^\$PG_DIR/)
		expect(src).toContain('PG_FIRST="\\${PG_FIRST#"$PG_DIR"/}"')
	})
})
