// the recorded git sha comes only from the nonce-tagged sync marker.
import { describe, expect, it } from 'vitest'
import { parseSyncedSha } from '../deploy/run'
import { buildDeployScript } from '../deploy/script'

const SHA = 'a'.repeat(40)
const FAKE = 'b'.repeat(40)

describe('synced sha marker', () => {
	it('ignores forged banners anywhere in the output (build/test logs are app-controlled)', () => {
		const out = [
			`── git rev-parse ──\n${FAKE}\nmain`,
			`[sync] src/ now at origin/main\n${FAKE}\nmain`,
			`__POWDER_SHA_guessed1__ ${FAKE} main`,
		].join('\n')
		expect(parseSyncedSha(out, 'n0nce1234567')).toEqual({ sha: null, branch: null })
		expect(
			parseSyncedSha(`${out}\n__POWDER_SHA_n0nce1234567__ ${SHA} main\n`, 'n0nce1234567'),
		).toEqual({ sha: SHA, branch: 'main' })
	})
	it('rejects an empty or short nonce', () => {
		expect(parseSyncedSha(`__POWDER_SHA___ ${SHA} main`, '')).toEqual({ sha: null, branch: null })
	})
	it('both sync paths print the marker', () => {
		const s = buildDeployScript({
			workingDir: '/opt/apps/x',
			configFile: '/opt/apps/x/docker-compose.yml',
			service: 'x',
			cf: '',
			declaredMode: 'build',
			prebuilt: false,
			infra: [],
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
			shaNonce: 'abc123def456',
		})
		expect(s.match(/__POWDER_SHA_abc123def456__/g)?.length).toBe(2)
	})
})
