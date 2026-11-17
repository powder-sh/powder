import { describe, expect, it } from 'vitest'
import { buildDeployScript } from '../deploy/script'

const base = {
	workingDir: '/opt/apps/pv-x',
	configFile: '/opt/apps/pv-x/docker-compose.yml',
	service: 'pv-x',
	cf: '-f /opt/apps/pv-x/docker-compose.yml',
	declaredMode: 'auto',
	prebuilt: false,
	infra: [],
	wantBranch: null,
	wantSha: null,
	shaIsStrict: false,
}

describe('buildDeployScript skipMigrate', () => {
	it('runs powder-migrate by default', () => {
		expect(buildDeployScript(base)).toContain('powder-migrate')
	})
	it('previews never run powder-migrate', () => {
		const s = buildDeployScript({ ...base, skipMigrate: true })
		expect(s).not.toContain('/usr/local/bin/powder-migrate')
		expect(
			s.replaceAll('[migrate] skipped: preview deploys never run powder-migrate', ''),
		).not.toContain('powder-migrate')
		expect(s).toContain('[migrate] skipped: preview deploys never run powder-migrate')
	})
	it('previews never run the release command; normal deploys do', () => {
		expect(buildDeployScript(base)).toContain('powder.release.cmd')
		const s = buildDeployScript({ ...base, skipMigrate: true })
		expect(s).not.toContain('powder.release.cmd')
		expect(s).toContain('[release] skipped: preview deploys never run the release command')
	})
})
