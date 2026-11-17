// every security env var is documented in docker/powder.env.example, and
// the security model describes what the compose guard, test gate and pull defaults do.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../../../../..')
const env = readFileSync(join(ROOT, 'docker/powder.env.example'), 'utf8')
const model = readFileSync(join(ROOT, 'apps/web/content/docs/security-model.md'), 'utf8')

describe('security docs', () => {
	it('the env example names every POWDER_* security switch', () => {
		for (const v of [
			'POWDER_COMPOSE_GUARD=',
			'POWDER_COMPOSE_GUARD_EXEMPT=',
			'POWDER_BUILD_PULL=',
			'POWDER_HARDEN=',
			'POWDER_WEB_READONLY=',
			'POWDER_DB_NETWORK=',
			'POWDER_TRUSTED_IP_HEADER=',
			'POWDER_SSH_HOSTKEY_MODE=',
			'POWDER_TESTGATE_MEM=',
		])
			expect(env, v).toContain(v)
	})
	it('the security model does not wave untrusted repos away and lists shared-server hardening', () => {
		expect(model).not.toContain('A malicious or compromised repo that you chose to deploy.')
		expect(model).toContain('## Hardening for shared servers')
		for (const s of ['Compose guard', 'Build pulls', 'Test gate', 'Limits:'])
			expect(model).toContain(s)
	})
})
