import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatDate, formatDateTime, formatTime } from '../format'

const AT = '2026-11-11T18:32:05Z'

describe('one unambiguous date format', () => {
	it('renders day, month name, year and a 24-hour time', () => {
		expect(formatDateTime(AT, { timeZone: 'UTC' })).toBe('11 Nov 2026, 18:32')
		expect(formatDateTime(AT, { timeZone: 'America/New_York' })).toBe('11 Nov 2026, 13:32')
		expect(formatDateTime(AT, { timeZone: 'UTC', seconds: true })).toBe('11 Nov 2026, 18:32:05')
		expect(formatDate(AT, { timeZone: 'UTC' })).toBe('11 Nov 2026')
		expect(formatTime(AT, { timeZone: 'UTC' })).toBe('18:32')
	})

	it('midnight is 00, the day has no leading zero, September is Sep', () => {
		expect(formatDateTime('2026-09-03T00:05:00Z', { timeZone: 'UTC' })).toBe('3 Sep 2026, 00:05')
	})

	it('takes a Date or epoch ms, and says "-" for nothing or garbage', () => {
		expect(formatDate(new Date(AT), { timeZone: 'UTC' })).toBe('11 Nov 2026')
		expect(formatDate(Date.parse(AT), { timeZone: 'UTC' })).toBe('11 Nov 2026')
		for (const v of [null, undefined, '', 'not a date']) {
			expect(formatDateTime(v)).toBe('-')
			expect(formatDate(v)).toBe('-')
			expect(formatTime(v)).toBe('-')
		}
	})
})

// Guard: pages and components format dates through lib/format.ts only. A raw
// toLocaleString() renders 10/11/2026 or 11/10/2026 depending on the browser.
describe('no ad-hoc date formatting in app/ or components/', () => {
	const src = join(__dirname, '..', '..')
	const files: string[] = []
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name)
			if (name === '__tests__' || name === 'node_modules') continue
			if (statSync(p).isDirectory()) walk(p)
			else if (/\.(ts|tsx)$/.test(name)) files.push(p)
		}
	}
	walk(join(src, 'app'))
	walk(join(src, 'components'))

	it('finds the files it guards', () => {
		expect(files.length).toBeGreaterThan(50)
	})

	it('no toLocaleString / toLocaleDateString / toLocaleTimeString / Intl.DateTimeFormat', () => {
		const hits: string[] = []
		for (const f of files) {
			readFileSync(f, 'utf8')
				.split('\n')
				.forEach((line, i) => {
					if (/\.toLocale(?:Date|Time)?String\(|Intl\.DateTimeFormat/.test(line)) {
						hits.push(`${relative(src, f)}:${i + 1}: ${line.trim()}`)
					}
				})
		}
		expect(hits).toEqual([])
	})
})
