// guard: every API route that reads deploy text (deploys.output, deploys.error,
// deploys.error_summary, deploys.failed_step, or windows of them from a lib module) must
// return it only through the read-side redactor (redactNullable / redactSecrets /
// SecretStreamRedactor from lib/secret-text).
//
// Every route detected as a reader must be listed in READERS with the check for what it
// returns: for a response object, each entry (spreads included) whose value touches deploy
// text must BE a masking expression, and the listed fields must be returned. A new reader
// fails until it is added here with its fields. "Calls a redactor somewhere in the file"
// is not enough: a raw spread or one raw branch next to a masked one would pass that.
// A route that sends rows of an unprojected `db.select().from(deploys)` into a json response
// fails too, as does reading a deploy-text lib module through a dynamic import().
//
// Not caught (left on purpose, the cost is out of line with the risk): raw SQL against
// deploys in a NEW lib module that a route then calls (only DEPLOY_TEXT_MODULES and the
// route's own SQL count); deploy text passed through a helper in another file before it is
// returned; a response built without Response.json / NextResponse.json (a hand-made
// `new Response(JSON.stringify(...))`); and text smuggled into a key whose value does not
// name a text column (for example a template string of a renamed variable).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..')
const APP = join(SRC, 'app')

function files(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) out.push(...files(p))
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p)
	}
	return out
}

// ── reader detection ────────────────────────────────────────────────────────

/** Each import of `src` (a file at `file`, absolute): its names and the module it resolves
 *  to, as a path under src/ without extension ('lib/db'), whatever the quotes or the path
 *  style ('@/lib/db', '../../lib/db'). Bare package imports keep their name. */
function imports(src: string, file: string): { names: string; module: string }[] {
	const out: { names: string; module: string }[] = []
	const found = [
		...[...src.matchAll(/import\s+(type\s+)?([^'"]*?)\s*from\s*(['"])([^'"]+)\3/g)].map((m) => ({ names: m[2] ?? '', spec: m[4] as string })),
		// dynamic import('...'): its names are whatever the caller destructures
		...[...src.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => ({ names: '*', spec: m[2] as string })),
	]
	for (const { names, spec } of found) {
		let module = spec
		if (spec.startsWith('@/')) module = spec.slice(2)
		else if (spec.startsWith('.')) module = relative(SRC, resolve(dirname(file), spec))
		out.push({ names, module: module.replace(/\.(ts|tsx|js)$/, '').replace(/\/index$/, '') })
	}
	return out
}

// lib modules that hand out raw deploy text (windows of output/error, error_summary,
// failed_step) for a route to mask: importing one makes the route a deploy-text reader.
const DEPLOY_TEXT_MODULES = new Set(['lib/project-deploys-db'])
const TEXT_COLUMN = '(?:output|error|errorSummary|failedStep)'

/** Names that can hold a deploy row: arrow and map parameters, and consts assigned from a
 *  query (`const x = await db...`, `const [x] = await tx...`), whatever they are called. */
function rowNames(src: string): string[] {
	const names = new Set<string>()
	for (const m of src.matchAll(/\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*=>|\b([A-Za-z_$][\w$]*)\s*=>/g)) names.add((m[1] ?? m[2]) as string)
	for (const m of src.matchAll(/\bconst\s+(?:\[\s*([A-Za-z_$][\w$]*)[^\]]*\]|([A-Za-z_$][\w$]*))\s*=\s*await\s+(?:db|tx)\b/g)) names.add((m[1] ?? m[2]) as string)
	return [...names]
}

function touchesText(src: string): boolean {
	if (new RegExp(`deploys\\.${TEXT_COLUMN}\\b`).test(src)) return true
	const names = rowNames(src)
	return names.length > 0 && new RegExp(`\\b(?:${names.map((n) => n.replace(/\$/g, '\\$')).join('|')})\\.${TEXT_COLUMN}\\b`).test(src)
}

/** Rows of an unprojected deploys select that reach a json response whole: the variable
 *  appears in a Response.json / NextResponse.json argument other than as `x.field` or as
 *  the argument of a call that only reads non-text facts. */
const ROW_SAFE_CALLS = ['settleNote']
function wholeRowsReturned(src: string): string[] {
	const vars: string[] = []
	for (const m of src.matchAll(/\bconst\s+(?:\[\s*([A-Za-z_$][\w$]*)[^\]]*\]|([A-Za-z_$][\w$]*))\s*=\s*await\s+[\w.]*\s*\.select\(\s*\)\s*\.from\(\s*deploys\s*\)/g))
		vars.push((m[1] ?? m[2]) as string)
	const out: string[] = []
	for (const m of src.matchAll(/\b(?:Response|NextResponse)\.json\(/g)) {
		// comments and string literals are not code
		const arg = valueAt(src, (m.index ?? 0) + m[0].length)
			.replace(/\/\/.*$/gm, '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''")
		for (const v of vars) {
			const uses = [...arg.matchAll(new RegExp(`(\\w+\\(\\s*)?\\b${v}\\b(?!\\s*\\??\\.|\\s*:)`, 'g'))]
			if (uses.some((u) => !ROW_SAFE_CALLS.some((c) => (u[1] ?? '').startsWith(c)))) out.push(`whole rows of ${v} returned`)
		}
	}
	return [...new Set(out)]
}
// raw SQL readers (`FROM deploys` in a sql`` / text query) that select the text
// columns: error_summary anywhere, or output / error as a selected column.
const RAW_READS_DEPLOYS = /\bFROM\s+deploys\b/i
const RAW_TOUCHES_TEXT = /\berror_summary\b|\b(?:\w+\.)?(?:output|error)\s*(?:,|\bAS\b|\n\s*FROM\b)/i

function readsDeployText(src: string, file: string): boolean {
	const imps = imports(src, file)
	if (imps.some((i) => DEPLOY_TEXT_MODULES.has(i.module))) return true
	const readsDeploys = imps.some((i) => i.module === 'lib/db' && /\bdeploys\b/.test(i.names))
	return (
		(readsDeploys && (touchesText(src) || wholeRowsReturned(src).length > 0)) ||
		(RAW_READS_DEPLOYS.test(src) && RAW_TOUCHES_TEXT.test(src))
	)
}

// ── is an expression masked? ────────────────────────────────────────────────

/** Calls whose result is masked deploy text. */
// maskedFailedStep (lib/deploy-failure.ts): the step, or 'unknown' when redaction would change it.
const MASKERS = new Set(['redactNullable', 'redactSecrets', 'failureTailFromWindows', 'redactor.push', 'redactor.flush', 'maskedFailedStep'])
/** Calls whose result is masked when their first argument is. */
// safeFailedStep only normalises (lower case, [a-z0-9 _:-]): it masks nothing by itself.
const PASSTHROUGH = new Set(['safeSlice', 'extractSnippet', 'String', 'safeFailedStep'])
const LITERAL = /^(?:null|undefined|false|true|'[^'\\]*'|"[^"\\]*"|-?\d+(?:\.\d+)?)$/

/** Splits `e` at every top-level occurrence of one of `ops` (outside brackets and strings). */
function splitTop(e: string, ops: string[]): string[] | null {
	const parts: string[] = []
	let depth = 0
	let quote: string | null = null
	let start = 0
	for (let i = 0; i < e.length; i++) {
		const c = e[i] as string
		if (quote) {
			if (c === '\\') i++
			else if (c === quote) quote = null
			continue
		}
		if (c === "'" || c === '"' || c === '`') quote = c
		else if ('([{'.includes(c)) depth++
		else if (')]}'.includes(c)) depth--
		else if (depth === 0) {
			const op = ops.find((o) => e.startsWith(o, i))
			if (op) {
				parts.push(e.slice(start, i))
				i += op.length - 1
				start = i + 1
			}
		}
	}
	if (parts.length === 0) return null
	parts.push(e.slice(start))
	return parts.map((p) => p.trim())
}

/** `c ? a : b` at top level: [a, b]; null when `e` is not a ternary. */
function ternary(e: string): [string, string] | null {
	let depth = 0
	let quote: string | null = null
	let q = -1
	let nested = 0
	for (let i = 0; i < e.length; i++) {
		const c = e[i] as string
		if (quote) {
			if (c === '\\') i++
			else if (c === quote) quote = null
			continue
		}
		if (c === "'" || c === '"' || c === '`') quote = c
		else if ('([{'.includes(c)) depth++
		else if (')]}'.includes(c)) depth--
		else if (depth === 0 && c === '?' && e[i + 1] !== '.' && e[i + 1] !== '?' && e[i - 1] !== '?') {
			if (q < 0) q = i
			else nested++
		} else if (depth === 0 && c === ':' && q >= 0) {
			if (nested > 0) nested--
			else return [e.slice(q + 1, i).trim(), e.slice(i + 1).trim()]
		}
	}
	return null
}

/** The whole of `e` is one call `name(args)`: its name and arguments. */
function wholeCall(e: string): { name: string; args: string[] } | null {
	const m = e.match(/^([A-Za-z_$][\w$.]*)\(/)
	if (!m) return null
	const open = (m[1] as string).length
	let depth = 0
	for (let i = open; i < e.length; i++) {
		const c = e[i]
		if (c === '(') depth++
		else if (c === ')' && --depth === 0) {
			if (i !== e.length - 1) return null
			return { name: m[1] as string, args: splitTop(e.slice(open + 1, i), [',']) ?? [e.slice(open + 1, i).trim()] }
		}
	}
	return null
}

function wholeParens(x: string): boolean {
	let depth = 0
	for (let i = 0; i < x.length; i++) {
		if (x[i] === '(') depth++
		else if (x[i] === ')' && --depth === 0 && i !== x.length - 1) return false
	}
	return true
}

/** True when the expression can only produce masked deploy text: a masking call, a
 *  literal, a pass-through call of a masked argument, a ternary / `??` / `||` / `+` whose
 *  every branch is masked, an object literal of masked values, or a local const that is. */
function masked(e: string, src: string, seen = new Set<string>()): boolean {
	let x = e.trim().replace(/\s+as\s+[\w<>[\]| ]+$/, '').replace(/!$/, '')
	while (x.startsWith('(') && x.endsWith(')') && wholeParens(x)) x = x.slice(1, -1).trim()
	if (LITERAL.test(x)) return true
	const t = ternary(x)
	if (t) return masked(t[0], src, seen) && masked(t[1], src, seen)
	const alt = splitTop(x, ['??', '||', '+'])
	if (alt) return alt.every((p) => masked(p, src, seen))
	if (x.startsWith('{') && x.endsWith('}')) return entries(x).every((en) => en.kind === 'field' && masked(en.value, src, seen))
	const call = wholeCall(x)
	if (call) {
		if (MASKERS.has(call.name)) return true
		if (PASSTHROUGH.has(call.name)) return masked(call.args[0] ?? '', src, seen)
		return false
	}
	if (/^[A-Za-z_$][\w$]*$/.test(x) && !seen.has(x)) {
		seen.add(x)
		const def = src.match(new RegExp(`\\bconst ${x} = `))
		if (def) return masked(valueAt(src, (def.index ?? 0) + def[0].length, true), src, seen)
	}
	return false
}

/** The expression from `from` up to its top-level `,`, closing bracket, or (statement
 *  mode) end of line. */
function valueAt(src: string, from: number, statement = false): string {
	let depth = 0
	let quote: string | null = null
	for (let i = from; i < src.length; i++) {
		const c = src[i] as string
		if (quote) {
			if (c === '\\') i++
			else if (c === quote) quote = null
			continue
		}
		if (c === "'" || c === '"' || c === '`') quote = c
		else if ('([{'.includes(c)) depth++
		else if (')]}'.includes(c)) {
			if (depth === 0) return src.slice(from, i).trim()
			depth--
		} else if (depth === 0 && (c === ',' || (statement && c === '\n'))) return src.slice(from, i).trim()
	}
	return src.slice(from).trim()
}

type Entry = { kind: 'field'; key: string; value: string } | { kind: 'spread'; value: string }

/** The top-level entries of an object literal `{ ... }` (comments dropped). */
function entries(obj: string): Entry[] {
	const body = obj
		.slice(1, -1)
		.replace(/^\s*\/\/.*$/gm, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
	const parts = splitTop(body, [',']) ?? [body.trim()]
	return parts
		.filter((p) => p !== '')
		.map((p): Entry => {
			if (p.startsWith('...')) return { kind: 'spread', value: p.slice(3).trim() }
			const m = p.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/)
			return m ? { kind: 'field', key: m[1] as string, value: (m[2] as string).trim() } : { kind: 'field', key: p, value: p }
		})
}

/** The object literal opened by the `{` of `open` (searched from `anchor`). */
function objectAt(src: string, anchor: string, open: string): string | null {
	const a = src.indexOf(anchor)
	if (a < 0) return null
	const o = src.indexOf(open, a)
	if (o < 0) return null
	const start = o + open.lastIndexOf('{')
	let depth = 0
	let quote: string | null = null
	for (let i = start; i < src.length; i++) {
		const c = src[i] as string
		if (quote) {
			if (c === '\\') i++
			else if (c === quote) quote = null
			continue
		}
		if (c === "'" || c === '"' || c === '`') quote = c
		else if (c === '{' || c === '(' || c === '[') depth++
		else if (c === '}' || c === ')' || c === ']') {
			if (--depth === 0) return src.slice(start, i + 1)
		}
	}
	return null
}

// a value that names deploy text: a text column of a row, or a lib window of one
const TEXT_REF = /\.(?:output|outputWindow|error|errorSummary|error_summary|failedStep|failed_step)\b/

type ObjectCheck = { anchor: string; open: string; fields: string[] }
type Reader = { objects: ObjectCheck[] } | { stream: true }

/** Every detected reader, with what it returns. */
const READERS: Record<string, Reader> = {
	'api/projects/[id]/route.ts': {
		objects: [{ anchor: 'deploys: recentDeploys.map(', open: '({', fields: ['logTail', 'outputPreview', 'errorSummary', 'failedStep'] }],
	},
	'api/deploys/[deployId]/route.ts': {
		objects: [{ anchor: 'deploy: {', open: '{', fields: ['output', 'error', 'errorSummary', 'failedStep'] }],
	},
	'api/deploys-list/route.ts': { objects: [{ anchor: 'const out: DeployRow[] = rows.map', open: 'return {', fields: ['errorSummary'] }] },
	'api/internal/deploys/route.ts': { objects: [{ anchor: 'deploys: terminal.map(', open: '({', fields: ['errorSummary', 'failedStep'] }] },
	'api/logs/search/route.ts': { objects: [{ anchor: 'const results = rows.flatMap', open: 'return {', fields: ['snippet'] }] },
	'api/internal/apps/route.ts': { objects: [{ anchor: 'deploys: recent.map(', open: '({', fields: ['errorSummary', 'failedStep'] }] },
	'api/projects/[id]/ci/route.ts': { objects: [{ anchor: 'const checkRows = rows.map', open: 'return {', fields: ['errorSummary', 'failedStep'] }] },
	// chunks and errors go out through send(): every send of one is checked
	'api/deploys/[deployId]/stream/route.ts': { stream: true },
}

/** What is wrong with one file's deploy-text returns; [] = fine. */
function problems(rel: string, src: string, file = join(APP, rel)): string[] {
	if (!readsDeployText(src, file)) return []
	const reader = READERS[rel]
	if (!reader) return [`${rel}: reads deploy text but is not listed in READERS with its returned fields`]
	if ('stream' in reader) return [...wholeRowsReturned(src), ...streamProblems(src)]
	const out: string[] = [...wholeRowsReturned(src)]
	for (const check of reader.objects) {
		const obj = objectAt(src, check.anchor, check.open)
		if (!obj) {
			out.push(`object not found: ${check.anchor}`)
			continue
		}
		const list = entries(obj)
		for (const en of list) {
			if (en.kind === 'spread') {
				if (!masked(en.value, src)) out.push(`...${en.value}`)
			} else if ((check.fields.includes(en.key) || TEXT_REF.test(en.value)) && !masked(en.value, src)) {
				out.push(`${en.key}: ${en.value}`)
			}
		}
		for (const f of check.fields) {
			const returned =
				list.some((en) => en.kind === 'field' && en.key === f) ||
				(f === 'logTail' && list.some((en) => en.kind === 'spread' && /failureTailFromWindows\(/.test(en.value)))
			if (!returned) out.push(`${f}: not returned`)
		}
	}
	return out
}

/** The stream route: every chunk and error it sends is masked. */
function streamProblems(src: string): string[] {
	const out: string[] = []
	for (const m of src.matchAll(/\bsend\('(chunk|error)',\s*/g)) {
		const v = valueAt(src, (m.index ?? 0) + m[0].length)
		if (!masked(v, src)) out.push(`send('${m[1]}', ${v})`)
	}
	return out.length > 0 ? out : /\bsend\('chunk',/.test(src) ? [] : ['no chunk send found']
}

describe('deploy text readers mask secrets', () => {
	const all = files(APP).map((f) => [relative(APP, f), f] as const)
	it('finds the known readers (the scan works)', () => {
		const rel = all.filter(([, f]) => readsDeployText(readFileSync(f, 'utf8'), f)).map(([r]) => r)
		expect(rel.sort()).toEqual(Object.keys(READERS).sort())
	})
	it.each(all)('%s', (rel, f) => {
		expect(problems(rel, readFileSync(f, 'utf8'))).toEqual([])
	})
	it('log search cuts snippets from masked text', () => {
		const src = readFileSync(join(APP, 'api/logs/search/route.ts'), 'utf8')
		expect(src).not.toMatch(/extractSnippet\(r\.(error|output)/)
	})
})

describe('the guard catches what it must (plants in in-memory copies)', () => {
	const read = (rel: string) => readFileSync(join(APP, rel), 'utf8')
	const plant = (rel: string, from: RegExp | string, to: string) => {
		const src = read(rel)
		const out = src.replace(from, to)
		expect(out, `plant did not apply: ${from}`).not.toBe(src)
		return problems(rel, out)
	}
	const PROJECT = 'api/projects/[id]/route.ts'
	const DEPLOY = 'api/deploys/[deployId]/route.ts'

	it('unmasked fields of the project route', () => {
		expect(
			plant(PROJECT, /\.\.\.\(d\.status === 'failed'[\s\S]*?\{ logTail: null, logCut: false \}\),/, 'logTail: d.outputWindow, logCut: false,'),
		).toEqual(['logTail: d.outputWindow'])
		expect(plant(PROJECT, 'safeSlice(redactSecrets(d.output), 0, 500)', 'safeSlice(d.output, 0, 500)')).toEqual([
			'outputPreview: d.output ? safeSlice(d.output, 0, 500) : null',
		])
		expect(plant(PROJECT, 'errorSummary: redactNullable(d.errorSummary)', 'errorSummary: d.errorSummary')).toEqual(['errorSummary: d.errorSummary'])
		expect(plant(PROJECT, 'failedStep: redactNullable(d.failedStep)', 'failedStep: d.failedStep')).toEqual(['failedStep: d.failedStep'])
		expect(plant(PROJECT, /\n\t*outputPreview: [^\n]*/, '')).toEqual(['outputPreview: not returned'])
	})
	it('a raw spread of the row at the top of the object', () => {
		expect(plant(PROJECT, 'deploys: recentDeploys.map((d) => ({', 'deploys: recentDeploys.map((d) => ({\n\t\t\t...d,')).toEqual(['...d'])
	})
	it('a raw spread after the masked overrides', () => {
		expect(plant(DEPLOY, /(\t+failedStep: redactNullable\(deploy\.failedStep\),\n)/, '$1\t\t\t...deploy,\n')).toEqual(['whole rows of deploy returned', '...deploy'])
	})
	it('a raw text column under another key', () => {
		expect(plant(DEPLOY, 'exitCode: deploy.exitCode,', 'exitCode: deploy.exitCode,\n\t\t\tlog: deploy.output,')).toEqual([
			'log: deploy.output',
		])
	})
	it('a ternary with one raw branch', () => {
		expect(
			plant(DEPLOY, 'errorSummary: redactNullable(deploy.errorSummary)', 'errorSummary: deploy.kind ? deploy.errorSummary : redactNullable(deploy.errorSummary)'),
		).toEqual(['errorSummary: deploy.kind ? deploy.errorSummary : redactNullable(deploy.errorSummary)'])
	})
	it('a ?? with one raw operand', () => {
		expect(plant(DEPLOY, 'error: redactNullable(deploy.error)', 'error: deploy.error ?? redactNullable(deploy.error)')).toEqual([
			'error: deploy.error ?? redactNullable(deploy.error)',
		])
	})
	it('a new route reading through a relative, double-quoted import is a reader and must be listed', () => {
		const rel = 'api/demo/route.ts'
		const src = `import { recentDeploysQuery } from "../../../lib/project-deploys-db"\nexport async function GET() { return Response.json(await recentDeploysQuery('srv-1', 'shop')) }\n`
		expect(problems(rel, src)).toEqual([`${rel}: reads deploy text but is not listed in READERS with its returned fields`])
		const aliased = src.replace('"../../../lib/project-deploys-db"', "'@/lib/project-deploys-db'")
		expect(problems(rel, aliased)).toHaveLength(1)
	})
	it('a new raw route that mentions a redactor somewhere still fails', () => {
		const rel = 'api/demo2/route.ts'
		const src = `import { db, deploys } from "@/lib/db"\nimport { redactSecrets } from '@/lib/secret-text'\nvoid redactSecrets\nexport async function GET() { const [d] = await db.select().from(deploys); return Response.json({ output: d.output }) }\n`
		expect(problems(rel, src)).toEqual([`${rel}: reads deploy text but is not listed in READERS with its returned fields`])
	})
	it('rows of an unprojected select returned whole', () => {
		// a listed route
		expect(plant(DEPLOY, 'return Response.json({\n\t\t// an explicit pick', 'return Response.json({\n\t\trow: deploy,\n\t\t// an explicit pick')).toContain(
			'whole rows of deploy returned',
		)
		// a new route with any variable name
		const rel = 'api/demo3/route.ts'
		const src = `import { db, deploys } from '@/lib/db'\nexport async function GET() { const history = await db.select().from(deploys).limit(5); return Response.json({ history }) }\n`
		expect(problems(rel, src)).toEqual([`${rel}: reads deploy text but is not listed in READERS with its returned fields`])
	})
	it('a row variable with any name is seen', () => {
		const rel = 'api/demo4/route.ts'
		const src = `import { db, deploys } from '@/lib/db'\nexport async function GET() { const items = await db.select({ id: deploys.id, o: deploys.id }).from(deploys); return Response.json(items.map((entry) => ({ log: entry.output }))) }\n`
		expect(problems(rel, src)).toEqual([`${rel}: reads deploy text but is not listed in READERS with its returned fields`])
	})
	it('a dynamic import of a deploy-text module makes a reader', () => {
		const rel = 'api/demo5/route.ts'
		const src = `export async function GET() { const { recentDeploysQuery } = await import('../../../lib/project-deploys-db'); return Response.json(await recentDeploysQuery('srv-1', 'shop')) }\n`
		expect(problems(rel, src)).toEqual([`${rel}: reads deploy text but is not listed in READERS with its returned fields`])
	})
	it('a raw chunk on the stream', () => {
		expect(plant('api/deploys/[deployId]/stream/route.ts', "send('chunk', redactSecrets(row.output))", "send('chunk', row.output)")).toEqual([
			"send('chunk', row.output)",
		])
	})
})
