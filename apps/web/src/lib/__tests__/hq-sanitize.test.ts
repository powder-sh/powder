import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDeployFailure } from '../deploy-failure'
import { reportDeployToHq, reportDeployWarningsToHq } from '../hq'
import { safeFailedStep, sanitizeNotifyText } from '../notify-text'
import { redactSecrets as S } from '../secret-text'

afterEach(() => {
	vi.unstubAllGlobals()
	delete process.env.POWDER_HQ_INGEST_TOKEN
	delete process.env.POWDER_HQ_INGEST_URL
	delete process.env.POWDER_HQ_GENERIC_URL
})

describe('HQ text is sanitised', () => {
	it('sanitizeNotifyText breaks masked links and mentions', () => {
		const out = sanitizeNotifyText('[click here](https://evil.example) @everyone <!here>')
		expect(out).not.toContain('](')
		expect(out).not.toMatch(/@(?!​)/)
		expect(out).not.toContain('<')
	})
	it('deploy event error and builder fallback are sanitised before they leave', async () => {
		process.env.POWDER_HQ_INGEST_TOKEN = 't'
		process.env.POWDER_HQ_INGEST_URL = 'http://hq/deploy'
		process.env.POWDER_HQ_GENERIC_URL = 'http://hq/generic'
		const bodies: string[] = []
		vi.stubGlobal('fetch', vi.fn(async (_u: string, i: { body: string }) => {
			bodies.push(i.body)
			return new Response('ok')
		}))
		await reportDeployToHq({
			app: 'a',
			server: 's',
			status: 'failure',
			error: S('[x](http://evil) @everyone'),
		})
		await reportDeployWarningsToHq({ app: 'a', server: 's', envRefusedKeys: null, builderFallback: '[builder] phase failed - [x](http://evil) @here' })
		const all = bodies.join('\n')
		expect(all).not.toContain('](')
		expect(all).not.toMatch(/@(?!​)/)
	})
	it('failedStep is normalised to [a-z0-9 _:-]{1,40} or unknown', () => {
		expect(safeFailedStep('docker compose up')).toBe('docker compose up')
		expect(safeFailedStep('git sync (force src/ to GitHub)')).toMatch(/^[a-z0-9 _:-]{1,40}$/)
		expect(safeFailedStep('@everyone [x](http://evil)')).not.toMatch(/[@\[\]()/]/)
		expect(safeFailedStep('!!!')).toBe('unknown')
		expect(safeFailedStep(null)).toBe('unknown')
		const f = parseDeployFailure('__POWDER_FAIL__ step=@everyone [x](http://evil) code=1')
		expect(f.errorSummary).toMatch(/^failed during: [a-z0-9 _:-]+$/)
	})
})
