import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FieldRow, fieldClasses, fieldText, Input } from '../../components/ui/input'
import { backupDbProblem, validateAppSettings } from '../app-settings'
import { validateAppInputs } from '../compose-guard'
import { DOCKERFILE_COPY, PORT_COPY, SETTLE_COPY, uiErrorCopy } from '../ui-error-copy'

// Inline forms (label + control + action) have one layout: FieldRow in
// components/ui/input.tsx. A form row built from flex `items-end`, a magic top
// margin on the button or a local Field drifts out of line as soon as one column
// gets a hint or an error.

const SRC = join(__dirname, '../..')

function tsxFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) return tsxFiles(p)
		return p.endsWith('.tsx') ? [p] : []
	})
}

const files = [...tsxFiles(join(SRC, 'app')), ...tsxFiles(join(SRC, 'components'))]
const formFiles = files.filter((f) =>
	readFileSync(f, 'utf8').includes("from '@/components/ui/input'"),
)

describe('inline form rows', () => {
	it('files with fields do not align rows with items-end', () => {
		const offenders = formFiles.filter((f) => /\bitems-end\b/.test(readFileSync(f, 'utf8')))
		expect(offenders.map((f) => relative(SRC, f))).toEqual([])
	})

	it('no magic top margin to line a button up with an input', () => {
		const offenders = files.filter((f) => /\bm[ty]-\[1\.\d+rem\]/.test(readFileSync(f, 'utf8')))
		expect(offenders.map((f) => relative(SRC, f))).toEqual([])
	})

	it('Field is defined once, in ui/input.tsx', () => {
		const offenders = files.filter(
			(f) =>
				!f.endsWith(join('components', 'ui', 'input.tsx')) &&
				/\bfunction Field\s*\(/.test(readFileSync(f, 'utf8')),
		)
		expect(offenders.map((f) => relative(SRC, f))).toEqual([])
	})

	it('a FieldRow error marks its inputs invalid and is announced', () => {
		const row = (error?: string) =>
			renderToStaticMarkup(
				createElement(
					FieldRow,
					{ id: 'r', error, hint: 'a hint' } as Parameters<typeof FieldRow>[0],
					createElement(Input, { label: 'a' }),
					createElement(Input, { label: 'b', 'aria-invalid': undefined }),
				),
			)
		const bad = row('bad value')
		expect(bad.match(/<input[^>]*aria-invalid="true"/g)).toHaveLength(1)
		expect(bad).toMatch(/<p id="r-msg" role="alert"/)
		const ok = row()
		expect(ok).not.toMatch(/aria-invalid/)
		expect(ok).not.toMatch(/role="alert"/)
		expect(ok.match(/aria-describedby="r-msg"/g)).toHaveLength(2)
	})

	it('FieldRow children carry no hint or error of their own', () => {
		for (const f of formFiles) {
			const src = readFileSync(f, 'utf8')
			for (const m of src.matchAll(/<FieldRow\b[\s\S]*?<\/FieldRow>/g)) {
				const inner = m[0].replace(/^<FieldRow\b[\s\S]*?\n\t*>/, '')
				expect(inner, relative(SRC, f)).not.toMatch(/\n\s*(hint|error)=/)
			}
		}
	})
})

// iOS Safari zooms the page into a focused field whose font is under 16px. Every
// text field is 16px (text-base) below sm; the size per field size lives in
// fieldText, which Input, Select and Textarea apply after the caller's className.
describe('field font size', () => {
	// An unprefixed font-size utility smaller than text-base: the base breakpoint.
	const small = /(?<![\w:-])text-(2xs|xs|sm)(?![\w-])/
	const fieldTags = /<(Input|Select|Textarea|input|textarea|select)\b/g
	const end = /\n\t*\/?>|\/>/g

	it('the shared field chrome is 16px at the base breakpoint', () => {
		expect(fieldClasses).toMatch(/(?<![\w:-])text-base\b/)
		expect(fieldClasses).not.toMatch(small)
		for (const cls of Object.values(fieldText)) {
			expect(cls).toMatch(/^text-base\b/)
			expect(cls).not.toMatch(small)
		}
	})

	it('no field sets a font size under 16px at the base breakpoint', () => {
		const offenders: string[] = []
		for (const f of files) {
			if (f.endsWith(join('components', 'ui', 'input.tsx'))) continue
			const src = readFileSync(f, 'utf8')
			for (const m of src.matchAll(fieldTags)) {
				end.lastIndex = m.index + m[0].length
				const close = end.exec(src)
				const tag = src.slice(m.index, close ? close.index + close[0].length : undefined)
				if (/\btype=["'](checkbox|radio|hidden|file|range|color)["']/.test(tag)) continue
				const where = `${relative(SRC, f)}:${src.slice(0, m.index).split('\n').length}`
				const classes = [...tag.matchAll(/\b(?:className|selectClassName)=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)]
					.map((c) => c[1] ?? c[2] ?? c[3] ?? '')
					.join(' ')
				if (small.test(classes)) offenders.push(`${where} sets a small font size`)
				// A raw element gets no fieldText: it needs the field chrome or text-base itself.
				if (/^<[a-z]/.test(m[0]) && !/\bfieldClasses\b|(?<![\w:-])text-base\b/.test(classes))
					offenders.push(`${where} has no 16px base size`)
			}
		}
		expect(offenders).toEqual([])
	})
})

describe('API errors in forms read as UI copy', () => {
	const camel = /\b[a-z]+[A-Z][A-Za-z]*\b/

	it('settle window', () => {
		const r = validateAppSettings({ deploySettleSeconds: 5000 })
		expect(r.ok).toBe(false)
		if (!r.ok) expect(uiErrorCopy(r.error)).toBe(SETTLE_COPY)
	})

	it('Dockerfile path and port', () => {
		const port = validateAppInputs({ containerPort: 0 })
		const file = validateAppInputs({ dockerfilePath: '../x' })
		if (port.ok || file.ok) throw new Error('expected both to fail')
		expect(uiErrorCopy(port.error)).toBe(PORT_COPY)
		expect(uiErrorCopy(file.error)).toBe(DOCKERFILE_COPY)
	})

	it('backup database messages name no field', () => {
		const errors = [
			backupDbProblem({ container: 'pg', host: 'db', passwordSet: true }),
			backupDbProblem({ container: null, host: 'db', passwordSet: false }),
		]
		for (const body of [
			{ backupDbContainer: '-x' },
			{ backupDbHost: 'db:0' },
			{ backupDbName: "x'y" },
			{ backupDbUser: '$' },
			{ backupDbPassword: 'a\nb' },
		]) {
			const r = validateAppSettings(body)
			if (!r.ok) errors.push(r.error)
		}
		expect(errors).toHaveLength(7)
		for (const e of errors) expect(uiErrorCopy(e ?? '')).not.toMatch(camel)
	})

	it('health URL messages name no field', () => {
		for (const healthUrl of [
			'//x',
			'ftp://x',
			'http://user:pw@x.com/',
			'http://127.0.0.1/',
			'a b',
		]) {
			const r = validateAppSettings({ healthUrl })
			if (r.ok) continue
			expect(uiErrorCopy(r.error)).not.toMatch(camel)
		}
	})
})
