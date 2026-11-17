// Traefik Host rules are not enforced only on servers marked proxy='traefik': a server
// marked nginx that runs its own Docker-provider Traefik routes any label an app writes.
// The compose check probe reports running Docker-provider proxies and the app's hosts
// are enforced there too.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeViolations } from '../compose-safety'
import {
	DOCKER_PROXY_OK,
	DOCKER_PROXY_PROBE,
	deployGuardContext,
	effectiveRouteHosts,
	parseComposeProbe,
	parseDockerProxyProbe,
} from '../deploy/compose-check'
import { writeFakeDocker } from './fixtures/fake-docker'

const DOCKER = `#!/bin/sh
case "$1" in
  ps) printf 'c1\\nc2\\nc3\\nc4\\n';;
  inspect)
    printf '/edge\\ttraefik:v3.6\\t[]nullnull[]\\n'
    printf '/router\\tacme/router:1\\t["--providers.docker=true"]nullnull[]\\n'
    printf '/envrouter\\tacme/edge:2\\t[]nullnull["TRAEFIK_PROVIDERS_DOCKER=true","SECRET=abc"]\\n'
    printf '/shop\\tshop:latest\\t["node","server.js"]nullnull["DOCKER_HOST=x"]\\n';;
esac
`

function runProbe(): string {
	const root = mkdtempSync(join(tmpdir(), 'px24-'))
	const stubs = join(root, 'stubs')
	mkdirSync(stubs)
	writeFakeDocker(stubs, DOCKER)
	const r = spawnSync('sh', ['-c', DOCKER_PROXY_PROBE], { env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` }, encoding: 'utf8' })
	return r.stdout
}

const cfg = (rule: string) => ({
	name: 'shop',
	services: { shop: { image: 'shop:latest', container_name: 'shop', labels: { 'traefik.enable': 'true', 'traefik.http.routers.shop.rule': rule } } },
})

function ctxFor(dockerProxies: string[] | undefined, routeHosts: string[] | null, proxyRouteHosts?: string[]) {
	return deployGuardContext(
		{ resolved: { name: 'shop' }, raw: null, hash: 'x', containers: [], ...(dockerProxies ? { dockerProxies } : {}) },
		{ appName: 'shop', workingDir: '/opt/apps/shop', composeFiles: ['/opt/apps/shop/docker-compose.yml'], serverId: 's1', routeHosts, ...(proxyRouteHosts ? { proxyRouteHosts } : {}) },
	)
}

describe('Docker-provider proxy detection', () => {
	it('the on-server probe flags a traefik image and providers.docker in args or env, and no env leaves the server', () => {
		const out = runProbe()
		expect(out).not.toContain('SECRET=abc')
		expect(parseDockerProxyProbe(out)).toEqual(['edge', 'router', 'envrouter'])
	})

	it('a section without its end marker is unknown', () => {
		expect(parseDockerProxyProbe('/edge\ttraefik:v3.6\t0\n')).toBeUndefined()
		expect(parseDockerProxyProbe(`/x\tdocker.io/library/traefik@sha256:${'a'.repeat(64)}\t0\n${DOCKER_PROXY_OK}\n`)).toEqual(['x'])
		expect(parseDockerProxyProbe(`/x\tacme/traefik-ui:1\t0\n${DOCKER_PROXY_OK}\n`)).toEqual([])
	})

	it('parseComposeProbe reads the 15th section', () => {
		const sep = 'SEP'
		const parts = ['a'.repeat(64), '{"name":"shop"}', '', '', '', '', '', '', '', '', '', '', '', '', `/edge\ttraefik:v3.6\t0\n${DOCKER_PROXY_OK}`]
		expect(parseComposeProbe(parts.join(`\n${sep}\n`), sep)?.dockerProxies).toEqual(['edge'])
	})

	it('effectiveRouteHosts: marked traefik wins; a running proxy enforces the app hosts; else unchecked', () => {
		expect(effectiveRouteHosts({ dockerProxies: [] }, { routeHosts: ['a.example'] })).toEqual(['a.example'])
		expect(effectiveRouteHosts({ dockerProxies: ['edge'] }, { routeHosts: null, proxyRouteHosts: ['b.example'] })).toEqual(['b.example'])
		expect(effectiveRouteHosts({ dockerProxies: ['edge'] }, { routeHosts: null, proxyRouteHosts: [] })).toEqual([])
		expect(effectiveRouteHosts({ dockerProxies: [] }, { routeHosts: null, proxyRouteHosts: ['b.example'] })).toBeNull()
		expect(effectiveRouteHosts({}, { routeHosts: null, proxyRouteHosts: ['b.example'] })).toBeNull()
	})

	it('a server marked nginx with a running Traefik refuses a Host() outside the app hosts', () => {
		const ctx = ctxFor(['edge'], null, ['shop.example.com'])
		const v = composeViolations(cfg('Host(`victim.example.org`)'), ctx)
		expect(v.map((x) => x.code)).toContain('traefik_host')
		expect(composeViolations(cfg('Host(`shop.example.com`)'), ctx).map((x) => x.code)).not.toContain('traefik_host')
		expect(composeViolations(cfg('Host(`victim.example.org`)'), ctxFor([], null, ['shop.example.com'])).map((x) => x.code)).not.toContain('traefik_host')
	})
})

describe('tls.domains main / sans only name the app hosts', () => {
	const tls = (k: string, v: string) => ({
		name: 'shop',
		services: { shop: { image: 'shop:latest', container_name: 'shop', labels: { 'traefik.enable': 'true', 'traefik.http.routers.shop.rule': 'Host(`shop.example.com`)', [`traefik.http.routers.shop.tls.domains[0].${k}`]: v } } },
	})
	const ctx = ctxFor(undefined, ['shop.example.com', 'www.shop.example.com'])
	const codes = (c: unknown) => composeViolations(c, ctx).map((x) => x.message)

	it('refuses a main or a san outside the app hosts', () => {
		expect(codes(tls('main', 'victim.example.org')).join('\n')).toMatch(/TLS domain "victim\.example\.org"/)
		expect(codes(tls('sans', 'www.shop.example.com,*.example.org')).join('\n')).toMatch(/TLS domain "\*\.example\.org"/)
	})
	it('keeps the app hosts', () => {
		expect(codes(tls('main', 'shop.example.com')).join('\n')).not.toMatch(/TLS domain/)
		expect(codes(tls('sans', 'www.shop.example.com, shop.example.com')).join('\n')).not.toMatch(/TLS domain/)
	})
	it('unchecked when the server routes no Traefik labels', () => {
		expect(composeViolations(tls('main', 'victim.example.org'), ctxFor(undefined, null)).map((x) => x.message).join('\n')).not.toMatch(/TLS domain/)
	})
})
