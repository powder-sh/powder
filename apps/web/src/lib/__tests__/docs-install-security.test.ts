import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// docs and dev compose details.
const root = resolve(__dirname, '../../../../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

describe('docs', () => {
	it('the dev database publishes on loopback only', () => {
		const dev = read('docker-compose.dev.yml')
		expect(dev).toContain('"127.0.0.1:5433:5432"')
		expect(dev).not.toMatch(/-\s*"5433:5432"/)
	})
	it('the security model names the per-app cache ids and the Traefik socket risk', () => {
		const sm = read('apps/web/content/docs/security-model.md')
		expect(sm).toContain('per-app salted cache ids')
		expect(sm).not.toContain('Build caches and the Docker daemon are shared by every app on a server')
		expect(sm).toContain('/var/run/docker.sock')
		expect(sm).toContain('socket proxy')
	})
	it('the install steps bootstrap Traefik on the powder server before POWDER_DASHBOARD_HOST', () => {
		expect(read('apps/web/content/docs/self-hosting.md')).toContain('sudo bin/server-bootstrap.sh --apply --proxy traefik')
	})
	it('"Restrict the master SSH key" assumes no tailnet or builder', () => {
		const s = read('docs/SELF-HOSTING.md')
		const sec = s.slice(
			s.indexOf('### Restrict the master SSH key'),
			s.indexOf('## Optional integrations'),
		)
		expect(sec.length).toBeGreaterThan(100)
		expect(sec).not.toMatch(/tailnet|Tailscale|builder/i)
		expect(sec).toContain('from="')
	})
})
