import { type CurrentUser, requireUser } from '@/lib/access'
import { isPersistedAdminId } from '@/lib/admin-ids'
import { isRoutedDomain } from '@/lib/app-hosts'
import { appDomains, appRepos, db, notificationTargets } from '@/lib/db'
import { deployFailureRoutes } from '@/lib/deploy-failure-routes'
import { lastCheckResult, runBootstrapCheck } from '@/lib/server-bootstrap-run'
import { cachedDnsCheck, runDnsCheck } from '@/lib/server-dns-check'
import { listAllServers, updateServerStatus } from '@/lib/servers'
import { BACKUP_ENV_KEYS, buildChecklist, checklistComplete, envSet } from '@/lib/setup-checklist'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Servers where something would use a default `<app>.<base_domain>` host: an
// app with no custom domain, an app with previews on, or no apps yet.
async function defaultHostNeed(): Promise<(serverId: string) => boolean> {
	const [repos, domains] = await Promise.all([
		db
			.select({
				id: appRepos.id,
				serverId: appRepos.serverId,
				previewsEnabled: appRepos.previewsEnabled,
			})
			.from(appRepos),
		db
			.select({
				appRepoId: appDomains.appRepoId,
				status: appDomains.status,
				previewDeployId: appDomains.previewDeployId,
			})
			.from(appDomains),
	])
	// Only domains the app is actually routed on (pending/failed/preview rows are not).
	const hasDomain = new Set(domains.filter(isRoutedDomain).map((d) => d.appRepoId))
	const withApps = new Set<string>()
	const needs = new Set<string>()
	for (const r of repos) {
		withApps.add(r.serverId)
		if (r.previewsEnabled || !hasDomain.has(r.id)) needs.add(r.serverId)
	}
	return (id) => needs.has(id) || !withApps.has(id)
}

// Where failed deploys go (lib/deploy-failure-routes.ts): env presence and the
// saved targets. Only route names leave this function, never a URL or token.
async function failedDeployRoutes() {
	const targets = await db.select().from(notificationTargets)
	return deployFailureRoutes(process.env, targets)
}

async function checklist(user: CurrentUser): Promise<Response> {
	const [all, needsDefaultHost, routes] = await Promise.all([
		listAllServers(),
		defaultHostNeed(),
		failedDeployRoutes(),
	])
	const items = buildChecklist({
		githubOAuth: envSet(process.env, ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']),
		backups: envSet(process.env, BACKUP_ENV_KEYS),
		deployFailureRoutes: routes,
		adminPersisted: isPersistedAdminId(user.id),
		servers: all.map((s) => {
			const check = lastCheckResult(s)
			return {
				id: s.id,
				name: s.name,
				status: s.status,
				proxy: s.proxy ?? 'nginx',
				baseDomain: s.baseDomain ?? null,
				checkGreen: check?.green ?? null,
				checkMissing: check?.missing ?? [],
				dnsState: cachedDnsCheck(s.id, s.baseDomain ?? null)?.state ?? null,
				needsDefaultHost: needsDefaultHost(s.id),
			}
		}),
	})
	return Response.json({ items, complete: checklistComplete(items) })
}

// Cheap: env, server rows and cached results only. No SSH, no DNS.
export async function GET() {
	const u = await requireUser()
	if (u instanceof Response) return u
	if (!u.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 })
	return checklist(u)
}

// POST ?action=run: the operator asked, so check every server over SSH and
// its base-domain DNS, then answer with the fresh checklist.
export async function POST(req: Request) {
	const u = await requireUser()
	if (u instanceof Response) return u
	if (!u.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 })
	if (new URL(req.url).searchParams.get('action') !== 'run') {
		return Response.json({ error: 'unknown action' }, { status: 400 })
	}
	const all = await listAllServers()
	await Promise.all(
		all.map(async (s) => {
			try {
				await runBootstrapCheck(s)
				await updateServerStatus(s.id, 'connected')
			} catch (err) {
				await updateServerStatus(
					s.id,
					'unreachable',
					clientErrorMessage(err, 'ssh failed', 'setup/checklist'),
				)
			}
			if (s.proxy === 'traefik') await runDnsCheck(s).catch(() => null)
		}),
	)
	return checklist(u)
}
