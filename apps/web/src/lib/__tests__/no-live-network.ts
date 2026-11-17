import http from 'node:http'
import https from 'node:https'
import { afterAll, afterEach } from 'vitest'

// Installed for every test file by vitest.setup.ts. A test never reaches a real
// service: no request from a test may leave the machine, so a placeholder token
// can never land on a live telemetry or alert endpoint. Every fetch, http.request and https.request to a host that is
// not loopback or a reserved test name (RFC 2606/6761: localhost, .test,
// .example, .invalid, .localhost, example.com/net/org) is refused without
// touching the network, and the test that made it fails in afterEach (or in
// afterAll for a request from module load or a beforeAll/afterAll hook): the
// telemetry code swallows its own errors on purpose, so the refusal alone would
// pass unnoticed. A single-label name ("hq") is not safe: on a private overlay
// network (Tailscale's short names, for one) it can resolve to a real machine. A test that mocks fetch itself (vi.spyOn /
// vi.stubGlobal) is not affected while its mock is in place.

const RESERVED_SUFFIXES = ['.test', '.example', '.invalid', '.localhost']
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org']

export function isOfflineHost(rawHost: string): boolean {
	const host = rawHost
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '')
	if (host === '' || host === 'localhost' || host === '0.0.0.0') return true
	if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true
	// IPv6 loopback in any spelling (::1, 0:0:0:0:0:0:0:1) and IPv4-mapped 127.x
	if (/^(0{0,4}:){2,7}0{0,3}1$/.test(host)) return true
	if (/^(0{0,4}:){2,5}ffff:127\.\d+\.\d+\.\d+$/.test(host)) return true
	if (RESERVED_SUFFIXES.some((s) => host.endsWith(s))) return true
	return RESERVED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
}

export function hostOf(target: unknown): string | null {
	try {
		if (typeof target === 'string' || target instanceof URL) return new URL(String(target)).hostname
		if (target instanceof Request) return new URL(target.url).hostname
	} catch {
		return null // not a URL: fetch itself rejects it, nothing leaves the process
	}
	if (target && typeof target === 'object') {
		const o = target as { hostname?: string | null; host?: string | null }
		if (o.hostname) return o.hostname
		const host = o.host ?? 'localhost'
		// host may carry a port ("api.x.com:443"); a bare IPv6 address has several colons
		return host.split(':').length <= 2 ? host.replace(/:\d*$/, '') : host
	}
	return null
}

const attempts: string[] = []

/** For the guard's own test: clears what the guard recorded, so that test can pass. */
export function takeAttemptsForTest(): string[] {
	return attempts.splice(0)
}

function refuse(target: unknown): string | null {
	const host = hostOf(target)
	if (host === null || isOfflineHost(host)) return null
	attempts.push(host)
	return `test tried to reach a live host: ${host} (mock fetch instead)`
}

export function installNoLiveNetwork(): void {
	const realFetch = globalThis.fetch
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const refused = refuse(input)
		if (refused) return Promise.reject(new TypeError(refused))
		return realFetch(input, init)
	}) as typeof fetch

	const restores: Array<() => void> = []
	for (const mod of [http, https]) {
		const realRequest = mod.request
		const realGet = mod.get
		const guard = <T extends (...args: never[]) => unknown>(real: T): T =>
			((...args: Parameters<T>) => {
				const refused = refuse(args[0])
				if (refused) throw new Error(refused)
				return real(...args)
			}) as T
		mod.request = guard(realRequest)
		mod.get = guard(realGet)
		restores.push(() => {
			mod.request = realRequest
			mod.get = realGet
		})
	}

	afterEach(() => {
		if (attempts.length === 0) return
		const hosts = [...new Set(attempts.splice(0))]
		throw new Error(
			`This test sent a real network request to ${hosts.join(', ')}. Mock fetch instead.`,
		)
	})
	afterAll(() => {
		globalThis.fetch = realFetch
		for (const restore of restores) restore()
		// requests from module load or beforeAll/afterAll hooks never reach afterEach
		if (attempts.length === 0) return
		const hosts = [...new Set(attempts.splice(0))]
		throw new Error(
			`This test file sent a real network request to ${hosts.join(', ')} outside a test. Mock fetch instead.`,
		)
	})
}
