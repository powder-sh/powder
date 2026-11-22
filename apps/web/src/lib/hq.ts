// Powder → HQ (external ops hub) deploy-event emitter.
//
// When POWDER_HQ_* is set, powder reports deploy, cron and backup events to an
// optional external ops endpoint. Powder only EMITS events; that endpoint owns
// alert routing (who gets told, and where). Wire format: Authorization: Bearer
// <token>, JSON body, fail-silent, short timeout - telemetry must never block or
// break a deploy.
//
// The payloads (fields and fixed values) are documented in docs/SELF-HOSTING.md,
// "Ops endpoint reporting"; keep them in step.
//
// Fully opt-in: nothing is emitted (and nothing is logged) unless BOTH the
// token and the matching URL are set in the environment:
//   POWDER_HQ_INGEST_TOKEN  bearer token
//   POWDER_HQ_INGEST_URL    deploy events endpoint
//   POWDER_HQ_GENERIC_URL   warning cards endpoint
//   POWDER_HQ_CRON_URL      cron results endpoint
import { type BridgeVerdict, DRAIN_VERDICTS, type DrainVerdict, type NginxUpstreamVerdict } from './deploy/fragments'
import { MIGRATE_PATH_CASES, type MigratePathCase } from './deploy/stability'
import {
	COMPOSE_DRIFT_INVENTORY_REF,
	type ComposeDriftStep,
	type ComposeDriftStore,
	composeDriftStep,
	powderMetaComposeDriftStore,
	standingRefs,
} from './deploy/compose-drift-inventory'
import { sanitizeNotifyText } from './notify-text'
import { type SafeText, redactSecrets } from './secret-text'
import { PUBLIC_REPO_URL } from './site'

const HQ_PROJECT = process.env.POWDER_HQ_PROJECT ?? 'powder'

/** True when HQ reporting is configured: the token AND at least one endpoint URL. */
export function hqConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return (
		!!env.POWDER_HQ_INGEST_TOKEN?.trim() &&
		!!(env.POWDER_HQ_INGEST_URL?.trim() || env.POWDER_HQ_GENERIC_URL?.trim() || env.POWDER_HQ_CRON_URL?.trim())
	)
}

/** True when deploy results (failures included) are sent to the ops endpoint:
 *  POWDER_HQ_INGEST_TOKEN and POWDER_HQ_INGEST_URL, the pair reportDeployToHq
 *  posts with. POWDER_HQ_GENERIC_URL (warning cards) and POWDER_HQ_CRON_URL
 *  (cron results) never carry a failed deploy. Presence only. */
export function hqDeployEventsOn(env: Record<string, string | undefined> = process.env): boolean {
	return !!env.POWDER_HQ_INGEST_TOKEN?.trim() && !!env.POWDER_HQ_INGEST_URL?.trim()
}

export type DeployEvent = {
	app: string
	server: string
	status: 'success' | 'failure'
	sha?: string | null
	/** what `sha` is (lib/deploy-commit.ts): 'built' = the commit the deploy built (on a
	 *  success, the one now live), 'requested' = only the commit the push asked for is known. */
	shaSource?: 'built' | 'requested' | null
	branch?: string | null
	durationMs?: number | null
	/** Leaves powder: must be masked (lib/secret-text.ts). A failure with a known step
	 *  reads `failed during: <step> · <summary>` (deploy-failure.ts opsEventErrorText). */
	error?: SafeText | null
	/** failure only: the step it stopped at, normalised like the step in `error`
	 *  (notify-text.ts safeFailedStep: lower case, [a-z0-9 _:-]); null when unknown */
	failedStep?: string | null
	/** failure only: the step's exit code from the deploy script; null when unknown */
	exitCode?: number | null
	// deploys.id: stable per deploy row and the same id /api/internal/deploys
	// lists, so a receiver can match this fire-and-forget event to the row and
	// find rows whose event never arrived.
	deployId?: string | null
	// deploys.kind: a rollback must read as a rollback in the HQ feed.
	deployKind?: string | null
}

export async function reportDeployToHq(event: DeployEvent): Promise<void> {
	// Telemetry must never break or delay a deploy: a dropped emit is logged so a
	// dead path shows in `docker logs`. Delivery is best effort; a receiver that
	// needs every deploy can list them from /api/internal/deploys (by deployId).
	await postHq(
		'POWDER_HQ_INGEST_URL',
		{ project: HQ_PROJECT, env: 'production', kind: 'deploy', ...event, error: event.error == null ? event.error : sanitizeNotifyText(event.error).slice(0, 500) },
		'deploy event',
		`(${event.app} ${event.status})`,
	)
}

// Degraded-success warnings. A deploy can go green while quietly doing the
// wrong thing: the env render was REFUSED (DB env changes do not reach the server),
// or the dedicated builder failed and it built LOCALLY on the app server. In
// deploys.output alone nobody would see them. One deduped warn
// card per app+kind; the next clean deploy resolves it.
export type DeployWarnings = {
	app: string
	server: string
	envRefusedKeys: string[] | null
	builderFallback: string | null // the builder's failure line, or null
	/** `left public:` lines from the port normaliser (published ports it could not or would not bind to loopback). */
	portsLeftPublic?: string[] | null
	/** The bridge step's verdict (deploy/fragments.ts parseBridgeVerdict): bridged /
	 *  not-routed resolve the no-bridge card, the rest raise it, null posts nothing. */
	bridge?: BridgeVerdict | null
	/** host nginx checks (deploy/fragments.ts parseNginxUpstreamVerdict): `server` drives the
	 *  per-server nginx-upstream card ([] resolves), `app` the per-app bridge-upstream card
	 *  (ok / n/a resolve, no-upstream raises); null parts post nothing. */
	nginxUpstream?: NginxUpstreamVerdict | null
	/** servers.proxy of the app's server (null / absent = unknown). On an
	 *  nginx-container server a not-routed app gets the DNS-alias bridge hint
	 *  (stability card), and a bridge skip card names the DNS-alias mode. */
	serverProxy?: 'nginx' | 'nginx-container' | 'traefik' | null
	/** deploy-setup checks (deploy/stability.ts markers), each null = unknown, posts nothing.
	 *  The repo's docker-compose.yml differs from the runtime compose: `drift` (this deploy's
	 *  commits changed it) raises, `ok` (both match) resolves, `standing` (differs, unchanged
	 *  since the last deploy) neither: it feeds the compose-drift inventory (deploy/compose-drift-inventory.ts). */
	composeDrift?: 'drift' | 'standing' | 'ok' | null
	/** schema changes that bypass powder-migrate ([] resolves, cases raise). */
	migratePath?: MigratePathCase[] | null
	/** app_repos.health_url: `unset` (the gate answered HTTP with no health URL) raises,
	 *  `set` and `n/a` (no HTTP to judge, e.g. a worker) resolve. */
	healthUrl?: 'set' | 'unset' | 'n/a' | null
	/** .powder/test.sh in the build context (informational): `absent` raises, `present` resolves. */
	testGate?: 'present' | 'absent' | null
	/** how the old container stopped in a bridged swap (fragments.ts drainShellFunctions):
	 *  `ok` resolves, the other verdicts raise. */
	stopDrain?: DrainVerdict | null
}

/** POWDER_STABILITY_CARDS: the deploy-setup warning cards (stabilityCardPlan) are
 *  posted only when it is `on` (or 1 / true). Unset or `off` (the default): the
 *  markers are still read and each card that would be raised is logged as
 *  `[stability] would warn: <key> <reason>`, but nothing is posted. */
export function stabilityCardsOn(env: Record<string, string | undefined> = process.env): boolean {
	return /^(on|1|true)$/i.test(env.POWDER_STABILITY_CARDS?.trim() ?? '')
}

/** One deploy-setup warning card: `raise` set = warn card, null = resolve. */
export type StabilityCard = { key: string; raise: { reason: string; title: string; body: string } | null }

// Fixed card text per stop-drain verdict (fragments.ts DRAIN_VERDICTS) except `ok`.
const STOP_DRAIN_REASON: Record<Exclude<DrainVerdict, 'ok'>, string> = {
	'no-route-away':
		'powder could not refuse new connections to the old container before stopping it (the bridge did not answer, iptables or nsenter is missing on the server, or the reject rule did not take effect), so a request that reached it while it stopped could fail',
	'sigterm-ignored':
		"the old container ignored SIGTERM and was killed after its grace period (it was idle, so no request was lost). Its PID 1 does not pass SIGTERM to the server: a shell-form CMD, `sh -c \"... && node server.js\"` without exec, or a package manager that does not forward signals. Use an exec-form CMD (CMD [\"node\", \"server.js\"]) or `exec` the server in the start script",
	killed:
		'the old container was killed after its grace period with connections still open, so requests in flight were cut. Causes: PID 1 does not pass SIGTERM to the server (use an exec-form CMD such as CMD ["node", "server.js"]); on a Traefik server, Traefik reuses keep-alive connections to the old container (start Traefik with --serverstransport.maxidleconnsperhost=-1); or a request runs longer than the grace (set stop_grace_period in the compose service)',
}

// Fixed card text per bridge verdict an app traefik does not route can get.
const NGINX_BRIDGE_REASON: Record<'nginx-unbridged' | 'host-network', string> = {
	'nginx-unbridged':
		'host nginx proxies to the container\'s published 127.0.0.1 port, but the app has no powder.bridge.enabled=true label: enable the bridge (labels powder.bridge.enabled=true and powder.bridge.host-port=<app host port + 10000>) and add the bridge as a backup upstream in the vhost (server 127.0.0.1:<that port> backup; with max_fails=0 on the primary and proxy_next_upstream error timeout;)',
	'host-network':
		'runs with network_mode: host, which the bridge cannot clone: move the app off host networking first (a bridge network with a 127.0.0.1:<port> published port that nginx proxies to), then enable the bridge',
}

// An app traefik does not route on a server whose proxy is an nginx container: the
// bridge's DNS-alias mode covers it when the proxy resolves the app by docker DNS
// name per request. The script cannot tell an HTTP app from a worker there, so the
// text says when it applies.
const DNS_ALIAS_HINT =
	'runs on a server whose proxy is an nginx container and is not bridged: if the proxy reaches this app by its docker DNS name (nginx resolver 127.0.0.11 plus a variable proxy_pass), add LABEL powder.bridge.enabled=true and LABEL powder.bridge.dns-alias=true to the Dockerfile (and LABEL powder.bridge.port=<port> unless the image EXPOSEs exactly one port). A worker with no HTTP traffic can ignore this'

/** True when a not-routed verdict should carry the DNS-alias hint instead of resolving. */
function dnsAliasHint(w: DeployWarnings): boolean {
	return w.bridge === 'not-routed' && w.serverProxy === 'nginx-container'
}

/** The deploy-setup warning cards of one deploy (pure: no I/O). Fixed text per
 *  verdict, nothing from the deploy log. An unknown input (null) gives no entry. */
export function stabilityCardPlan(w: DeployWarnings): StabilityCard[] {
	const ref = (kind: string) => `${kind}:${w.server}/${w.app}`
	const cards: StabilityCard[] = []
	if (w.bridge === 'nginx-unbridged' || w.bridge === 'host-network') {
		const reason = NGINX_BRIDGE_REASON[w.bridge]
		cards.push({
			key: ref('no-bridge'),
			raise: {
				reason,
				title: `${w.app}: no zero-downtime swap - 502s on every deploy`,
				body: `The app is not routed by traefik and ${reason}. Without the bridge, compose --force-recreate stops the container and nginx answers 502 until the new one boots. Clears on the first deploy that bridges.`,
			},
		})
	} else if (dnsAliasHint(w)) {
		cards.push({
			key: ref('no-bridge'),
			raise: {
				reason: DNS_ALIAS_HINT,
				title: `${w.app}: no zero-downtime swap - 502s on every deploy`,
				body: `The app ${DNS_ALIAS_HINT}. Without the bridge, compose --force-recreate stops the container and the proxy answers 502 until the new one boots. Clears on the first deploy that bridges.`,
			},
		})
	}
	// `standing` gets no per-app entry: it never raises or resolves the card (see
	// reportComposeDriftFollowUp for the compose-drift inventory and the one-time retirement).
	if (w.composeDrift === 'drift' || w.composeDrift === 'ok') {
		const reason =
			"the repo's docker-compose.yml differs from the runtime compose on the server: committed compose changes do not deploy"
		cards.push({
			key: ref('compose-drift'),
			raise:
				w.composeDrift === 'drift'
					? {
							reason,
							title: `${w.app}: committed compose changes are not deployed`,
							body: `On ${w.server}, ${reason}; powder runs the server's compose file (/opt/apps/<app>/docker-compose.yml) and never copies the repo's. Raised only by a deploy whose commits (since the last successful deploy) changed the repo's docker-compose.yml. Apply the change to the server file too, or drop docker-compose.yml from the repo if it is unused. Clears on the first deploy where both files match; a later deploy that leaves the compose alone does not clear it.`,
						}
					: null,
		})
	}
	if (Array.isArray(w.migratePath)) {
		const cases = MIGRATE_PATH_CASES.filter((c) => w.migratePath?.includes(c))
		const reason = cases.map((c) => MIGRATE_PATH_REASON[c]).join('; ')
		cards.push({
			key: ref('migrate-path'),
			raise: cases.length
				? {
						reason,
						title: `${w.app}: schema changes bypass powder-migrate (${cases.join(', ')})`,
						body: `On ${w.server}: ${reason}. powder-migrate applies the *.sql files of src/drizzle, drizzle, migrations, src/migrations, supabase/migrations or db/migrations before the swap, records each one, and a failing file stops the deploy while the old container keeps serving. Move the schema changes there; an app whose migrations are code (knex, prisma migrate) runs its own migrator from the powder.release.cmd label instead, once before the swap. Never push a schema in the deploy path. Clears on the next deploy without it.`,
					}
				: null,
		})
	}
	if (w.healthUrl === 'set' || w.healthUrl === 'unset' || w.healthUrl === 'n/a') {
		const reason = 'the health gate only proves the app answers HTTP'
		cards.push({
			key: ref('health-url'),
			raise:
				w.healthUrl === 'unset'
					? {
							reason,
							title: `${w.app}: ${reason}`,
							body: `${w.app} on ${w.server} has no health URL, so the deploy health gate passes on any 1xx-4xx answer from /. That only proves the app answers HTTP, not that it works. Set a health URL on the app's Settings tab, on a cheap route that answers 2xx only when the app can serve (e.g. /api/health); the gate then requires a 2xx from it. Clears on the next deploy with one set.`,
						}
					: null,
		})
	}
	if (w.stopDrain && (DRAIN_VERDICTS as readonly string[]).includes(w.stopDrain)) {
		const reason = w.stopDrain === 'ok' ? '' : STOP_DRAIN_REASON[w.stopDrain]
		cards.push({
			key: ref('stop-drain'),
			raise:
				w.stopDrain === 'ok'
					? null
					: {
							reason,
							title:
								w.stopDrain === 'sigterm-ignored'
									? `${w.app}: ignores SIGTERM - every deploy waits the full stop grace`
									: `${w.app}: requests can be lost on deploy`,
							body: `On ${w.server}, in the last deploy's swap ${reason}. Clears on the first deploy whose old container stops cleanly.`,
						},
		})
	}
	if (w.testGate === 'present' || w.testGate === 'absent') {
		const reason = 'no .powder/test.sh: nothing tests or typechecks a commit before it replaces the running app'
		cards.push({
			key: ref('test-gate'),
			raise:
				w.testGate === 'absent'
					? {
							reason,
							title: `${w.app}: no test gate`,
							body: `${w.app} on ${w.server} has ${reason}. Commit a .powder/test.sh in the build context (it runs in a throwaway container after the build; a non-zero exit stops the deploy and the old container keeps serving). Clears on the next deploy that has one.`,
						}
					: null,
		})
	}
	return cards
}

/** The health-url card input for a deploy that passed its health gate: no repo
 *  row (a preview) is unknown; a health_url set (non-blank, as resolveHealthProbe
 *  reads it) resolves; none raises only when the gate judged HTTP (`true`), not
 *  when it fell back to liveness (`skipped`, a non-HTTP workload). */
export function healthUrlState(
	repo: { healthUrl?: string | null } | null | undefined,
	gate: boolean | 'skipped',
): DeployWarnings['healthUrl'] {
	if (!repo) return null
	if (repo.healthUrl?.trim()) return 'set'
	return gate === true ? 'unset' : 'n/a'
}

// Fixed text per migrate-path case (deploy/stability.ts MIGRATE_PATH_CASES).
const MIGRATE_PATH_REASON: Record<MigratePathCase, string> = {
	'stray-sql': 'the repo has migration-looking *.sql files, but none in a folder powder-migrate reads, so the deploy applies none of them',
	'boot-cmd': 'the image command or entrypoint runs a schema tool (drizzle-kit, prisma, a migrate script) at container start, outside powder-migrate',
	'release-cmd': 'the powder.release.cmd label runs a schema push (drizzle-kit push, prisma db push): it diffs the live schema with no ledger and can drop columns or data',
	'start-script': 'package.json start runs a schema tool at container start, outside powder-migrate',
}

// Fixed card text per verdict class: nothing from the deploy log reaches HQ.
const BRIDGE_CARD_REASON: Record<Exclude<BridgeVerdict, 'bridged' | 'not-routed' | 'nginx-unbridged' | 'host-network'>, string> = {
	'no-label': 'has no powder.bridge.enabled=true label',
	'no-healthcheck': 'has no healthcheck',
	'host-ports': 'publishes a host port on a public interface (0.0.0.0, a LAN ip or no ip) the bridge cannot share: drop the ports line of this service in the server compose (/opt/apps/<app>/docker-compose.yml), traefik reaches it over the docker network; loopback-only bindings (127.0.0.1:...) are fine',
	unsupported: 'has a setting the bridge cannot clone (extra_hosts, mounts, overridden command, no explicit traefik router/service or rule, ...; the deploy log says which)',
	failed: 'could not be bridged: the bridge failed to start or answer (the deploy log says which step)',
	internal: 'tripped a powder self-check that real docker output should never trip',
}

// The builder's failure line from deploy output, or null. Lines marked
// "not builder-eligible" (secrets/additional_contexts, non src/ layout) are an
// expected skip, not a failure, so they never raise the fallback warn card.
// BUILDER_FALLBACK_PREFIX is the exact text deploy/run.ts prints.
export const BUILDER_FALLBACK_PREFIX = '[builder] phase failed - '
export function extractBuilderFallback(output: string): string | null {
	const line = output.match(/\[builder\] phase failed - [^\n]*/)?.[0] ?? null
	return line && !line.includes('not builder-eligible') ? line : null
}

/** The port normaliser's `left public: ...` notes, deduped, capped and made safe
 *  for a notification (they carry compose service names). The notes come from
 *  rebuildDeploy's result, never from a search of the deploy output, where build or test
 *  output could print a `left public:` line of its own. */
export function portsLeftPublicLines(notes: readonly string[] | null | undefined): string[] {
	const lines = (notes ?? []).filter((l) => l.startsWith('left public: '))
	return [...new Set(lines.map((l) => sanitizeNotifyText(l.trim()).slice(0, 200)))].slice(0, 20)
}

// One POST to an HQ ingest endpoint: bearer token, JSON body, 3 s timeout,
// fail-silent. No-op unless POWDER_HQ_INGEST_TOKEN and the named URL env are
// both set. `what`/`detail` only shape the log line on a drop.
async function postHq(urlEnv: string, body: Record<string, unknown>, what: string, detail = ''): Promise<void> {
	const token = process.env.POWDER_HQ_INGEST_TOKEN
	const url = process.env[urlEnv]
	if (!token || !url) return // HQ reporting not configured
	const tag = detail ? ` ${detail}` : ''
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(3000),
		})
		if (!res.ok) console.error(`[hq] ${what} rejected: HTTP ${res.status}${tag}`)
	} catch (err) {
		console.error(`[hq] ${what} emit failed${tag}:`, err instanceof Error ? err.message : err)
	}
}

function postGeneric(body: Record<string, unknown>): Promise<void> {
	return postHq('POWDER_HQ_GENERIC_URL', body, 'warning event')
}

/** The compose-drift state step of one deploy (cards switch on), run BEFORE any
 *  compose-drift card is posted: a raise is only safe once its `drift` row is
 *  written, or the app's next standing deploy would take the card for an old-rule
 *  one and retire it. null = no marker; 'failed' = the store failed (logged): the
 *  caller then raises and resolves nothing for compose-drift. */
async function composeDriftState(w: DeployWarnings, store: ComposeDriftStore): Promise<ComposeDriftStep | 'failed' | null> {
	const v = w.composeDrift
	if (v !== 'drift' && v !== 'standing' && v !== 'ok') return null
	try {
		return await composeDriftStep(`${w.server}/${w.app}`, v, store)
	} catch (err) {
		console.error(
			`[stability] compose-drift state write failed for ${w.server}/${w.app}, no compose-drift card raised or resolved this deploy:`,
			err instanceof Error ? err.message : err,
		)
		return 'failed'
	}
}

// Inventory posts run one after another, and each reads the list when it is sent:
// deploys on different servers finish in parallel, and a post built from an older
// read must not land after a newer one. Deploys run in one process (the worker, or
// web with POWDER_DEPLOY_WORKER off), so an in-process chain orders every post.
let inventoryChain: Promise<void> = Promise.resolve()

/** Post the inventory of standing compose drift: one HQ task (no channel, so no
 *  Discord line), its text replaced by every post, resolved when the list is empty.
 *  `reopen` only when an app joined the standing set with this deploy: a closed
 *  inventory then opens again, while posts without a new app leave it closed.
 *  Never rejects. */
export function postComposeDriftInventory(source: string, store: ComposeDriftStore, reopen: boolean): Promise<void> {
	const run = inventoryChain.then(async () => {
		try {
			const refs = standingRefs(await store.list())
			await (refs.length > 0
				? postGeneric({
						source,
						source_ref: COMPOSE_DRIFT_INVENTORY_REF,
						severity: 'info',
						title: `Repo docker-compose.yml differs from the server compose on ${refs.length} app${refs.length === 1 ? '' : 's'}`,
						body: `Standing state, not news: powder runs each server's /opt/apps/<app>/docker-compose.yml and never copies the repo's. For each app below, apply the repo compose to the server file or drop docker-compose.yml from the repo. A new committed compose change still raises its own compose-drift card.\n${refs.map((r) => `- ${sanitizeNotifyText(r).slice(0, 120)}`).join('\n')}`.slice(0, 3800),
						refresh_text: true,
						reopen,
					})
				: postGeneric({ source, source_ref: COMPOSE_DRIFT_INVENTORY_REF, resolve: true, title: 'compose drift inventory empty', body: 'no app has a standing repo compose difference' }))
		} catch (err) {
			console.error('[stability] compose-drift inventory skipped:', err instanceof Error ? err.message : err)
		}
	})
	inventoryChain = run
	return run
}

/** Post (POWDER_STABILITY_CARDS on) or log (off) the deploy-setup warning cards.
 *  Never throws: a bad input or a bug here must not reach the deploy. */
async function reportStabilityCards(w: DeployWarnings, source: string, store: ComposeDriftStore): Promise<void> {
	try {
		const plan = stabilityCardPlan(w)
		if (!stabilityCardsOn()) {
			for (const c of plan) if (c.raise) console.log(`[stability] would warn: ${c.key} ${c.raise.reason}`)
			return
		}
		const driftKey = `compose-drift:${w.server}/${w.app}`
		const drift = await composeDriftState(w, store)
		const posts = plan
			.filter((c) => !(drift === 'failed' && c.key === driftKey))
			.map((c) =>
				c.raise
					? postGeneric({ project: w.app, source, source_ref: c.key, severity: 'warn', channel: 'general', title: c.raise.title, body: c.raise.body })
					: postGeneric({ source, source_ref: c.key, resolve: true, title: `${c.key.split(':')[0]} ok`, body: 'cleared by a deploy without the condition' }),
			)
		if (drift && drift !== 'failed' && drift.retireOld)
			posts.push(
				postGeneric({
					source,
					source_ref: driftKey,
					resolve: true,
					title: 'compose-drift ok',
					body: 'standing drift: no commit since the last deploy changed docker-compose.yml (listed in the compose-drift inventory instead)',
				}),
			)
		await Promise.all(posts)
		if (drift && drift !== 'failed') await postComposeDriftInventory(source, store, drift.joined)
	} catch (err) {
		console.error('[stability] warning cards skipped:', err instanceof Error ? err.message : err)
	}
}

/** `driftStore`: test seam for the compose-drift state (default powder_meta). */
export async function reportDeployWarningsToHq(w: DeployWarnings, driftStore: ComposeDriftStore = powderMetaComposeDriftStore): Promise<void> {
	const ref = (kind: string) => `${kind}:${w.server}/${w.app}`
	const source = 'powder-deploy-warn'
	// the bridge verdicts of apps traefik does not route (nginx-unbridged,
	// host-network) raise their no-bridge card through reportStabilityCards; with
	// the switch off they resolve it, as not-routed does.
	const stabilityBridge = w.bridge === 'nginx-unbridged' || w.bridge === 'host-network' || dnsAliasHint(w)
	await Promise.all([
		reportStabilityCards(w, source, driftStore),
		w.envRefusedKeys?.length
			? postGeneric({
					project: w.app,
					source,
					source_ref: ref('env-refused'),
					severity: 'warn',
					channel: 'general',
					title: `${w.app}: env render refused, powder env changes are NOT reaching the server`,
					body: `The env file on ${w.server} has key(s) powder's DB doesn't know (${w.envRefusedKeys.join(', ')}), so every deploy keeps the old file. Someone edited it by hand. Backfill those keys into powder (project env page), then redeploy.`,
				})
			: postGeneric({ source, source_ref: ref('env-refused'), resolve: true, title: 'env render ok', body: 'env render clean again' }),
		w.builderFallback
			? postGeneric({
					project: w.app,
					source,
					source_ref: ref('builder-fallback'),
					severity: 'warn',
					channel: 'general',
					title: `${w.app}: built on the app server, the dedicated builder failed`,
					body: `${sanitizeNotifyText(redactSecrets(w.builderFallback)).slice(0, 300)}\nThe deploy succeeded, but it built on ${w.server} itself (CPU/RAM spike on the app server). A "Permission denied (publickey)" here means the app's deploy key isn't on the GitHub repo.`,
				})
			: postGeneric({ source, source_ref: ref('builder-fallback'), resolve: true, title: 'builder ok', body: 'dedicated builder working again' }),
		w.portsLeftPublic?.length
			? postGeneric({
					project: w.app,
					source,
					source_ref: ref('ports-left-public'),
					severity: 'warn',
					channel: 'general',
					title: `${w.app}: published ports left on all interfaces`,
					body: `${sanitizeNotifyText(w.portsLeftPublic.join('\n')).slice(0, 600)}\nThese compose ports were NOT bound to 127.0.0.1 (proxy service, unsupported syntax, or the ${'powder.public-port'}=true opt-out). Confirm they are meant to be public.`,
				})
			: postGeneric({ source, source_ref: ref('ports-left-public'), resolve: true, title: 'ports ok', body: 'no published ports left public' }),
		w.bridge === 'bridged' || (w.bridge === 'not-routed' && !dnsAliasHint(w)) || (stabilityBridge && !stabilityCardsOn())
			? postGeneric({ source, source_ref: ref('no-bridge'), resolve: true, title: 'bridge ok', body: 'deploy swap bridged or not traefik-routed' })
			: w.bridge && w.bridge !== 'nginx-unbridged' && w.bridge !== 'host-network' && w.bridge !== 'not-routed'
				? postGeneric({
						project: w.app,
						source,
						source_ref: ref('no-bridge'),
						severity: 'warn',
						channel: 'general',
						title:
							w.bridge === 'internal'
								? `${w.app}: powder bug - bridge refused by a powder self-check, 502s on every deploy`
								: `${w.app}: no zero-downtime swap - 502s on every deploy`,
						body:
							w.bridge === 'internal'
								? `The running container is routed by traefik but ${BRIDGE_CARD_REASON.internal}, so compose --force-recreate stops it and traefik answers 502 until the new one boots. This is a powder bug, not an app setting: nothing in the app needs to change. Report it at ${PUBLIC_REPO_URL}/issues with the [bridge] lines of the deploy log (they say which check refused). It most likely hits every bridged app. Clears on the first deploy that bridges.`
								: w.serverProxy === 'nginx-container'
									? `On this nginx-container server the app ${BRIDGE_CARD_REASON[w.bridge]}, so compose --force-recreate stops it and the proxy answers 502 until the new one boots. The [bridge] lines of the deploy log say which check refused; the bridge's DNS-alias mode needs LABEL powder.bridge.enabled=true and LABEL powder.bridge.dns-alias=true. Clears on the first deploy that bridges.`
									: `The running container is routed by traefik but ${BRIDGE_CARD_REASON[w.bridge]}, so compose --force-recreate stops it and traefik answers 502 until the new one boots. For a missing label or healthcheck: add a HEALTHCHECK (cheap, DB-free route) and LABEL powder.bridge.enabled=true to the Dockerfile; powder keeps the server compose, so a repo compose edit never deploys. Clears on the first deploy that bridges (the second deploy after the fix).`,
					})
				: Promise.resolve(),
		w.nginxUpstream?.server
			? w.nginxUpstream.server.length
				? postGeneric({
						project: 'powder',
						source,
						source_ref: `nginx-upstream:${w.server}`,
						severity: 'warn',
						channel: 'general',
						title: `${w.server}: nginx upstream with one primary lacking max_fails=0 - one slow request 502s the site`,
						body: `Host nginx on ${w.server} has upstream(s) ${w.nginxUpstream.server.join(', ')} with a backup server and a single primary without max_fails=0. With the default max_fails=1 fail_timeout=10s one slow response (proxy_read_timeout) marks the only primary down, and while the backup is not up (a powder bridge only runs during a deploy swap; a dead backup line never does) nginx answers 502/503 "no live upstreams" to every request on that worker for 10s. Add max_fails=0 to the primary server line (or drop a backup line nothing listens on), nginx -t, reload. Clears on the next deploy on ${w.server} that finds none.`,
					})
				: postGeneric({ source, source_ref: `nginx-upstream:${w.server}`, resolve: true, title: 'nginx upstreams ok', body: 'no upstream with a single primary lacking max_fails=0 next to a backup' })
			: Promise.resolve(),
		w.nginxUpstream?.app === 'no-upstream'
			? postGeneric({
					project: w.app,
					source,
					source_ref: ref('bridge-upstream'),
					severity: 'warn',
					channel: 'general',
					title: `${w.app}: bridge has no nginx upstream - 502s on every deploy`,
					body: `The app runs in powder bridge host-port mode on ${w.server}, but no host nginx upstream lists \`server 127.0.0.1:<bridge port> backup;\`, so the bridge gets no traffic and the deploy swap still 502s. Add the upstream from the bridge docs (primary with max_fails=0, bridge as backup, proxy_next_upstream error timeout;). Clears on the next deploy that finds it, or once the app leaves host-port mode.`,
				})
			: w.nginxUpstream?.app
				? postGeneric({ source, source_ref: ref('bridge-upstream'), resolve: true, title: 'bridge upstream ok', body: 'bridge port is a backup upstream, or the app is not in host-port mode' })
				: Promise.resolve(),
	])
}

// One deduped warn card per build host (servers.build_host) whose disk is at
// real risk after the cap prune that follows every builder phase
// (builder-prune.ts builderDiskRisk: root disk at 75%, or 3 prunes in a row
// that each left the cache over the cap and larger than the one before), or
// whose cache prune has been skipped for a day (builds never paused). The
// cache over its soft cap alone is no risk. Resolves itself once a prune ran
// and found no risk.
export async function reportBuildHostDiskToHq(host: string, overCap: string | null, afterPrune = true): Promise<void> {
	const source = 'powder-build-host-disk'
	const source_ref = `build-host-disk:${host}`
	if (!overCap) {
		await postGeneric({ source, source_ref, resolve: true, title: 'build host disk ok', body: 'build host disk healthy and its cache prune working' })
		return
	}
	await postGeneric({
		project: 'powder',
		source,
		source_ref,
		severity: 'warn',
		channel: 'general',
		title: afterPrune ? `build host ${host} disk at risk` : `build host ${host} disk not kept under its cap`,
		body: `${afterPrune ? 'After the cap prune' : 'The cap prune was skipped this time'}: ${overCap}. Check \`docker buildx du\` and \`df -h /\` on it (through powder's key); the soft cache cap is POWDER_BUILDER_CACHE_CAP_GB.`,
	})
}

// One deduped warn card per server while a swap-check candidate (`*-next`) is older
// than the watchdog threshold; resolves itself when the server is clean again.
export async function reportSwapCheckLeftoverToHq(serverId: string, serverName: string, leftovers: string[]): Promise<void> {
	const source = 'powder-swap-check'
	const source_ref = `swap-check-leftover:${serverId}`
	if (leftovers.length === 0) {
		await postGeneric({ source, source_ref, resolve: true, title: 'swap-check ok', body: 'no leftover candidate containers' })
		return
	}
	await postGeneric({
		project: 'powder',
		source,
		source_ref,
		severity: 'warn',
		channel: 'general',
		title: `swap-check leftover on ${serverName}: ${leftovers.join(', ')}`,
		body: `A swap-check candidate container (label powder.candidate=1) has been running over 30 minutes on ${serverName}: ${leftovers.join(', ')}. A deploy was killed mid-probe. It also holds memory. Remove it: docker rm -f <name>.`,
	})
}

// Cron-result emitter — same pattern as reportDeployToHq. Powder calls this for
// crons it runs itself (e.g. backups). Host crons report via a server-local
// wrapper script. No-op until POWDER_HQ_INGEST_TOKEN is set, so it's safe
// to ship before the receiver's cron endpoint exists.
export type CronEvent = {
	job: string
	server: string
	status: 'success' | 'failure'
	exitCode?: number | null
	durationMs?: number | null
	/** Leaves powder: must be masked (lib/secret-text.ts). */
	error?: SafeText | null
	/** false = success closes an open failure only; the receiver upserts no heartbeat. */
	heartbeat?: boolean
}

export async function reportCronToHq(event: CronEvent): Promise<void> {
	// Telemetry must never break a cron run - a dropped emit is logged like the deploy emitter.
	await postHq(
		'POWDER_HQ_CRON_URL',
		{ project: HQ_PROJECT, env: 'production', kind: 'cron', ...event },
		'cron event',
		`(${event.job} ${event.status})`,
	)
}
