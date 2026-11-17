// powder sits on the shared `web` network, so any Traefik-routed app on the
// same server can reach powder:3000 without Traefik and pick its own X-Real-IP/Host.
// Not changed in code (a network move can take a running dashboard offline); the
// exposure and the dedicated-network design must stay documented.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../../../../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('powder on the web network is documented', () => {
	it('the security model names the exposure', () => {
		const md = read('apps/web/content/docs/security-model.md')
		expect(md).toMatch(/powder's port 3000 directly, without Traefik/)
		expect(md).toMatch(/X-Real-IP/)
	})
	it('SELF-HOSTING carries the dedicated network design', () => {
		const md = read('docs/SELF-HOSTING.md')
		expect(md).toContain('### powder on the web network')
		expect(md).toContain('traefik.docker.network=powder-edge')
		// the compose file still puts powder on web (if this changes, update the docs)
		expect(read('docker-compose.yml')).toMatch(/networks:\n\s+- web\n\s+- powder-db/)
	})
})
