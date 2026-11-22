// Apply per-domain redirect config to whichever proxy fronts the host.
// nginx (on the host, or containerized) writes a managed
// server block per hostname. Traefik (servers.proxy = 'traefik') writes ONE
// file-provider fragment per app, /opt/infra/traefik/dynamic/redirects-<app>.yml,
// holding the redirects of every hostname of that app (watch=true, no reload).
//
// Precondition (checked before every write, see assertTraefikFileProvider): the
// server's `traefik` container must run the file provider on a directory that is
// mounted from /opt/infra/traefik/dynamic, with watch enabled, either as CLI
// flags (--providers.file.directory/--providers.file.watch) or in a mounted
// traefik.yml. Servers with the docker provider only (e.g. a docker-provider-only server) fail the
// apply with an explicit error instead of silently writing a file nobody reads.

import { parse as parseYaml } from 'yaml'
import { assertHostnamesOwned, assertSiblingHostsAllowed } from './domain-ownership'
import { runCommand } from './ssh'
import type { ServerConfig } from './servers'
import { shq } from './shell'
import { traefikFileRouterTls } from './traefik-tls'
import {
	type InspectJson,
	flagValue,
	hostPathOf,
	traefikArgv,
	traefikConfigHostPath,
} from './traefik-network'

export { redirectRowInUse } from './traefik-network'

export interface CustomRedirect {
	from: string // path
	to: string // absolute URL or path
	status?: 301 | 302
}

export interface ApplyInput {
	hostname: string
	wwwMode: 'none' | 'apex' | 'www'
	custom: CustomRedirect[]
}

interface CertPaths {
	cert: string
	key: string
}

export type ProxyKind = 'nginx-host' | 'nginx-container' | 'traefik' | 'unknown'

// servers.proxy decides: 'traefik', 'nginx' (host nginx) or 'nginx-container'
// (nginx runs in a container). No proxy value => 'unknown'.
export function detectProxyKind(server: {
	id: string
	proxy?: 'nginx' | 'nginx-container' | 'traefik' | null
}): ProxyKind {
	if (server.proxy === 'traefik') return 'traefik'
	if (server.proxy === 'nginx-container') return 'nginx-container'
	if (server.proxy === 'nginx') return 'nginx-host'
	return 'unknown'
}

const MANAGED_DIR_HOST = '/etc/nginx/sites-enabled'
const MANAGED_DIR_CONTAINER = '/etc/nginx/conf.d'

// Filename pattern: powder-redirects.<hostname>.conf
function managedFileName(hostname: string): string {
	const safe = hostname.replace(/[^a-z0-9.-]/gi, '_')
	return `powder-redirects.${safe}.conf`
}

export function renderNginxConfig(input: ApplyInput, ssl: CertPaths | null): string {
	const { hostname, wwwMode, custom } = input
	const apex = hostname.replace(/^www\./, '')
	const www = `www.${apex}`

	const lines: string[] = []
	lines.push(`# Managed by Powder. Edits will be overwritten.`)
	lines.push(`# hostname=${hostname} wwwMode=${wwwMode} customs=${custom.length} ssl=${ssl ? 'yes' : 'no'}`)

	// Always answer port 80 (HTTP). If we know the cert paths from the apex
	// vhost, also answer port 443 — otherwise Cloudflare in Full-SSL mode
	// hits 443 and gets nothing.
	const sslLines = (target: string) => {
		const out: string[] = [`  listen 80;`]
		if (ssl) {
			out.push(`  listen 443 ssl;`)
			out.push(`  ssl_certificate ${ssl.cert};`)
			out.push(`  ssl_certificate_key ${ssl.key};`)
		}
		out.push(`  server_name ${target};`)
		return out
	}

	if (wwwMode === 'apex') {
		lines.push('', 'server {', ...sslLines(www))
		lines.push(`  return 301 https://${apex}$request_uri;`)
		lines.push('}')
	} else if (wwwMode === 'www') {
		lines.push('', 'server {', ...sslLines(apex))
		lines.push(`  return 301 https://${www}$request_uri;`)
		lines.push('}')
	}

	if (custom.length > 0) {
		lines.push('', 'server {', ...sslLines(hostname))
		for (const r of custom) {
			// only 301/302 ever reach the config text, whatever the JSON said.
			const code = redirectStatus(r.status)
			lines.push(`  location = ${quoteValue(r.from)} { return ${code} ${quoteValue(r.to)}; }`)
		}
		lines.push('}')
	}

	return lines.join('\n') + '\n'
}

// Find the ssl_certificate / ssl_certificate_key paths that the apex's
// existing vhost uses, by greping the nginx config. We just want the first
// match — most setups use a single shared cert (or per-domain certs that
// happen to cover the apex+www).
//
// `readCmd` should print the merged nginx config to stdout. For host nginx:
//   `cat /etc/nginx/sites-enabled/*`. For containerized:
//   `docker exec <c> nginx -T 2>/dev/null`.
function findCertForHostname(text: string, hostname: string): CertPaths | null {
	const apex = hostname.replace(/^www\./, '')
	// split into server blocks
	const blocks = text.split(/\bserver\s*\{/).slice(1)
	for (const b of blocks) {
		const closeIdx = findClose(b)
		const body = closeIdx === -1 ? b : b.slice(0, closeIdx)
		const namesMatch = body.match(/server_name\s+([^;]+);/)
		if (!namesMatch) continue
		const names = (namesMatch[1] ?? '').trim().split(/\s+/)
		if (!names.includes(apex) && !names.includes(`www.${apex}`)) continue
		const certMatch = body.match(/ssl_certificate\s+([^;]+);/)
		const keyMatch = body.match(/ssl_certificate_key\s+([^;]+);/)
		if (certMatch?.[1] && keyMatch?.[1]) {
			return { cert: certMatch[1].trim(), key: keyMatch[1].trim() }
		}
	}
	return null
}

function findClose(s: string): number {
	let depth = 1
	for (let i = 0; i < s.length; i++) {
		if (s[i] === '{') depth++
		else if (s[i] === '}') {
			depth--
			if (depth === 0) return i
		}
	}
	return -1
}

// Detects whether the existing nginx config (already-merged text) ALREADY
// redirects www.<apex> → <apex> (or apex → www) for a given hostname.
// Returns 'apex' if www→apex is already in place, 'www' if apex→www, or null.
//
// Looks at:
//  - explicit blocks: server { server_name www.X; return 301 https://X...; }
//  - regex catch-all: server { server_name ~^www\..+$; return 301 https://$bare...; }
//
// Used to suppress redundant "apply" buttons in /domains.
export function detectExistingRedirect(text: string, hostname: string): 'apex' | 'www' | null {
	const apex = hostname.replace(/^www\./, '')
	const www = `www.${apex}`
	const blocks = text.split(/\bserver\s*\{/).slice(1)

	let hasCatchAllWwwToBare = false

	for (const b of blocks) {
		const closeIdx = findClose(b)
		const body = closeIdx === -1 ? b : b.slice(0, closeIdx)
		const namesMatch = body.match(/server_name\s+([^;]+);/)
		if (!namesMatch) continue
		const namesRaw = (namesMatch[1] ?? '').trim()
		const returnMatch = body.match(/return\s+30[12]\s+(https?:\/\/[^\s;$]*)/i)
		if (!returnMatch) continue
		const target = returnMatch[1] ?? ''

		// Case A: explicit www → apex
		if (
			namesRaw.split(/\s+/).includes(www) &&
			(target === `https://${apex}` || target === `http://${apex}`)
		) {
			return 'apex'
		}
		// Case B: explicit apex → www
		if (
			namesRaw.split(/\s+/).includes(apex) &&
			(target === `https://${www}` || target === `http://${www}`)
		) {
			return 'www'
		}
		// Case C: regex catch-all `~^www\.` → bare. Affects every apex on the server.
		if (/~\^www\\?\./.test(namesRaw) && /\$\{?bare\}?/.test(target)) {
			hasCatchAllWwwToBare = true
		}
	}

	if (hasCatchAllWwwToBare) return 'apex'
	return null
}

// Writes the managed nginx config and reloads nginx. Returns the path it wrote.
export async function applyToNginxHost(
	server: ServerConfig,
	input: ApplyInput,
	owner: Owner,
): Promise<string> {
	await assertWritableHostnamesOwned(owner, [input])
	const file = `${MANAGED_DIR_HOST}/${managedFileName(input.hostname)}`
	if (input.wwwMode === 'none' && input.custom.length === 0) {
		const { code, stdout, stderr } = await runCommand(
			server,
			`rm -f ${shq(file)} && nginx -t && nginx -s reload`,
			15_000,
		)
		if (code !== 0) {
			throw new Error(stderr.trim() || stdout.trim() || `nginx reload failed (exit ${code})`)
		}
		return file
	}

	// Sniff the apex's existing cert from the host config so we can also
	// answer port 443 (Cloudflare Full-SSL hits 443).
	const cfg = await runCommand(
		server,
		`{ cat /etc/nginx/sites-enabled/*; cat /etc/nginx/conf.d/*.conf 2>/dev/null; } 2>/dev/null`,
		8_000,
	)
	// Exclude our own managed file from the search (avoid feedback loop).
	const ssl = findCertForHostname(
		stripManagedSection(cfg.stdout, input.hostname),
		input.hostname,
	)

	const conf = renderNginxConfig(input, ssl)
	const b64 = Buffer.from(conf, 'utf8').toString('base64')
	const cmd =
		`printf %s ${shq(b64)} | base64 -d > ${shq(file)} && ` +
		`nginx -t && nginx -s reload`
	const { code, stderr } = await runCommand(server, cmd, 20_000)
	if (code !== 0) throw new Error(stderr || `nginx reload failed (exit ${code})`)
	return file
}

function stripManagedSection(text: string, hostname: string): string {
	// Crude — drops anything after our managed-by-Powder marker for this host.
	// Just enough to keep findCertForHostname from matching its own output.
	const marker = `# hostname=${hostname}`
	const i = text.indexOf(marker)
	return i === -1 ? text : text.slice(0, i)
}

export async function applyToNginxContainer(
	server: ServerConfig,
	input: ApplyInput,
	owner: Owner,
	nginxContainerName = 'nginx',
): Promise<string> {
	await assertWritableHostnamesOwned(owner, [input])
	const fileName = managedFileName(input.hostname)
	// Find the host directory bind-mounted to /etc/nginx/conf.d in the container.
	// That is a host dir (e.g. a host conf.d dir), and the container mount is ro,
	// so writing INSIDE the container fails: write to the host path.
	const inspect = await runCommand(
		server,
		`docker inspect ${nginxContainerName} --format '{{range .Mounts}}{{if eq .Destination "${MANAGED_DIR_CONTAINER}"}}{{.Source}}{{end}}{{end}}'`,
		8_000,
	)
	const hostDir = inspect.stdout.trim()
	if (!hostDir) {
		throw new Error(
			`could not find a host bind-mount for ${MANAGED_DIR_CONTAINER} in ${nginxContainerName}`,
		)
	}
	const hostPath = `${hostDir}/${fileName}`

	if (input.wwwMode === 'none' && input.custom.length === 0) {
		const { code, stderr } = await runCommand(
			server,
			`rm -f ${shq(hostPath)} && docker exec ${nginxContainerName} nginx -t && docker exec ${nginxContainerName} nginx -s reload`,
			20_000,
		)
		if (code !== 0) throw new Error(stderr || `nginx-in-container reload failed (exit ${code})`)
		return hostPath
	}

	// Sniff cert from the merged container config (nginx -T dumps it all).
	const cfg = await runCommand(
		server,
		`docker exec ${nginxContainerName} nginx -T 2>/dev/null`,
		10_000,
	)
	const ssl = findCertForHostname(
		stripManagedSection(cfg.stdout, input.hostname),
		input.hostname,
	)

	const conf = renderNginxConfig(input, ssl)
	const b64 = Buffer.from(conf, 'utf8').toString('base64')
	const cmd =
		`printf %s ${shq(b64)} | base64 -d > ${shq(hostPath)} && ` +
		`docker exec ${nginxContainerName} nginx -t && ` +
		`docker exec ${nginxContainerName} nginx -s reload`
	const { code, stderr } = await runCommand(server, cmd, 20_000)
	if (code !== 0) throw new Error(stderr || `nginx-in-container reload failed (exit ${code})`)
	return hostPath
}

type Owner = { serverId: string; containerName: string }

// every hostname that gets a router / server block must be one of this
// app's own verified/live domains. Inputs that write nothing (wwwMode none, no
// custom rules) are cleanups and stay allowed so stale files can be removed.
async function assertWritableHostnamesOwned(owner: Owner, inputs: ApplyInput[]): Promise<void> {
	const writing = inputs.filter((i) => i.wwwMode !== 'none' || i.custom.length > 0)
	await assertHostnamesOwned(
		owner,
		writing.map((i) => i.hostname),
	)
	// the www/apex router or server_name answers on the SIBLING host too.
	const siblings = writing
		.map((i) => wwwRedirectHost(i))
		.filter((h): h is string => !!h && !writing.some((i) => i.hostname.toLowerCase() === h))
	await assertSiblingHostsAllowed(owner, [...new Set(siblings)])
}

/** The host a www/apex redirect answers on (Traefik router rule / nginx server_name):
 *  www.<apex> for wwwMode apex, <apex> for wwwMode www, null otherwise. Lowercase. */
export function wwwRedirectHost(input: Pick<ApplyInput, 'hostname' | 'wwwMode'>): string | null {
	const apex = input.hostname.replace(/^www\./i, '').toLowerCase()
	if (input.wwwMode === 'apex') return `www.${apex}`
	if (input.wwwMode === 'www') return apex
	return null
}

// Directory of Traefik's file provider on the server. POWDER_TRAEFIK_DYNAMIC_DIR
// overrides it.
const DEFAULT_TRAEFIK_DYNAMIC_DIR = '/opt/infra/traefik/dynamic'
function resolveTraefikDynamicDir(raw: string | undefined): string {
	const v = raw?.trim().replace(/\/+$/, '')
	if (!v) return DEFAULT_TRAEFIK_DYNAMIC_DIR
	// It ends up in shell commands: a plain absolute path only.
	if (/^\/[A-Za-z0-9._/-]+$/.test(v) && !v.includes('..')) return v
	console.warn('[domain-redirects] ignoring invalid POWDER_TRAEFIK_DYNAMIC_DIR')
	return DEFAULT_TRAEFIK_DYNAMIC_DIR
}
export const TRAEFIK_DYNAMIC_DIR = resolveTraefikDynamicDir(process.env.POWDER_TRAEFIK_DYNAMIC_DIR)
const TRAEFIK_REDIRECT_PRIORITY = 300

export function traefikRedirectFile(containerName: string): string {
	const safe = containerName.replace(/[^a-z0-9.-]/gi, '_')
	return `${TRAEFIK_DYNAMIC_DIR}/redirects-${safe}.yml`
}

function yamlSingle(s: string): string {
	return `'${s.replace(/'/g, "''")}'`
}

function reEscape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hostSlug(hostname: string): string {
	return hostname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

const SAFE_HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i

// Renders the file-provider fragment for every hostname of one app. Returns
// null when there is nothing to redirect (caller deletes the file). Each
// redirect is a redirectRegex middleware plus a router on websecure at
// priority 300 (above the app routers, which sit at 100) with
// service noop@internal. tlsMode mirrors the app router: 'acme' asks resolver
// le, 'origin-cert' serves the default-store cert (tls: {}).
export function renderTraefikRedirects(
	containerName: string,
	inputs: ApplyInput[],
	tlsMode: 'acme' | 'origin-cert' = 'acme',
): string | null {
	const tls = traefikFileRouterTls(tlsMode)
	// Keyed by name so a repeated name can never produce a duplicate YAML key
	// (Traefik drops the whole fragment on one).
	const mws = new Map<string, string>()
	const routers = new Map<string, string>()
	const add = (name: string, host: string, path: string | null, regex: string, replacement: string, permanent: boolean) => {
		const rule = path ? `Host(\`${host}\`) && Path(\`${path}\`)` : `Host(\`${host}\`)`
		mws.set(
			name,
			`    ${name}:\n      redirectRegex:\n        regex: ${yamlSingle(regex)}\n        replacement: ${yamlSingle(replacement)}\n        permanent: ${permanent}`,
		)
		routers.set(
			name,
			`    ${name}:\n      rule: ${yamlSingle(rule)}\n      entryPoints: [websecure]\n      priority: ${TRAEFIK_REDIRECT_PRIORITY}\n      middlewares: [${name}]\n      service: noop@internal\n      tls: ${tls}`,
		)
	}

	const header: string[] = ['# Managed by Powder. Edits will be overwritten.']
	for (const input of inputs) {
		if (!SAFE_HOSTNAME.test(input.hostname)) throw new Error(`unsafe hostname: ${input.hostname}`)
		const apex = input.hostname.replace(/^www\./, '').toLowerCase()
		const www = `www.${apex}`
		// From the stored hostname, not the apex: rows for x.com and www.x.com
		// must not share names.
		const slug = `redir-${hostSlug(containerName)}-${hostSlug(input.hostname)}`
		if (input.wwwMode === 'apex') {
			header.push(`# hostname=${apex} wwwMode=apex`)
			add(`${slug}-www`, www, null, `^https?://${reEscape(www)}(.*)`, `https://${apex}\${1}`, true)
		} else if (input.wwwMode === 'www') {
			header.push(`# hostname=${apex} wwwMode=www`)
			add(`${slug}-apex`, apex, null, `^https?://${reEscape(apex)}(.*)`, `https://${www}\${1}`, true)
		}
		input.custom.forEach((r, i) => {
			if (!r.from.startsWith('/') || /[\s`'"\\]/.test(r.from)) {
				throw new Error(`unsafe redirect path: ${r.from}`)
			}
			if (/[\r\n]/.test(r.to)) throw new Error('unsafe redirect target')
			const host = input.hostname.toLowerCase()
			// Exact path match like the nginx `location =`; query string is dropped.
			const regex = `^https?://${reEscape(host)}${reEscape(r.from)}(\\?.*)?$`
			const target = r.to.startsWith('/') ? `https://${host}${r.to}` : r.to
			add(
				`${slug}-c${i + 1}`,
				host,
				r.from,
				regex,
				target.replace(/\$/g, '$$$$'),
				redirectStatus(r.status) === 301,
			)
		})
	}
	if (mws.size === 0) return null
	return (
		[...header, 'http:', '  middlewares:', ...mws.values(), '  routers:', ...routers.values()].join('\n') +
		'\n'
	)
}

const TRAEFIK_CONTAINER = 'traefik'

export type FileProviderCheck =
	| { state: 'ok' }
	| { state: 'need-config'; configHostPath: string }
	| { state: 'fail' }

// Pure: does `docker inspect traefik` show a watched file provider on a
// directory mounted from `dynamicDir`? 'need-config' means the settings live in
// a config file (traefikConfigHostPath); the caller reads that host file and uses
// fileProviderFromYml.
export function checkFileProviderFromInspect(
	inspect: InspectJson,
	dynamicDir: string = TRAEFIK_DYNAMIC_DIR,
): FileProviderCheck {
	const mounts = inspect.Mounts ?? []
	const argv = traefikArgv(inspect)
	const dir = flagValue(argv, 'providers.file.directory')
	if (typeof dir === 'string') {
		const watch = flagValue(argv, 'providers.file.watch')
		const watchOn = watch === null || (typeof watch === 'string' && watch !== 'false')
		const host = hostPathOf(mounts, dir.replace(/\/+$/, ''))
		return watchOn && host === dynamicDir ? { state: 'ok' } : { state: 'fail' }
	}
	const cfgHost = traefikConfigHostPath(inspect)
	if (cfgHost) return { state: 'need-config', configHostPath: cfgHost }
	return { state: 'fail' }
}

// Pure: traefik.yml content -> watched file provider directory?
export function fileProviderFromYml(
	text: string,
	inspect: InspectJson,
	dynamicDir: string = TRAEFIK_DYNAMIC_DIR,
): boolean {
	let doc: unknown
	try {
		doc = parseYaml(text)
	} catch {
		return false
	}
	const f = (doc as { providers?: { file?: { directory?: unknown; watch?: unknown } } } | null)
		?.providers?.file
	if (!f || typeof f.directory !== 'string') return false
	if (f.watch !== true && f.watch !== 'true') return false
	return hostPathOf(inspect.Mounts ?? [], f.directory.replace(/\/+$/, '')) === dynamicDir
}

function noFileProviderError(server: ServerConfig): Error {
	return new Error(
		`Traefik on ${server.id} has no file provider for ${TRAEFIK_DYNAMIC_DIR} (add providers.file.directory + watch and mount it)`,
	)
}

// Throws unless the server's traefik container reads TRAEFIK_DYNAMIC_DIR.
export async function assertTraefikFileProvider(server: ServerConfig): Promise<void> {
	const ins = await runCommand(server, `docker inspect ${TRAEFIK_CONTAINER}`, 10_000)
	if (ins.code !== 0) throw noFileProviderError(server)
	let inspect: InspectJson
	try {
		inspect = (JSON.parse(ins.stdout) as InspectJson[])[0] ?? {}
	} catch {
		throw noFileProviderError(server)
	}
	const check = checkFileProviderFromInspect(inspect)
	if (check.state === 'ok') return
	if (check.state === 'need-config') {
		const cat = await runCommand(server, `cat ${shq(check.configHostPath)}`, 10_000)
		if (cat.code === 0 && fileProviderFromYml(cat.stdout, inspect)) return
	}
	throw noFileProviderError(server)
}

// Writes (or removes) /opt/infra/traefik/dynamic/redirects-<app>.yml over ssh.
// The file provider watches the directory, so no reload is needed. Written
// via a temp file + mv so Traefik never reads a half-written fragment.
export async function applyToTraefik(
	server: ServerConfig,
	containerName: string,
	inputs: ApplyInput[],
): Promise<string> {
	await assertWritableHostnamesOwned({ serverId: server.id, containerName }, inputs)
	const file = traefikRedirectFile(containerName)
	const yml = renderTraefikRedirects(containerName, inputs, server.tlsMode ?? 'acme')
	if (yml === null) {
		const { code, stderr } = await runCommand(server, `rm -f ${shq(file)}`, 10_000)
		if (code !== 0) throw new Error(stderr || `traefik redirect cleanup failed (exit ${code})`)
		return file
	}
	await assertTraefikFileProvider(server)
	const b64 = Buffer.from(yml, 'utf8').toString('base64')
	const cmd =
		`mkdir -p ${shq(TRAEFIK_DYNAMIC_DIR)} && ` +
		`printf %s ${shq(b64)} | base64 -d > ${shq(file + '.tmp')} && mv ${shq(file + '.tmp')} ${shq(file)}`
	const { code, stderr } = await runCommand(server, cmd, 15_000)
	if (code !== 0) throw new Error(stderr || `traefik redirect write failed (exit ${code})`)
	return file
}

/** On an app delete: remove every proxy redirect powder wrote for the app, so none
 *  outlives it. Traefik: the app's file (applyToTraefik with no inputs renders
 *  nothing, which removes the file), always, whatever the rows say. nginx: the
 *  managed file of each hostname in `appliedHostnames` (the app's domain_redirects
 *  rows that were applied). A proxy powder does not know wrote nothing. Throws when
 *  a removal fails; returns a line for the delete log, or null when nothing was
 *  written for the app. */
export async function removeAppRedirects(
	server: ServerConfig,
	containerName: string,
	appliedHostnames: readonly string[],
): Promise<string | null> {
	const kind = detectProxyKind(server)
	if (kind === 'traefik') return `redirects: removed ${await applyToTraefik(server, containerName, [])}`
	if (kind === 'unknown' || appliedHostnames.length === 0) return null
	const owner = { serverId: server.id, containerName }
	for (const hostname of appliedHostnames) {
		const input: ApplyInput = { hostname, wwwMode: 'none', custom: [] }
		if (kind === 'nginx-host') await applyToNginxHost(server, input, owner)
		else await applyToNginxContainer(server, input, owner)
	}
	return `redirects: removed the nginx redirect files of ${appliedHostnames.join(', ')}`
}

export function redirectStatus(status: unknown): 301 | 302 {
	return status === 302 ? 302 : 301
}

function quoteValue(s: string): string {
	// nginx string literal: wrap in double quotes, escape backslash + quotes.
	// nginx expands $vars inside quoted strings and has no `\$` escape, so a
	// literal $ is percent-encoded.
	return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '%24')}"`
}
