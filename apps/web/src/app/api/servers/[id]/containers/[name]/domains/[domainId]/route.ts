import { requireContainerAccess } from '@/lib/access'
import {
	applyDomainsToCompose,
	applyPreviewDomainsToCompose,
	newVerifyToken,
	verifyDns,
	verifyTxtChallenge,
} from '@/lib/app-domains'
import { appDomains, appRepos, db, eq, previewDeploys } from '@/lib/db'
import { redactNullable, redactSecrets } from '@/lib/secret-text'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Trigger DNS verification + (on success) apply to compose + recreate.
export async function POST(
	_req: Request,
	ctx: { params: Promise<{ id: string; name: string; domainId: string }> },
) {
	const { id, name, domainId } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access

	const [domain] = await db.select().from(appDomains).where(eq(appDomains.id, domainId))
	if (!domain) return Response.json({ error: 'unknown domain' }, { status: 404 })
	const [repo] = await db.select().from(appRepos).where(eq(appRepos.id, domain.appRepoId))
	if (!repo || repo.serverId !== id || repo.containerName !== name) {
		return Response.json({ error: 'forbidden' }, { status: 403 })
	}

	const dns = await verifyDns(domain.hostname, repo.serverId)
	if (!dns.ok) {
		await db
			.update(appDomains)
			.set({ status: 'pending', statusError: redactSecrets(dns.reason ?? 'dns not ready') })
			.where(eq(appDomains.id, domainId))
		return Response.json({ ok: false, error: redactNullable(dns.reason), resolvedTo: dns.resolvedTo })
	}

	// DNS pointing at us is not ownership. Require the per-row TXT token.
	// Rows already live (grandfathered) are not re-challenged or downgraded.
	let token = domain.verifyChallenge
	if (domain.status !== 'live') {
		if (!token) {
			token = newVerifyToken()
			await db.update(appDomains).set({ verifyChallenge: token }).where(eq(appDomains.id, domainId))
		}
		const txt = await verifyTxtChallenge(domain.hostname, token)
		if (!txt.ok) {
			await db
				.update(appDomains)
				.set({ status: 'pending', statusError: redactSecrets(txt.reason ?? 'ownership not verified') })
				.where(eq(appDomains.id, domainId))
			return Response.json({
				ok: false,
				error: redactNullable(txt.reason),
				txtRecord: { name: `_powder-verify.${domain.hostname}`, value: token },
			})
		}
	}

	// Mark live first so applyDomainsToCompose includes this hostname.
	await db
		.update(appDomains)
		.set({ status: 'live', statusError: null, verifiedAt: new Date() })
		.where(eq(appDomains.id, domainId))

	try {
		if (domain.previewDeployId) {
			const [preview] = await db
				.select()
				.from(previewDeploys)
				.where(eq(previewDeploys.id, domain.previewDeployId))
			if (!preview) throw new Error('preview no longer exists')
			await applyPreviewDomainsToCompose(
				{
					id: preview.id,
					appRepoId: preview.appRepoId,
					containerName: preview.containerName,
					workingDir: preview.workingDir,
				},
				repo.serverId,
			)
		} else {
			await applyDomainsToCompose(repo)
		}
		return Response.json({ ok: true, status: 'live' })
	} catch (err) {
		// masked before it is stored and returned (raw `up` output)
		const msg = redactSecrets(clientErrorMessage(err, 'compose apply failed', 'servers/:id/containers/:name/domains/:domainId'))
		await db
			.update(appDomains)
			.set({ status: 'failed', statusError: redactSecrets(msg) })
			.where(eq(appDomains.id, domainId))
		return Response.json({ ok: false, error: msg }, { status: 502 })
	}
}

export async function DELETE(
	_req: Request,
	ctx: { params: Promise<{ id: string; name: string; domainId: string }> },
) {
	const { id, name, domainId } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access

	const [domain] = await db.select().from(appDomains).where(eq(appDomains.id, domainId))
	if (!domain) return Response.json({ ok: true, alreadyMissing: true })
	const [repo] = await db.select().from(appRepos).where(eq(appRepos.id, domain.appRepoId))
	if (!repo || repo.serverId !== id || repo.containerName !== name) {
		return Response.json({ error: 'forbidden' }, { status: 403 })
	}

	await db.delete(appDomains).where(eq(appDomains.id, domainId))
	// Re-apply the right compose so the deleted host disappears from the labels.
	if (domain.status === 'live') {
		try {
			if (domain.previewDeployId) {
				const [preview] = await db
					.select()
					.from(previewDeploys)
					.where(eq(previewDeploys.id, domain.previewDeployId))
				if (preview) {
					await applyPreviewDomainsToCompose(
						{
							id: preview.id,
							appRepoId: preview.appRepoId,
							containerName: preview.containerName,
							workingDir: preview.workingDir,
						},
						repo.serverId,
					)
				}
			} else {
				await applyDomainsToCompose(repo)
			}
		} catch (err) {
			console.error('[app-domains] post-delete apply failed:', err)
		}
	}
	return Response.json({ ok: true })
}
