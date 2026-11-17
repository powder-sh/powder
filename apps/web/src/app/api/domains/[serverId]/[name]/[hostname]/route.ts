import { requireContainerAccess } from '@/lib/access'
import { isValidHostname } from '@/lib/app-domains'
import { SIBLING_TAKEN, hostnameOwnedByApp, siblingHostAllowedForApp } from '@/lib/domain-ownership'
import { and, createId, db, domainRedirects, eq, prefixes } from '@/lib/db'
import { redactNullable, redactSecrets } from '@/lib/secret-text'
import {
	type CustomRedirect,
	applyToNginxContainer,
	applyToNginxHost,
	applyToTraefik,
	detectProxyKind,
	wwwRedirectHost,
} from '@/lib/domain-redirects'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PatchBody {
	wwwMode?: 'none' | 'apex' | 'www'
	custom?: CustomRedirect[]
	apply?: boolean
}

export async function PATCH(
	req: Request,
	ctx: { params: Promise<{ serverId: string; name: string; hostname: string }> },
) {
	const { serverId, name, hostname } = await ctx.params
	// lowercase + trim: GET keys the saved row by the URL host (lowercase), so a
	// mixed-case hostname saved as typed would never show up there.
	const decodedHostname = decodeURIComponent(hostname).trim().toLowerCase()
	// The hostname is interpolated raw into the generated nginx `server_name`
	// (see renderNginxConfig), so it MUST pass the same validation addDomain
	// enforces — otherwise a crafted hostname injects arbitrary nginx directives.
	if (!isValidHostname(decodedHostname)) {
		return Response.json({ error: 'invalid hostname' }, { status: 400 })
	}
	const access = await requireContainerAccess(serverId, name)
	if (access instanceof Response) return access
	const { user, server } = access

	// the hostname must be one of this app's own verified/live domains.
	if (!(await hostnameOwnedByApp(serverId, name, decodedHostname))) {
		return Response.json({ error: 'hostname does not belong to this app' }, { status: 403 })
	}

	const body = (await req.json()) as PatchBody
	const wwwMode = body.wwwMode ?? 'none'
	if (!['none', 'apex', 'www'].includes(wwwMode)) {
		return Response.json({ error: 'invalid wwwMode' }, { status: 400 })
	}
	const custom = (body.custom ?? []).filter(
		(r) => typeof r.from === 'string' && typeof r.to === 'string' && r.from.startsWith('/'),
	)
	// status is interpolated into nginx config, so only 301/302 (or unset).
	if (custom.some((r) => r.status !== undefined && r.status !== 301 && r.status !== 302)) {
		return Response.json({ error: 'invalid redirect status (301 or 302)' }, { status: 400 })
	}
	const customJson = JSON.stringify(custom)
	// the redirect also answers on the www/apex sibling; refuse before saving when
	// that host belongs to another app.
	const sibling = wwwRedirectHost({ hostname: decodedHostname, wwwMode })
	if (sibling && sibling !== decodedHostname.toLowerCase() && !(await siblingHostAllowedForApp(serverId, name, sibling))) {
		return Response.json({ error: `hostname ${sibling} ${SIBLING_TAKEN}` }, { status: 403 })
	}

	// Upsert by (serverId, containerName, hostname)
	const existing = await db
		.select()
		.from(domainRedirects)
		.where(
			and(
				eq(domainRedirects.serverId, serverId),
				eq(domainRedirects.containerName, name),
				eq(domainRedirects.hostname, decodedHostname),
			),
		)
		.then((rows) => rows[0] ?? null)

	if (existing) {
		await db
			.update(domainRedirects)
			.set({ wwwMode, customRedirectsJson: customJson })
			.where(eq(domainRedirects.id, existing.id))
	} else {
		await db.insert(domainRedirects).values({
			id: createId(prefixes.domainRedirect),
			ownerUserId: user.id,
			serverId,
			containerName: name,
			hostname: decodedHostname,
			wwwMode,
			customRedirectsJson: customJson,
		})
	}

	if (body.apply !== true) {
		return Response.json({ ok: true, applied: false })
	}

	const proxyKind = detectProxyKind(server)
	let appliedError: string | null = null
	try {
		if (proxyKind === 'nginx-host') {
			await applyToNginxHost(
				server,
				{ hostname: decodedHostname, wwwMode, custom },
				{ serverId, containerName: name },
			)
		} else if (proxyKind === 'nginx-container') {
			await applyToNginxContainer(
				server,
				{ hostname: decodedHostname, wwwMode, custom },
				{ serverId, containerName: name },
			)
		} else if (proxyKind === 'traefik') {
			// One fragment per app: this hostname plus every other hostname of the
			// app that was already applied.
			const rows = await db
				.select()
				.from(domainRedirects)
				.where(
					and(eq(domainRedirects.serverId, serverId), eq(domainRedirects.containerName, name)),
				)
			// Stale rows of domains this app no longer owns are skipped.
			const candidates = rows.filter((r) => r.hostname === decodedHostname || r.appliedAt !== null)
			const owned: typeof rows = []
			for (const r of candidates) {
				if (!(await hostnameOwnedByApp(serverId, name, r.hostname))) continue
				// an older row whose www/apex sibling now belongs to another app is skipped too.
				const sib = r.hostname === decodedHostname ? null : wwwRedirectHost({ hostname: r.hostname, wwwMode: r.wwwMode as 'none' | 'apex' | 'www' })
				if (sib && sib !== r.hostname.toLowerCase() && !(await siblingHostAllowedForApp(serverId, name, sib))) continue
				owned.push(r)
			}
			const inputs = owned
				.map((r) =>
					r.hostname === decodedHostname
						? { hostname: decodedHostname, wwwMode, custom }
						: {
								hostname: r.hostname,
								wwwMode: r.wwwMode as 'none' | 'apex' | 'www',
								custom: parseCustom(r.customRedirectsJson),
							},
				)
			await applyToTraefik(server, name, inputs)
		} else {
			throw new Error(`unknown proxy on ${serverId}`)
		}
	} catch (err) {
		// masked before it is stored and returned
		appliedError = redactSecrets(clientErrorMessage(err, 'apply failed', 'domains/:serverId/:name/:hostname'))
	}

	await db
		.update(domainRedirects)
		.set({
			appliedAt: appliedError ? null : new Date(),
			appliedError: redactNullable(appliedError),
		})
		.where(
			and(
				eq(domainRedirects.serverId, serverId),
				eq(domainRedirects.containerName, name),
				eq(domainRedirects.hostname, decodedHostname),
			),
		)

	if (appliedError) return Response.json({ error: appliedError }, { status: 502 })
	return Response.json({ ok: true, applied: true })
}

function parseCustom(s: string): CustomRedirect[] {
	try {
		const v = JSON.parse(s)
		return Array.isArray(v) ? v : []
	} catch {
		return []
	}
}
