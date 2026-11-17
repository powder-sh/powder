// Traefik merges same-named routers/services/middlewares across containers,
// so an app labelling `traefik.http.routers.<other-app>...` rewrites that app's route.
// Only own names (`<app>` / `<app>-...`) may be defined or referenced.
import { describe, expect, it } from 'vitest'
import { renderLabelsBlock } from '../app-domains'
import { renderComposeYaml } from '../compose-render'
import {
	type ComposeGuardContext,
	composeViolations,
	isHighSeverity,
	parseComposeYaml,
} from '../compose-safety'

const ctx: ComposeGuardContext = {
	appName: 'myapp',
	projectDir: '/opt/apps/myapp',
	routeHosts: ['myapp.com'],
	resolved: true,
}

function codes(labels: Record<string, string>) {
	return composeViolations(
		{ name: 'myapp', services: { myapp: { image: 'myapp:latest', labels } } },
		ctx,
	)
		.filter((v) => v.code === 'traefik_name')
		.map((v) => v.message)
}

describe('traefik_name', () => {
	it('refuses objects named after another app', () => {
		expect(codes({ 'traefik.http.routers.victim.rule': 'Host(`myapp.com`)' })).toHaveLength(1)
		expect(codes({ 'traefik.http.services.victim.loadbalancer.server.port': '80' })).toHaveLength(1)
		expect(
			codes({ 'traefik.http.middlewares.victim-diag.headers.customresponseheaders.X': 'y' }),
		).toHaveLength(1)
		expect(
			codes({ 'traefik.http.serversTransports.victim.insecureSkipVerify': 'true' }),
		).toHaveLength(1)
		expect(codes({ 'traefik.tcp.routers.victim.rule': 'HostSNI(`*`)' })).toHaveLength(1)
		// a prefix that is not followed by `-` is another name
		expect(codes({ 'traefik.http.routers.myappx.entrypoints': 'websecure' })).toHaveLength(1)
	})

	it('refuses router references to another app (service, middlewares, chain)', () => {
		expect(codes({ 'traefik.http.routers.myapp.service': 'victim' })).toHaveLength(1)
		expect(codes({ 'traefik.http.routers.myapp.service': 'victim@docker' })).toHaveLength(1)
		expect(
			codes({ 'traefik.http.routers.myapp.middlewares': 'myapp-diag,victim-auth@file' }),
		).toHaveLength(1)
		expect(
			codes({ 'traefik.http.middlewares.myapp-c.chain.middlewares': 'victim-auth' }),
		).toHaveLength(1)
		expect(
			codes({ 'traefik.http.routers.myapp.middlewares': 'myapp-x@kubernetescrd' }),
		).toHaveLength(1)
	})

	it('allows own names, @docker/@file for own names, and is high severity', () => {
		expect(
			codes({
				'traefik.enable': 'true',
				'traefik.http.routers.myapp.rule': 'Host(`myapp.com`)',
				'traefik.http.routers.myapp-www.rule': 'Host(`myapp.com`)',
				'traefik.http.routers.MyApp-www.service': 'myapp@docker',
				'traefik.http.routers.myapp.middlewares': 'myapp-diag, myapp-auth@file',
				'traefik.http.services.myapp.loadbalancer.server.port': '3000',
			}),
		).toEqual([])
		const v = composeViolations(
			{
				name: 'myapp',
				services: {
					myapp: { labels: { 'traefik.http.routers.victim.rule': 'Host(`myapp.com`)' } },
				},
			},
			ctx,
		).find((x) => x.code === 'traefik_name')
		expect(v && isHighSeverity(v)).toBe(true)
	})

	it('passes every label set powder renders itself', () => {
		const yaml = renderComposeYaml({
			name: 'myapp',
			dockerfilePath: 'Dockerfile',
			hostPort: null,
			containerPort: 3000,
			envFilePath: '/opt/apps/myapp.env',
			publicHost: 'myapp.com',
			healthUrl: '/api/health',
			postgres: null,
			kv: null,
		})
		const doc = parseComposeYaml(yaml)
		expect(
			composeViolations(doc, { ...ctx, resolved: false }).filter((v) => v.code === 'traefik_name'),
		).toEqual([])
		const block = renderLabelsBlock({
			containerName: 'myapp',
			hosts: ['myapp.com'],
			containerPort: 3000,
			redirects: {
				redirects: [{ from: '^https://www\\.myapp\\.com/(.*)', to: 'https://myapp.com/$1' }],
				rewrites: [{ source: '^/old/(.*)', destination: '/new/$1' }],
				headers: { 'X-Frame-Options': 'DENY' },
			} as unknown as Parameters<typeof renderLabelsBlock>[0]['redirects'],
		})
		const labels = block
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.startsWith('- '))
			.map((l) => l.slice(2))
		expect(
			composeViolations({ name: 'myapp', services: { myapp: { labels } } }, ctx).filter(
				(v) => v.code === 'traefik_name',
			),
		).toEqual([])
	})
})
