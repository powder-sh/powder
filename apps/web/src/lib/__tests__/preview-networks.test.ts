// a preview runs branch code, so it joins `web` (Traefik) and its
// own project network only, never the shared `internal` network.
import { describe, expect, it } from 'vitest'
import { composeViolations, parseComposeYaml } from '../compose-safety'
import { renderPreviewCompose } from '../preview-deploys'

describe('preview compose networks', () => {
	const yaml = renderPreviewCompose({
		name: 'pv-blog-feat-x',
		dockerfilePath: 'Dockerfile',
		containerPort: 3000,
		envFiles: ['/opt/apps/blog.preview.env'],
		host: 'pv-blog-feat-x.apps.example.com',
	})
	const doc = parseComposeYaml(yaml) as {
		services: Record<string, { networks: string[] }>
		networks: Record<string, unknown>
	}
	it('joins web and its own default network, never internal', () => {
		expect(doc.services['pv-blog-feat-x']?.networks).toEqual(['web', 'default'])
		expect(Object.keys(doc.networks)).toEqual(['web'])
		expect(yaml).not.toMatch(/\binternal\b/)
	})
	it('passes the compose safety authority', () => {
		const v = composeViolations(doc, {
			appName: 'pv-blog-feat-x',
			projectDir: '/opt/apps/pv-blog-feat-x',
			routeHosts: ['pv-blog-feat-x.apps.example.com'],
			extraEnvFiles: ['/opt/apps/blog.preview.env'],
			resolved: false,
		})
		expect(v).toEqual([])
	})
})
