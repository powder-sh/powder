// Custom-domain attach for Traefik servers (servers.proxy = 'traefik').
// Verifies DNS, rewrites the app's compose Traefik labels to include the new
// host(s), recreates the container. With tls_mode 'acme' the cert auto-issues
// via Traefik HTTP-01 on the first https hit (certresolver le); with
// 'origin-cert' the router only sets tls=true and Traefik serves its default
// store (Cloudflare origin cert).
//
// Scope: routers carry a single `Host(...) || Host(...)` rule built from the
// auto-assigned host plus live app_domains rows. Extra non-Host rules
// (wildcards, www variants, PathPrefix) are out of scope here; keep those in
// the Traefik file provider (/opt/infra/traefik/dynamic), because this module
// rewrites the whole labels list on every apply.

import { randomBytes } from 'node:crypto'
import { resolve4, resolveCname, resolveTxt } from 'node:dns/promises'
import { isIPv4 } from 'node:net'
import {
	COMPOSE_FORBIDDEN_WORD_RE,
	composeWordProblem,
	defaultHostFor,
	healthPathFor,
	isRoutedDomain,
	isValidHostname,
	traefikRetryLabels,
} from './app-hosts'
import { checkComposeSafe } from './compose-guard'
import { labelLinesFromBlock, overridePathFor, parseOverrideLabels } from './compose-override'
import { applyComposeOverride } from './compose-override-io'
import {
	and,
	appDomains,
	appRepos,
	createId,
	db,
	eq,
	inArray,
	isNull,
	prefixes,
	sql,
} from './db'
import type { AppDomain, AppRepo } from './db'
import { composeFileArgs, composeUpCommand, readComposeConfig } from './deploy/fragments'
import { isPgError } from './pg-error'
import { buildTraefikLabels, readPowderConfig } from './powder-config'
import { redactNullable, redactSecrets } from './secret-text'
import { getServer } from './servers'
import type { ServerConfig } from './servers'
import { shq } from './shell'
import { inspectContainer, runCommand } from './ssh'
import { drainActiveFor } from './drain-mode'
import { isTraefikServer } from './traefik-servers'
import { traefikRouterTlsLabel } from './traefik-tls'

const ROUTER_PRIORITY = 100

export { isValidHostname }

// Hostnames are globally unique (lower(hostname) index, migration
// 0038), so one tenant cannot claim a hostname another app already holds.
export class HostnameTakenError extends Error {
	constructor(hostname: string) {
		super(`hostname already in use by another app: ${hostname}`)
	}
}

/** Statuses of a row that never proved ownership (a failed TXT check proves
 *  nothing either). A `live` / `verified` row never counts, even without timestamps. */
const UNPROVEN_STATUSES = ['pending', 'verify_failed'] as const

/** a row that proves nothing yet: pending or verify_failed, never
 *  verified, never applied (a hostname discovery inserted, or an unverified claim whose
 *  TXT check failed). addDomain of another app replaces it instead of answering
 *  HostnameTakenError. */
export function isUnprovenClaim(
	d: Pick<AppDomain, 'status' | 'verifiedAt' | 'appliedAt'>,
): boolean {
	return (
		(UNPROVEN_STATUSES as readonly string[]).includes(d.status) && !d.verifiedAt && !d.appliedAt
	)
}

export async function findDomainByHostname(hostname: string): Promise<AppDomain | null> {
	const [row] = await db
		.select()
		.from(appDomains)
		.where(sql`lower(${appDomains.hostname}) = ${hostname.trim().toLowerCase()}`)
		.limit(1)
	return row ?? null
}

export function isUniqueViolation(err: unknown): boolean {
	const e = err as { message?: string } | null
	return isPgError(err, '23505') || /duplicate key/i.test(e?.message ?? '')
}

// Ownership proof: a TXT record `_powder-verify.<host>` carrying the row's
// random token. DNS pointing at our ingress alone proves nothing (anyone can
// point a hostname they do not own at us only if they control its DNS, but a
// live hostname of another tenant already does).
export const VERIFY_TXT_PREFIX = '_powder-verify.'

export async function verifyTxtChallenge(
	hostname: string,
	token: string | null,
	resolver: (name: string) => Promise<string[][]> = resolveTxt,
): Promise<{ ok: boolean; reason?: string }> {
	const name = `${VERIFY_TXT_PREFIX}${hostname.trim().toLowerCase()}`
	if (!token) return { ok: false, reason: `no verification token set; add TXT ${name}` }
	let answers: string[][]
	try {
		answers = await resolver(name)
	} catch {
		return { ok: false, reason: `no TXT record at ${name} yet` }
	}
	if (answers.some((parts) => parts.join('').trim() === token)) return { ok: true }
	return { ok: false, reason: `TXT at ${name} does not contain the verification token` }
}

export function newVerifyToken(): string {
	return randomBytes(16).toString('hex')
}

// Where a custom domain must point: servers.ingress_ip, else the server's host
// when it is an IPv4 literal, else the first A record of the host name.
// Null when none of those yields an address.
export async function ingressTargetFor(
	server: { host: string; ingressIp?: string | null; baseDomain?: string | null },
	resolver: (name: string) => Promise<string[]> = resolve4,
): Promise<{ ip: string; cnameTarget: string | null } | null> {
	const cnameTarget = server.baseDomain ? `${server.baseDomain}.` : null
	const explicit = server.ingressIp?.trim()
	if (explicit && isIPv4(explicit)) return { ip: explicit, cnameTarget }
	const host = server.host.trim()
	if (isIPv4(host)) return { ip: host, cnameTarget }
	try {
		const ip = (await resolver(host))[0]
		return ip ? { ip, cnameTarget } : null
	} catch {
		return null
	}
}

// Returns true if the hostname's DNS already points at us (A record matches
// the ingress IP, or CNAME points at the server's base domain).
export async function verifyDns(
	hostname: string,
	serverId: string,
): Promise<{
	ok: boolean
	reason?: string
	resolvedTo?: string[]
}> {
	const server = await getServer(serverId)
	const target = server ? await ingressTargetFor(server) : null
	if (!target) {
		return {
			ok: false,
			reason: `no ingress IP for ${serverId}: set ingress_ip on the server's page (/servers/${serverId})`,
		}
	}

	// Try CNAME first (preferred for apex+www together).
	try {
		const cnames = await resolveCname(hostname)
		const cnameTarget = target.cnameTarget?.replace(/\.$/, '') ?? null
		if (cnameTarget && cnames.some((c) => c.endsWith(`.${cnameTarget}`) || c === cnameTarget)) {
			return { ok: true, resolvedTo: cnames }
		}
	} catch {
		// no cname → fall through to A
	}

	try {
		const ips = await resolve4(hostname)
		if (ips.includes(target.ip)) return { ok: true, resolvedTo: ips }
		return {
			ok: false,
			reason: `DNS resolves to ${ips.join(', ')} but expected ${target.ip}`,
			resolvedTo: ips,
		}
	} catch (err) {
		return {
			ok: false,
			reason: `no DNS record found yet (${err instanceof Error ? err.message : 'lookup failed'})`,
		}
	}
}

// Reads /opt/apps/<name>/docker-compose.yml on the server, regenerates the
// labels block to include:
//   - Host(...) || Host(...)  for autoassigned + every live custom domain
//   - Traefik redirect-regex middlewares for every entry in powder.json
//   - chained middlewares list on the router
// then `docker compose up -d --force-recreate <name>` to apply.
//
// Idempotent — running multiple times produces the same labels block.
//
export interface AppComposeFacts {
	workingDir: string
	service: string
	configFile: string
	/** Every compose file (-f) the app was started with; defaults to [configFile]. */
	composeFiles?: string[]
}

/** Where the app's compose lives and which SERVICE is the app: read from the
 *  running container's compose labels (many apps have service `app` with a
 *  different container_name). Falls back to /opt/apps/<name> + the container
 *  name only when the container does not exist. */
async function resolveAppComposeFacts(
	server: ServerConfig,
	containerName: string,
): Promise<AppComposeFacts> {
	try {
		const c = (await inspectContainer(server, containerName)).compose
		if (c.configFile && c.service && c.workingDir) {
			return {
				workingDir: c.workingDir,
				service: c.service,
				configFile: c.configFile,
				composeFiles: c.configFiles,
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (!/no such (object|container)/i.test(msg)) throw err
	}
	const workingDir = `/opt/apps/${containerName}`
	return { workingDir, service: containerName, configFile: `${workingDir}/docker-compose.yml` }
}

/** The container port traefik should route to: the user's resolved labels first (their
 *  current value), else the label powder wrote into its own override, else 3000. */
function containerPortFrom(config: unknown, service: string, ownLabels: string[] | null): number {
	const svc = (
		config as { services?: Record<string, { labels?: Record<string, string> | string[] }> }
	)?.services?.[service]
	const re = /^traefik\.http\.services\..*\.loadbalancer\.server\.port$/
	const labels = svc?.labels
	const entries: Array<[string, string]> = Array.isArray(labels)
		? labels.map((l) => [l.split('=')[0] ?? '', l.slice(l.indexOf('=') + 1)] as [string, string])
		: Object.entries(labels ?? {}).map(([k, v]) => [k, String(v)] as [string, string])
	for (const [k, v] of entries) if (re.test(k) && /^\d+$/.test(v)) return Number(v)
	for (const l of ownLabels ?? []) {
		const m = l.match(/^traefik\.http\.services\..*\.loadbalancer\.server\.port=(\d+)$/)
		if (m) return Number(m[1])
	}
	return 3000
}

/** The container port of a running app, read the way the domain labels read it
 *  (containerPortFrom: the user's compose label, else powder's override label,
 *  else 3000). For apps whose row has no container_port (no stored port).
 *  Any read failure answers 3000. */
export async function readAppContainerPort(server: ServerConfig, containerName: string): Promise<number> {
	try {
		const f = await resolveAppComposeFacts(server, containerName)
		const config = await readComposeConfig(server, composeFileArgs(f.configFile, f.composeFiles, { override: false }))
		const prev = await runCommand(server, `cat ${shq(overridePathFor(f.configFile, f.composeFiles))} 2>/dev/null`, 10_000)
		return containerPortFrom(config, f.service, parseOverrideLabels(prev.code === 0 ? prev.stdout : null, f.service))
	} catch (err) {
		console.warn(`[app-domains] ${containerName}: could not read the container port, using 3000:`, err instanceof Error ? err.message : err)
		return 3000
	}
}

/** Writes this app's labels (and the loopback port bindings) into powder's override
 *  file, never into the user's compose. fileOnly: no `up` (used before the build, the
 *  deploy script's own single `up` carries the result). Returns whether anything changed. */
async function writeAppOverride(
	server: ServerConfig,
	f: { workingDir: string; configFile: string; composeFiles?: string[]; service: string },
	opts: { appName: string; fileOnly?: boolean; labelsFor: (containerPort: number) => string[] },
): Promise<{ changed: boolean }> {
	const exists = await runCommand(
		server,
		`[ -f ${shq(f.configFile)} ] && echo ok || echo missing`,
		5_000,
	)
	if (exists.stdout.trim() !== 'ok') throw new Error(`compose file missing: ${f.configFile}`)
	const userArgs = composeFileArgs(f.configFile, f.composeFiles, { override: false })
	const config = await readComposeConfig(server, userArgs)
	if (config === null)
		throw new Error('compose config does not parse (docker compose config failed)')
	const prev = await runCommand(
		server,
		`cat ${shq(overridePathFor(f.configFile, f.composeFiles))} 2>/dev/null`,
		10_000,
	)
	const port = containerPortFrom(
		config,
		f.service,
		parseOverrideLabels(prev.code === 0 ? prev.stdout : null, f.service),
	)
	const { changed } = await applyComposeOverride(server, f, {
		labels: opts.labelsFor(port),
		appName: opts.appName,
		requireConfig: true,
	})
	if (changed && !opts.fileOnly) {
		// the deploy's compose guard on the compose on disk (override written).
		const { checkComposeForRecreate } = await import('./recreate-guard')
		const approval = await checkComposeForRecreate(server, {
			app: opts.appName,
			configFile: f.configFile,
			composeFiles: f.composeFiles,
			workingDir: f.workingDir,
			what: 'domain apply',
		})
		console.log(approval.log.trimEnd())
		const up = await runCommand(
			server,
			composeUpCommand(f.configFile, f.service, f.workingDir, {
				cf: composeFileArgs(f.configFile, f.composeFiles),
				app: opts.appName,
				approval,
			}),
			120_000,
		)
		// `up` output can carry interpolated values; callers store and return it.
		if (up.code !== 0)
			throw new Error(redactSecrets(up.stderr || up.stdout || `apply failed (exit ${up.code})`))
	}
	return { changed }
}

/** Hosts an app may route on Traefik (compose guard): the default host plus
 *  its live verified domains. previewDeployId set = that preview's live domains. */
export async function routeHostsFor(
	server: ServerConfig,
	appRepoId: string,
	containerName: string,
	previewDeployId: string | null = null,
): Promise<string[]> {
	const rows = await db.select().from(appDomains).where(eq(appDomains.appRepoId, appRepoId))
	const live = rows
		.filter((d) => d.status === 'live' && d.previewDeployId === previewDeployId)
		.map((d) => d.hostname)
	const defaultHost = defaultHostFor(server, containerName)
	return [...(defaultHost ? [defaultHost] : []), ...live]
}

/** fileOnly: write + validate + safety-check the override but do NOT `up`
 *  (used before the build so the deploy's own single `up` carries the final labels). */
export async function applyDomainsToCompose(
	repo: AppRepo,
	known?: AppComposeFacts,
	opts: { fileOnly?: boolean } = {},
): Promise<{ changed: boolean }> {
	const server = await getServer(repo.serverId)
	if (!server) throw new Error(`unknown server ${repo.serverId}`)
	if (!(await isTraefikServer(server))) {
		throw new Error(`custom domains not supported on ${repo.serverId} yet`)
	}
	const facts = known ?? (await resolveAppComposeFacts(server, repo.containerName))

	// Parent-app domains only — preview-attached domains are excluded
	// (they're applied to the preview's own workdir by applyPreviewDomainsToCompose).
	const liveDomains = await db.select().from(appDomains).where(eq(appDomains.appRepoId, repo.id))
	const live = liveDomains.filter(isRoutedDomain).map((d) => d.hostname)
	const cfg = await readPowderConfig(server, facts.workingDir)
	// No base domain on this server: no default host, only the live custom domains.
	const defaultHost = defaultHostFor(server, repo.containerName)
	const hosts = [...(defaultHost ? [defaultHost] : []), ...live]

	return writeAppOverride(server, facts, {
		appName: repo.containerName,
		fileOnly: opts.fileOnly,
		labelsFor: (containerPort) =>
			labelLinesFromBlock(
				renderLabelsBlock({
					containerName: repo.containerName,
					hosts,
					containerPort,
					redirects: cfg,
					serverId: repo.serverId,
					healthUrl: repo.healthUrl,
					tlsMode: server.tlsMode,
				}),
			),
	})
}

// Mirror of applyDomainsToCompose, scoped to a single preview deploy: the preview's
// own workdir + service name, only the app_domains rows where previewDeployId =
// preview.id. powder.json is NOT applied to previews (preview compose files are
// generated from the parent and carry no powder.json overrides yet).
export async function applyPreviewDomainsToCompose(
	preview: { id: string; appRepoId: string; containerName: string; workingDir: string },
	repoServerId: string,
): Promise<void> {
	const server = await getServer(repoServerId)
	if (!server) throw new Error(`unknown server ${repoServerId}`)
	if (!(await isTraefikServer(server))) {
		throw new Error(`previews not on ${repoServerId}`)
	}
	const liveDomains = await db
		.select()
		.from(appDomains)
		.where(eq(appDomains.appRepoId, preview.appRepoId))
	const live = liveDomains
		.filter((d) => d.status === 'live' && d.previewDeployId === preview.id)
		.map((d) => d.hostname)
	const [parent] = await db
		.select({ healthUrl: appRepos.healthUrl })
		.from(appRepos)
		.where(eq(appRepos.id, preview.appRepoId))
		.limit(1)
	const defaultHost = defaultHostFor(server, preview.containerName)
	const hosts = [...(defaultHost ? [defaultHost] : []), ...live]
	await writeAppOverride(
		server,
		{
			workingDir: preview.workingDir,
			configFile: `${preview.workingDir}/docker-compose.yml`,
			service: preview.containerName,
		},
		{
			appName: preview.containerName,
			labelsFor: (containerPort) =>
				labelLinesFromBlock(
					renderLabelsBlock({
						containerName: preview.containerName,
						hosts,
						containerPort,
						redirects: { redirects: [], rewrites: [], headers: {} },
						serverId: repoServerId,
						healthUrl: parent?.healthUrl ?? null,
						tlsMode: server.tlsMode,
					}),
				),
		},
	)
}

// one authority: the compose safety check (compose-guard) must hold on
// the REWRITTEN file before `up`. Returns a reason when the rewrite introduced
// a violation the original did not have (compose files that were already
// outside the guard, e.g. infra stacks with a docker.sock mount, keep working).
export function rewriteIntroducedUnsafe(
	rewritten: string,
	original: string,
	appName: string,
): string | null {
	const reason = checkComposeSafe(rewritten, appName)
	if (!reason) return null
	if (checkComposeSafe(original, appName)) return null
	return reason
}

// Builds the full Traefik labels block (4-space indented) including hosts,
// any redirect middlewares from powder.json, and the chained middlewares list.
// The block ENDS with a trailing newline so the next line (`    networks:`)
// stays at the right place.
export function renderLabelsBlock(opts: {
	containerName: string
	hosts: string[]
	containerPort: number
	redirects: import('./powder-config').PowderConfig
	serverId?: string
	tlsMode?: 'acme' | 'origin-cert'
	healthUrl?: string | null
}): string {
	const { containerName, hosts, containerPort, redirects, serverId, tlsMode } = opts
	// No hosts at all (no base domain, no live custom domain): an empty Host()
	// rule is invalid, so route nothing until a custom domain is attached.
	// Hostnames come from the DB (custom domains) and servers.base_domain; never
	// trust them inside a backtick-quoted rule. Underscores are tolerated (some
	// container names, hence default hosts, carry one; they cannot end the rule).
	const safeHosts = hosts.filter((h) => {
		if (isValidHostname(h.replace(/_/g, '-')) && !COMPOSE_FORBIDDEN_WORD_RE.test(h)) return true
		console.warn(
			`[app-domains] ${containerName}: skipping invalid hostname in Traefik rule: ${JSON.stringify(h).slice(0, 120)}`,
		)
		return false
	})
	if (safeHosts.length === 0) return ['    labels:', '      - traefik.enable=false', ''].join('\n')
	const ruleValue = safeHosts.map((h) => `Host(\`${h}\`)`).join(' || ')
	const { middlewareLabels, middlewareChain } = buildTraefikLabels(containerName, redirects)

	const lines: string[] = ['    labels:']
	lines.push(`      - traefik.enable=true`)
	lines.push(`      - traefik.http.routers.${containerName}.rule=${ruleValue}`)
	lines.push(`      - traefik.http.routers.${containerName}.entrypoints=websecure`)
	// acme: resolver le; origin-cert: tls=true (lib/traefik-tls.ts).
	lines.push(`      - ${traefikRouterTlsLabel(containerName, tlsMode)}`)
	// Explicit priority: Traefik defaults to rule length, which a tenant could
	// inflate to outrank another router. Hostnames are unique, so a constant is safe.
	lines.push(`      - traefik.http.routers.${containerName}.priority=${ROUTER_PRIORITY}`)
	lines.push(
		`      - traefik.http.services.${containerName}.loadbalancer.server.port=${containerPort}`,
	)

	// Healthcheck — Traefik probes the upstream every 10s; if it gets non-2xx/3xx,
	// stops routing to the container until it recovers. Smoother failover during
	// recreates: clients see 503 from Traefik instead of connection-refused while
	// the new container is starting.
	lines.push(
		`      - traefik.http.services.${containerName}.loadbalancer.healthcheck.path=${healthPathFor(opts.healthUrl)}`,
		`      - traefik.http.services.${containerName}.loadbalancer.healthcheck.interval=10s`,
		`      - traefik.http.services.${containerName}.loadbalancer.healthcheck.timeout=3s`,
	)

	// Diagnostic response headers — every response from this app gets stamped
	// with X-Powder-App/Server. NO per-deploy values here (Deploy-Id, Image-Tag): they made
	// the traefik labels differ on every deploy, which dropped the zero-downtime bridge
	// immediately (bridge_handoff compares the labels of old and new container).
	const diagHeaders: Record<string, string> = {
		'X-Powder-App': containerName,
	}
	if (serverId) diagHeaders['X-Powder-Server'] = serverId

	const diagMiddleware = `${containerName}-diag`
	for (const [k, v] of Object.entries(diagHeaders)) {
		lines.push(
			`      - traefik.http.middlewares.${diagMiddleware}.headers.customresponseheaders.${k}=${escapeForLabel(v)}`,
		)
	}

	// Retry on a connection that never reached the app (traefikRetryLabels): last, so
	// it wraps only the call to the service.
	// only with the drain on for this app (drain-mode.ts): off, the labels are unchanged.
	const retry = drainActiveFor(containerName) ? traefikRetryLabels(containerName) : null
	for (const l of retry?.labels ?? []) lines.push(`      - ${l}`)

	const allMiddlewares = [middlewareChain, diagMiddleware, retry?.middleware].filter(Boolean).join(',')
	lines.push(`      - traefik.http.routers.${containerName}.middlewares=${allMiddlewares}`)

	for (const l of middlewareLabels) {
		lines.push(`      - ${l}`)
	}
	return lines.join('\n') + '\n'
}

function escapeForLabel(s: string): string {
	// strip backticks/newlines (would break the YAML label line)
	return s.replace(/[`\r\n]/g, '')
}

/** explicit columns, error text masked (an older row may hold raw `up` output). */
export async function listDomainsForRepo(appRepoId: string): Promise<AppDomain[]> {
	const rows = await db
		.select({
			id: appDomains.id,
			appRepoId: appDomains.appRepoId,
			previewDeployId: appDomains.previewDeployId,
			hostname: appDomains.hostname,
			status: appDomains.status,
			statusError: appDomains.statusError,
			verifiedAt: appDomains.verifiedAt,
			verifyChallenge: appDomains.verifyChallenge,
			appliedAt: appDomains.appliedAt,
			appliedError: appDomains.appliedError,
			createdAt: appDomains.createdAt,
		})
		.from(appDomains)
		.where(eq(appDomains.appRepoId, appRepoId))
	return rows.map((r) => ({
		...r,
		statusError: redactNullable(r.statusError),
		appliedError: redactNullable(r.appliedError),
	}))
}

// ---------------------------------------------------------------------------
// TXT-challenge path.
//
// addDomain / verifyDomain / applyDomain are the three steps a user goes
// through to attach an arbitrary custom hostname via the per-project
// /domains tab. Separate from the older CNAME-DNS verify path used by the
// global /domains view, but writes to the same app_domains table.
//
// Status transitions:
//   pending → verified         (verifyDomain, TXT record matches)
//   pending → verify_failed    (verifyDomain, TXT missing/mismatch)
//   verified → live            (applyDomain, compose updated + recreated)
//   verified → apply_failed    (applyDomain, ssh/docker failed)
//   verify_failed → verified   (retry verify after fixing DNS)
//   apply_failed → live        (applyDomain again)
// ---------------------------------------------------------------------------

export function newChallenge(): string {
	// 32 lowercase hex chars (16 random bytes). Fits cleanly in a TXT record
	// and is unambiguous to copy-paste.
	return randomBytes(16).toString('hex')
}

export async function addDomain(opts: {
	repoId: string
	hostname: string
}): Promise<AppDomain> {
	const hostname = opts.hostname.trim().toLowerCase()
	if (!isValidHostname(hostname)) {
		throw new Error(`invalid hostname: ${hostname}`)
	}
	const word = composeWordProblem(hostname, 'hostname')
	if (word) throw new Error(word)

	const [repo] = await db.select().from(appRepos).where(eq(appRepos.id, opts.repoId)).limit(1)
	if (!repo) throw new Error(`no app_repos row for ${opts.repoId}`)

	const existing = await findDomainByHostname(hostname)
	if (existing) {
		if (existing.appRepoId === repo.id) {
			throw new Error(`domain already exists for this app: ${hostname}`)
		}
		// another app's row that never proved anything (pending or
		// verify_failed, never verified or applied: a discovered hostname or an unverified
		// claim) does not block this app; it is replaced. A verified or live row does.
		if (!isUnprovenClaim(existing)) throw new HostnameTakenError(hostname)
	}

	const id = createId(prefixes.appDomain)
	const challenge = newChallenge()
	try {
		await db.transaction(async (tx) => {
			if (existing) {
				const gone = await tx
					.delete(appDomains)
					.where(
						and(
							eq(appDomains.id, existing.id),
							inArray(appDomains.status, [...UNPROVEN_STATUSES]),
							isNull(appDomains.verifiedAt),
							isNull(appDomains.appliedAt),
						),
					)
					.returning({ id: appDomains.id })
				// It changed since we read it (verified meanwhile): it is taken now.
				if (gone.length === 0) throw new HostnameTakenError(hostname)
				console.warn(
					`[domains] ${hostname}: replaced an unverified ${existing.status} row of another app (${existing.appRepoId}) for ${repo.containerName}`,
				)
			}
			await tx.insert(appDomains).values({
				id,
				appRepoId: repo.id,
				hostname,
				status: 'pending',
				verifyChallenge: challenge,
			})
		})
	} catch (err) {
		if (err instanceof HostnameTakenError) throw err
		if (isUniqueViolation(err)) throw new HostnameTakenError(hostname)
		throw err
	}
	const [row] = await db.select().from(appDomains).where(eq(appDomains.id, id))
	return row
}

// Resolves TXT records at `_powder-verify.<hostname>` (VERIFY_TXT_PREFIX; a record at
// `_powder.<hostname>` is accepted too) and looks for the
// row's challenge as one of the answers. Flips status to 'verified' on match,
// 'verify_failed' otherwise. Returns the verification outcome; does NOT
// apply compose labels (that's applyDomain).
export async function verifyDomain(
	repoId: string,
	hostname: string,
): Promise<{ verified: boolean; error?: string }> {
	const host = hostname.trim().toLowerCase()
	if (!isValidHostname(host)) return { verified: false, error: 'invalid hostname' }
	const [row] = await db
		.select()
		.from(appDomains)
		.where(and(eq(appDomains.appRepoId, repoId), eq(appDomains.hostname, host)))
		.limit(1)
	if (!row) return { verified: false, error: 'domain not found' }
	if (!row.verifyChallenge) {
		return { verified: false, error: 'no challenge set; re-add the domain' }
	}

	// Check `_powder-verify.` first, then `_powder.` (also accepted); a stray TXT at one
	// name must not hide a correct one at the other.
	const txtName = `${VERIFY_TXT_PREFIX}${host}`
	const txtNames = [txtName, `_powder.${host}`]
	const answers: string[][] = []
	let lookupError: unknown = null
	let answered = false
	for (const name of txtNames) {
		try {
			const got = await resolveTxt(name)
			answered = true
			answers.push(...got)
			if (got.some((parts) => parts.join('').trim() === row.verifyChallenge)) break
		} catch (err) {
			lookupError = err
		}
	}
	if (!answered) {
		const reason = lookupError instanceof Error ? lookupError.message : 'lookup failed'
		await db
			.update(appDomains)
			.set({
				status: 'verify_failed',
				statusError: redactSecrets(`no TXT at ${txtName}: ${reason}`),
			})
			.where(eq(appDomains.id, row.id))
		return { verified: false, error: `no TXT at ${txtName} (${reason})` }
	}

	// Each "answer" from resolveTxt is an array of fragments — TXT records can
	// be split into multiple strings, joined when read. Match against the join.
	const found = answers.some((parts) => parts.join('').trim() === row.verifyChallenge)
	if (!found) {
		const observed = answers.map((p) => p.join('')).join(', ') || '(empty)'
		const msg = `TXT at ${txtName} did not include challenge (saw: ${observed})`
		await db
			.update(appDomains)
			.set({ status: 'verify_failed', statusError: redactSecrets(msg) })
			.where(eq(appDomains.id, row.id))
		return { verified: false, error: msg }
	}

	await db
		.update(appDomains)
		.set({ status: 'verified', statusError: null, verifiedAt: new Date() })
		.where(eq(appDomains.id, row.id))
	return { verified: true }
}

/** The statuses applyDomain accepts: a proven domain, or one whose last apply failed. */
export function canApplyDomain(status: string): boolean {
	return status === 'verified' || status === 'apply_failed'
}

// Puts a verified hostname live on a Traefik server. Refuses unless the row
// is 'verified' or 'apply_failed' (a retry). Marks the row 'live' first (the label render only
// includes live hostnames), then calls applyDomainsToCompose, which
// re-renders the app's labels block and recreates the container when the
// labels changed. On success it stamps appliedAt and clears the errors; on
// failure the row becomes 'apply_failed' with the error.
export async function applyDomain(
	repoId: string,
	hostname: string,
): Promise<{ applied: boolean; error?: string }> {
	const host = hostname.trim().toLowerCase()
	if (!isValidHostname(host)) return { applied: false, error: 'invalid hostname' }
	const [row] = await db
		.select()
		.from(appDomains)
		.where(and(eq(appDomains.appRepoId, repoId), eq(appDomains.hostname, host)))
		.limit(1)
	if (!row) return { applied: false, error: 'domain not found' }
	// A failed apply is retried from 'apply_failed': the DNS proof still stands.
	if (!canApplyDomain(row.status)) {
		return {
			applied: false,
			error: `domain status is '${row.status}', must be 'verified' before applying`,
		}
	}

	const [repo] = await db.select().from(appRepos).where(eq(appRepos.id, repoId)).limit(1)
	if (!repo) return { applied: false, error: `no app_repos row for ${repoId}` }
	const server = await getServer(repo.serverId)
	if (!server) return { applied: false, error: `unknown server ${repo.serverId}` }
	if (!(await isTraefikServer(server))) {
		return {
			applied: false,
			error: `custom domains not supported on ${repo.serverId} yet`,
		}
	}

	try {
		// The label render only includes hostnames that are 'live', so mark this one live
		// first; the override write + `up` (only when the labels changed) applies it.
		await db.update(appDomains).set({ status: 'live' }).where(eq(appDomains.id, row.id))
		await applyDomainsToCompose(repo)
		await db
			.update(appDomains)
			.set({
				status: 'live',
				statusError: null,
				appliedError: null,
				appliedAt: new Date(),
			})
			.where(eq(appDomains.id, row.id))
		return { applied: true }
	} catch (err) {
		const msg = redactSecrets(err instanceof Error ? err.message : 'apply failed')
		await db
			.update(appDomains)
			.set({ status: 'apply_failed', appliedError: redactSecrets(msg) })
			.where(eq(appDomains.id, row.id))
		return { applied: false, error: msg }
	}
}
