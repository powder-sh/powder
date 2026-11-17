import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../ssh', () => ({}))
vi.mock('../servers', () => ({}))
vi.mock('../traefik-servers', () => ({ isTraefikServer: async () => true }))

import { renderLabelsBlock } from '../app-domains'

const noRedirects = { redirects: [], rewrites: [], headers: {} }
const base = {
	containerName: 'widgets',
	hosts: ['widgets.apps.example.com', 'widg.et'],
	containerPort: 3040,
	redirects: noRedirects,
}

describe('renderLabelsBlock tls', () => {
	it('acme (default) emits the le certresolver', () => {
		const b = renderLabelsBlock({ ...base })
		expect(b).toContain('traefik.http.routers.widgets.tls.certresolver=le')
		expect(b).toContain('traefik.http.routers.widgets.entrypoints=websecure')
		expect(b).toContain('Host(`widgets.apps.example.com`) || Host(`widg.et`)')
	})
	it('origin-cert emits tls=true and no certresolver', () => {
		const b = renderLabelsBlock({ ...base, tlsMode: 'origin-cert' })
		expect(b).toContain('      - traefik.http.routers.widgets.tls=true\n')
		expect(b).not.toContain('certresolver')
	})
})

// Shape of a real powder compose for an app with a published port and no
// labels (an app on server-a): image, env_file, ports, networks.
describe('renderLabelsBlock carries no per-deploy value', () => {
	it('the traefik label set is identical for two deploys and has no Deploy-Id / Image-Tag header', () => {
		const a = renderLabelsBlock({ ...base })
		const b = renderLabelsBlock({ ...base })
		expect(a).toBe(b)
		expect(a).not.toContain('X-Powder-Deploy-Id')
		expect(a).not.toContain('X-Powder-Image-Tag')
		expect(a).toContain('X-Powder-App')
	})
})
