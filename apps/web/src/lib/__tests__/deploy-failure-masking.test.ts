// parseDeployFailure matches its patterns on the raw log (in memory) and masks
// only what it returns: masking first broke patterns whose wording looks like
// a name=value pair (a registry auth failure summarized as "failed during: pull").
import { describe, expect, it } from 'vitest'
import { DeployStepError, deployFailureFromError, parseDeployFailure } from '../deploy-failure'
import { FX } from './fixtures/secret-corpus'

describe('patterns see the raw log, output is masked', () => {
	it('registry auth failure keeps its summary', () => {
		const log =
			'── pull ──\nError response from daemon: unauthorized: authentication required\n__POWDER_FAIL__ step=pull code=1\n'
		expect(parseDeployFailure(log).errorSummary).toContain('registry auth denied')
		expect(new DeployStepError(log).errorSummary).toContain('registry auth denied')
	})
	it('a capture carrying a secret is masked', () => {
		const log =
			'── swap-check ──\nauth check: /api/auth/ok returned 500 (better-auth schema mismatch? run the migration): DATABASE_URL=postgres://app:Pw9secret@db/app\n__POWDER_FAIL__ step=swap-check code=1\n'
		const s = parseDeployFailure(log).errorSummary
		expect(s).toContain('auth check: /api/auth/ok returned 500')
		expect(s).not.toContain('Pw9secret')
	})
	it('the last-line fallback comes from the masked log', () => {
		const err = new Error(
			`clone failed\nfatal: unable to access 'https://x-access-token:${FX.GHS}@github.com/a/b/'`,
		)
		const f = deployFailureFromError(err)
		expect(f.errorSummary).toContain('fatal: unable to access')
		expect(f.errorSummary).not.toContain(FX.GHS)
		expect(f.error).not.toContain(FX.GHS)
	})
	it('a truncated key never becomes the summary', () => {
		const err = new Error(`-----BEGIN RSA PRIVATE KEY-----\n${FX.PEM_BODY}\nshortTAILline`)
		expect(deployFailureFromError(err).errorSummary).not.toContain('shortTAILline')
	})
})

describe('image pull failures are worded for build-on-server', () => {
	const at = (step: string, line: string) => `── ${step} ──\n${line}\n__POWDER_FAIL__ step=${step} code=1\n`
	it('a missing FROM image during the build points at the Dockerfile, not CI', () => {
		const s = parseDeployFailure(
			at('docker compose build (local build)', 'failed to solve: node:99-nope: manifest unknown'),
		).errorSummary
		expect(s).toMatch(/FROM lines of the Dockerfile/)
		expect(s).not.toMatch(/GitHub|Actions|GHCR/)
	})
	it('a denied FROM image during the build', () => {
		const s = parseDeployFailure(
			at('docker compose build (local build)', 'denied: requested access to the resource is denied'),
		).errorSummary
		expect(s).toMatch(/FROM image of the Dockerfile/)
		expect(s).not.toMatch(/GitHub|Actions|GHCR/)
	})
	it("registry mode: the app's own image pull keeps the registry hint", () => {
		const missing = parseDeployFailure(
			at('docker compose pull (registry mode)', 'Error response from daemon: manifest unknown'),
		).errorSummary
		expect(missing).toMatch(/compose image: names a tag/)
		const denied = parseDeployFailure(
			at('docker compose pull (registry mode)', 'unauthorized: authentication required'),
		).errorSummary
		expect(denied).toMatch(/docker login for that registry/)
		expect(`${missing} ${denied}`).not.toMatch(/GitHub|Actions|GHCR/)
	})
	it('the OOM summary names no operator notes', () => {
		expect(parseDeployFailure(at('docker compose build (local build)', 'Killed')).errorSummary).toMatch(
			/add memory or swap/,
		)
	})
})
