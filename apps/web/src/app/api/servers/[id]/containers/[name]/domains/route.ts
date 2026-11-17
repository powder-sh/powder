import { requireContainerAccess } from '@/lib/access'
import {
	findDomainByHostname,
	ingressTargetFor,
	isUniqueViolation,
	isValidHostname,
	listDomainsForRepo,
	newVerifyToken,
	VERIFY_TXT_PREFIX,
} from '@/lib/app-domains'
import { NO_BASE_DOMAIN_MESSAGE, composeWordProblem, defaultHostFor } from '@/lib/app-hosts'
import { getServer } from '@/lib/servers'
import { isTraefikServer } from '@/lib/traefik-servers'
import { and, appDomains, appRepos, createId, db, eq, prefixes, previewDeploys } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access

	const [repo] = await db
		.select()
		.from(appRepos)
		.where(and(eq(appRepos.serverId, id), eq(appRepos.containerName, name)))
	if (!repo) return Response.json({ supported: false, reason: 'no app_repos row' })

	const supported = await isTraefikServer(id)
	const domains = supported ? await listDomainsForRepo(repo.id) : []
	const server = await getServer(id)
	const target = server ? await ingressTargetFor(server) : null
	const autoAssigned = server ? defaultHostFor(server, name) : null

	return Response.json({
		supported,
		autoAssigned,
		baseDomain: server?.baseDomain ?? null,
		...(autoAssigned ? {} : { note: NO_BASE_DOMAIN_MESSAGE }),
		ingressIp: target?.ip ?? null,
		domains,
	})
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	if (!(await isTraefikServer(id))) {
		return Response.json(
			{ error: 'custom domains here need a Traefik server (on an nginx server, use the nginx domain manager at /domains)' },
			{ status: 400 },
		)
	}

	const body = (await req.json()) as { hostname?: string; previewId?: string }
	const hostname = (body.hostname ?? '').trim().toLowerCase()
	if (!isValidHostname(hostname)) {
		return Response.json({ error: 'invalid hostname' }, { status: 400 })
	}
	const word = composeWordProblem(hostname, 'hostname')
	if (word) return Response.json({ error: word }, { status: 400 })

	const [repo] = await db
		.select()
		.from(appRepos)
		.where(and(eq(appRepos.serverId, id), eq(appRepos.containerName, name)))
	if (!repo) return Response.json({ error: 'no app_repos row' }, { status: 400 })

	// Hostnames are unique across ALL apps, whatever their status.
	const existing = await findDomainByHostname(hostname)
	if (existing) {
		return Response.json(
			{
				error:
					existing.appRepoId === repo.id ? 'already added' : 'hostname already in use by another app',
			},
			{ status: 409 },
		)
	}

	// previewId must be a preview of THIS app.
	let previewDeployId: string | null = null
	if (body.previewId) {
		const [preview] = await db
			.select()
			.from(previewDeploys)
			.where(eq(previewDeploys.id, body.previewId))
		if (!preview || preview.appRepoId !== repo.id) {
			return Response.json({ error: 'unknown previewId for this app' }, { status: 400 })
		}
		previewDeployId = preview.id
	}

	const insertedId = createId(prefixes.appDomain)
	try {
		await db.insert(appDomains).values({
			id: insertedId,
			appRepoId: repo.id,
			hostname,
			previewDeployId,
			status: 'pending',
			verifyChallenge: newVerifyToken(),
		})
	} catch (err) {
		if (isUniqueViolation(err)) {
			return Response.json({ error: 'hostname already in use by another app' }, { status: 409 })
		}
		throw err
	}
	const [row] = await db.select().from(appDomains).where(eq(appDomains.id, insertedId))
	return Response.json({
		domain: row,
		txtRecord: { name: `${VERIFY_TXT_PREFIX}${hostname}`, value: row?.verifyChallenge ?? null },
	})
}
