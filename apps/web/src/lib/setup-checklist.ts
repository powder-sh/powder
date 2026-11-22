// First-run checklist: pure builder over facts the route gathers cheaply (env,
// servers rows, cached SSH/DNS results). No SSH or DNS here; the route only
// runs those when the operator asks (POST ?action=run).

import { type DeployFailureRoute, describeDeployFailureRoutes } from './deploy-failure-route-words'
import { RECREATE_COMMAND } from './recreate-hint'

type ChecklistState = 'done' | 'missing' | 'unknown'

export interface ChecklistItem {
	id: string
	label: string
	state: ChecklistState
	detail: string
	href: string
	/** Needed before the first deploy. The rest make powder nicer to run. */
	required: boolean
	/** Verb for the item's one action ("add a server", "check now"). */
	action: string
	/** The action re-runs the SSH and DNS checks instead of following href. */
	runsCheck?: boolean
}

export interface ChecklistServer {
	id: string
	name: string
	status: 'pending' | 'connected' | 'unreachable'
	proxy: 'nginx' | 'nginx-container' | 'traefik'
	baseDomain: string | null
	// null = never checked (or only under another proxy). Persisted across restarts.
	checkGreen: boolean | null
	/** The required pieces the last check found missing (server-bootstrap.ts
	 *  checkItems 'missing' items); [] or absent when green or unknown. */
	checkMissing?: Array<{ id: string; label: string; detail: string }>
	dnsState: string | null
	/** Something on this server would use a default `<app>.<base_domain>` host:
	 *  an app with no custom domain, an app with branch previews on, or no apps
	 *  yet. False = every app has its own domain, so a base domain is optional. */
	needsDefaultHost?: boolean
}

export interface ChecklistInput {
	githubOAuth: boolean
	servers: ChecklistServer[]
	backups: boolean
	/** deployFailureRoutes(): where failed deploys go; [] = nowhere but the dashboard. */
	deployFailureRoutes: DeployFailureRoute[]
	adminPersisted: boolean
}

// Env presence only (values never leave the server).
export function envSet(env: Record<string, string | undefined>, keys: string[]): boolean {
	return keys.every((k) => !!env[k]?.trim())
}

export const BACKUP_ENV_KEYS = [
	'BACKUP_S3_ENDPOINT',
	'BACKUP_S3_BUCKET',
	'BACKUP_S3_ACCESS_KEY_ID',
	'BACKUP_S3_SECRET_ACCESS_KEY',
	'POWDER_BACKUP_KEY',
]

function serverHref(s: ChecklistServer | undefined): string {
	return s ? `/servers/${s.id}` : '/servers'
}

function names(list: ChecklistServer[]): string {
	return list.map((s) => s.name).join(', ')
}

// The server check items that mean Docker or the proxy itself is missing.
const DOCKER_OR_PROXY = new Set(['docker', 'compose', 'traefik'])

// Checklist words for a check item id; anything else keeps the check's label.
const PIECE_NAMES: Record<string, string> = {
	docker: 'Docker',
	compose: 'the docker compose plugin',
	traefik: 'the Traefik container',
	'traefik-file-provider': 'the Traefik file provider',
	'dynamic-dir': 'the Traefik file provider folder',
	'network-web': 'network web',
	tools: 'git or flock',
}

function pieceName(m: { id: string; label: string }): string {
	return PIECE_NAMES[m.id] ?? m.label
}

function someNames(list: string[], max = 3): string {
	return list.length <= max
		? list.join(', ')
		: `${list.slice(0, max).join(', ')} and ${list.length - max} more`
}

function fixFirst(failing: ChecklistServer[]): ChecklistServer | undefined {
	return failing.find((s) => s.checkMissing?.length) ?? failing[0]
}

/** "network web missing on a, b, c and 3 more; ... first: network web on a: <why>".
 *  The first named piece is the one the row's action opens (fixFirst). */
function failingDetail(failing: ChecklistServer[]): string {
	const byPiece = new Map<string, string[]>()
	for (const s of failing) {
		for (const m of s.checkMissing ?? []) {
			const k = pieceName(m)
			byPiece.set(k, [...(byPiece.get(k) ?? []), s.name])
		}
	}
	const unnamed = failing.filter((s) => !s.checkMissing?.length)
	const parts = [...byPiece].map(([piece, on]) => `${piece} missing on ${someNames(on)}`)
	if (unnamed.length)
		parts.push(`the server check failed on ${someNames(unnamed.map((s) => s.name))}`)
	const summary = parts.join('; ')
	const firstServer = fixFirst(failing)
	const first = firstServer?.checkMissing?.[0]
	if (!firstServer || !first) return summary
	const why = first.detail.replace(/^missing: /, '')
	const total = failing.reduce((n, s) => n + (s.checkMissing?.length ?? 0), 0) + unnamed.length
	if (total === 1) return `${summary}: ${why}`
	return `${summary}. first: ${pieceName(first)} on ${firstServer.name}: ${why}`
}

export function buildChecklist(input: ChecklistInput): ChecklistItem[] {
	const items: ChecklistItem[] = []
	const { servers } = input
	const first = servers[0]

	// One row for the server: added, reachable over SSH and passing the server
	// check. Its state is the worst of the three, with that problem's next action.
	const unreachable = servers.filter((s) => s.status === 'unreachable')
	const failing = servers.filter((s) => s.checkGreen === false)
	const unchecked = servers.filter((s) => s.status === 'pending' || s.checkGreen === null)
	const serverRow: Pick<
		ChecklistItem,
		'label' | 'state' | 'detail' | 'href' | 'action' | 'runsCheck'
	> =
		servers.length === 0
			? {
					label: 'add a server',
					state: 'missing',
					detail: 'any Linux server you can SSH into as root',
					href: '/servers',
					action: 'add a server',
				}
			: unreachable[0]
				? {
						label: 'reach every server over SSH',
						state: 'missing',
						detail: `can't reach ${names(unreachable)} over SSH`,
						href: serverHref(unreachable[0]),
						action: `open ${unreachable[0].name}`,
					}
				: failing[0]
					? {
							label: failing.some((s) => s.checkMissing?.some((m) => DOCKER_OR_PROXY.has(m.id)))
								? 'install Docker and the proxy'
								: 'add the missing server pieces',
							state: 'missing',
							detail: failingDetail(failing),
							// the server page's check card: "check server", then "fix missing pieces"
							href: `${serverHref(fixFirst(failing))}#server-check`,
							action: `fix ${fixFirst(failing)?.name ?? failing[0].name}`,
						}
					: unchecked.length > 0
						? {
								label: 'check your servers',
								state: 'unknown',
								detail: `not checked yet: ${names(unchecked)}`,
								href: serverHref(unchecked[0]),
								action: 'check now',
								runsCheck: true,
							}
						: {
								label: 'add a server',
								state: 'done',
								detail: `${servers.length} server${servers.length === 1 ? '' : 's'} reachable, with Docker and the proxy in place`,
								href: '/servers',
								action: 'open servers',
							}
	items.push({ id: 'server', required: true, ...serverRow })

	items.push({
		id: 'github-oauth',
		label: 'connect GitHub',
		state: input.githubOAuth ? 'done' : 'missing',
		detail: input.githubOAuth
			? 'GitHub OAuth app configured'
			: `set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in powder.env, then recreate the containers (${RECREATE_COMMAND}; a restart does not re-read the file), or paste a personal access token on the integrations page`,
		href: '/docs/quickstart',
		required: true,
		action: 'open the quickstart',
	})

	// Default hosts only exist on Traefik servers.
	const traefik = servers.filter((s) => s.proxy === 'traefik')
	// A missing base domain only counts where something would use a default host.
	const noBase = traefik.filter((s) => !s.baseDomain && s.needsDefaultHost !== false)
	const notNeeded = traefik.filter((s) => !s.baseDomain && s.needsDefaultHost === false)
	const withBase = traefik.filter((s) => s.baseDomain)
	const badDns = traefik.filter((s) => s.baseDomain && s.dnsState && s.dnsState !== 'ok')
	const dnsUnknown = traefik.filter((s) => s.baseDomain && !s.dnsState)
	items.push({
		id: 'base-domain',
		label: 'base domain and wildcard DNS',
		state:
			traefik.length === 0 || noBase.length > 0 || badDns.length > 0
				? 'missing'
				: dnsUnknown.length > 0
					? 'unknown'
					: 'done',
		detail:
			traefik.length === 0
				? 'gives every app a default hostname; needs a server that routes with Traefik'
				: noBase.length > 0
					? `no base domain on ${names(noBase)}`
					: badDns.length > 0
						? `wildcard DNS does not point at ${names(badDns)}`
						: dnsUnknown.length > 0
							? `DNS not checked yet: ${names(dnsUnknown)}`
							: withBase.length === 0
								? `not needed: every app on ${names(notNeeded)} has its own domain`
								: notNeeded.length > 0
									? `wildcard DNS points at ${names(withBase)}; not needed on ${names(notNeeded)} (every app has its own domain)`
									: 'wildcard DNS points at every Traefik server',
		href: serverHref(noBase[0] ?? badDns[0] ?? dnsUnknown[0] ?? traefik[0] ?? first),
		required: false,
		action:
			dnsUnknown.length > 0 && noBase.length === 0 && badDns.length === 0 ? 'check now' : 'set up',
		runsCheck:
			traefik.length > 0 && noBase.length === 0 && badDns.length === 0 && dnsUnknown.length > 0,
	})

	items.push({
		id: 'backups',
		label: 'set up backups',
		state: input.backups ? 'done' : 'missing',
		detail: input.backups
			? 'BACKUP_S3_* and POWDER_BACKUP_KEY are set'
			: `nightly encrypted Postgres dumps to S3-compatible storage: set ${BACKUP_ENV_KEYS.join(', ')} in powder.env`,
		href: '/docs/backups#configure-the-target',
		required: false,
		action: 'how',
	})

	items.push({
		id: 'notify-webhook',
		label: 'get told when a deploy fails',
		state: input.deployFailureRoutes.length > 0 ? 'done' : 'missing',
		detail:
			input.deployFailureRoutes.length > 0
				? describeDeployFailureRoutes(input.deployFailureRoutes)
				: 'add a Slack, Discord or email target for failed deploys',
		href: '/settings/notifications',
		required: false,
		action: 'add a target',
	})

	items.push({
		id: 'admin-persisted',
		label: 'pin your admin id in powder.env',
		state: input.adminPersisted ? 'done' : 'missing',
		detail: input.adminPersisted
			? 'your id is in POWDER_ADMIN_USER_IDS'
			: 'keeps you admin after a database reset or restore and keeps first-run sign-up closed. on the server, in the powder checkout, run sudo bin/install.sh --set-admin <your user id> (the id is in the "[first-run]" line of the powder log)',
		href: '/docs/self-hosting#first-login',
		required: false,
		action: 'how',
	})

	return items
}

export function checklistComplete(items: ChecklistItem[]): boolean {
	return items.every((i) => i.state === 'done')
}

export interface ChecklistSummary {
	requiredDone: number
	requiredTotal: number
	optionalLeft: number
	/** Every required item is done: powder can deploy. */
	ready: boolean
	/** The first open required item, else the first open optional one. */
	next: ChecklistItem | null
}

export function summarizeChecklist(items: ChecklistItem[]): ChecklistSummary {
	const req = items.filter((i) => i.required)
	const opt = items.filter((i) => !i.required)
	const requiredDone = req.filter((i) => i.state === 'done').length
	return {
		requiredDone,
		requiredTotal: req.length,
		optionalLeft: opt.filter((i) => i.state !== 'done').length,
		ready: requiredDone === req.length,
		next: req.find((i) => i.state !== 'done') ?? opt.find((i) => i.state !== 'done') ?? null,
	}
}
