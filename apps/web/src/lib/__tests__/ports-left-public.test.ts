// the "ports left public" warn card is built from powder's own plan notes,
// never from a search of the deploy output (build or test output can print anything).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { portsLeftPublicLines } from '../hq'

describe('ports left public', () => {
	it('keeps only left public notes, deduped, capped and notify-safe', () => {
		const out = portsLeftPublicLines([
			'[ports] app: 3000 bound to 127.0.0.1',
			'left public: web opted out (powder.public-port=true)',
			'left public: web opted out (powder.public-port=true)',
			'left public: <b>x</b> @everyone [a](http://e)',
		])
		expect(out).toHaveLength(2)
		expect(out[1]).not.toContain('<b>')
		expect(out[1]).not.toContain('@everyone')
		expect(out[1]).not.toContain('](')
	})
	it('the runner takes the notes from the rebuild result, not the output', () => {
		const src = readFileSync(join(__dirname, '..', 'deploy-runner.ts'), 'utf8')
		expect(src).toContain('portsLeftPublicLines(portsLeftPublic)')
		expect(src).not.toMatch(/portsLeftPublicLines\(fullOutput|extractPortsLeftPublic/)
	})
})
