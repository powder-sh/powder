import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readPowderJsonShell } from '../powder-config'

const cat = (dir: string) => spawnSync('bash', ['-c', readPowderJsonShell(dir)], { encoding: 'utf8' }).stdout

describe('powder.json: src/ first, then the app dir root', () => {
	it('the checkout\'s committed file wins over a root one', () => {
		const d = mkdtempSync(join(tmpdir(), 'f5-'))
		mkdirSync(join(d, 'src'))
		writeFileSync(join(d, 'src', 'powder.json'), '{"src":1}')
		writeFileSync(join(d, 'powder.json'), '{"root":1}')
		expect(cat(d)).toBe('{"src":1}')
	})
	it('falls back to the root file (workdir layout), or prints nothing', () => {
		const d = mkdtempSync(join(tmpdir(), 'f5-'))
		writeFileSync(join(d, 'powder.json'), '{"root":1}')
		expect(cat(d)).toBe('{"root":1}')
		expect(cat(mkdtempSync(join(tmpdir(), 'f5-')))).toBe('')
	})
	it('never follows a link', () => {
		const d = mkdtempSync(join(tmpdir(), 'f5-'))
		mkdirSync(join(d, 'src'))
		writeFileSync(join(d, 'victim'), 'SECRET')
		symlinkSync(join(d, 'victim'), join(d, 'src', 'powder.json'))
		expect(cat(d)).toBe('')
	})
})
