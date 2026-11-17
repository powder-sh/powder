// Notification targets (lib/notifications.ts): list, create, delete.
// Webhook URLs are encrypted at rest and only ever leave as origin + "/…";
// email targets need SMTP (POWDER_SMTP_URL + POWDER_MAIL_FROM).

import { excludeSelf, requireUser } from '@/lib/access'
import { appRepos, createId, db, desc, eq, notificationTargets, prefixes, servers } from '@/lib/db'
import { decryptSecret, encryptSecret } from '@/lib/crypto'
import { BodyTooLargeError, bodyTooLargeResponse, readJsonCapped } from '@/lib/http-limits'
import { isValidEmail, smtpConfigured } from '@/lib/mailer'
import { NOTIFY_EVENTS, isNotifyEvent } from '@/lib/notify-routing'
import { checkWebhookUrl } from '@/lib/notify-url-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function maskWebhook(enc: string | null): string {
	if (!enc) return ''
	try {
		return `${new URL(decryptSecret(enc)).origin}/…`
	} catch {
		return '(unreadable)'
	}
}

export async function GET() {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const rows = await db
		.select()
		.from(notificationTargets)
		.orderBy(desc(notificationTargets.createdAt))
	// the app picker: powder's own row only to an admin session (lib/access.ts visibleRepos).
	const appRows = await db
		.select({
			id: appRepos.id,
			containerName: appRepos.containerName,
			serverId: appRepos.serverId,
			serverName: servers.name,
		})
		.from(appRepos)
		.leftJoin(servers, eq(servers.id, appRepos.serverId))
		.orderBy(appRepos.containerName)
	const apps = excludeSelf(appRows, userOrResp, 'admin-session')
	return Response.json({
		smtpConfigured: smtpConfigured(),
		envWebhook: Boolean(process.env.POWDER_NOTIFY_WEBHOOK_URL?.trim()),
		events: NOTIFY_EVENTS,
		apps,
		targets: rows.map((t) => ({
			id: t.id,
			kind: t.kind,
			destination: t.kind === 'webhook' ? maskWebhook(t.urlEncrypted) : (t.email ?? ''),
			events: t.events,
			appRepoId: t.appRepoId,
			enabled: t.enabled,
			createdAt: t.createdAt,
		})),
	})
}

export async function POST(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const body = (await readJsonCapped(req, 16 * 1024).catch((e) =>
		e instanceof BodyTooLargeError ? e : {},
	)) as { kind?: unknown; url?: unknown; email?: unknown; events?: unknown; appRepoId?: unknown }
	if (body instanceof BodyTooLargeError) return bodyTooLargeResponse()

	const events = body.events
	if (!Array.isArray(events) || events.length === 0 || !events.every(isNotifyEvent)) {
		return Response.json(
			{ error: `events must be a non-empty list of: ${NOTIFY_EVENTS.join(', ')}` },
			{ status: 400 },
		)
	}
	let appRepoId: string | null = null
	if (body.appRepoId !== undefined && body.appRepoId !== null && body.appRepoId !== '') {
		if (typeof body.appRepoId !== 'string')
			return Response.json({ error: 'invalid appRepoId' }, { status: 400 })
		const [app] = await db
			.select({ id: appRepos.id })
			.from(appRepos)
			.where(eq(appRepos.id, body.appRepoId))
			.limit(1)
		if (!app) return Response.json({ error: 'unknown app' }, { status: 400 })
		appRepoId = app.id
	}

	const id = createId(prefixes.notificationTarget)
	const base = { id, events: [...new Set(events)], appRepoId, enabled: true }
	if (body.kind === 'webhook') {
		if (typeof body.url !== 'string')
			return Response.json({ error: 'url is required' }, { status: 400 })
		const check = await checkWebhookUrl(body.url)
		if (!check.ok) return Response.json({ error: check.error }, { status: 400 })
		await db.insert(notificationTargets).values({
			...base,
			kind: 'webhook',
			urlEncrypted: encryptSecret(check.url.toString()),
		})
	} else if (body.kind === 'email') {
		if (!smtpConfigured()) return Response.json({ error: 'SMTP not configured' }, { status: 400 })
		const email = typeof body.email === 'string' ? body.email.trim() : ''
		if (!isValidEmail(email))
			return Response.json({ error: 'invalid email address' }, { status: 400 })
		await db.insert(notificationTargets).values({ ...base, kind: 'email', email })
	} else {
		return Response.json({ error: "kind must be 'webhook' or 'email'" }, { status: 400 })
	}
	return Response.json({ ok: true, id })
}

export async function DELETE(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const id = new URL(req.url).searchParams.get('id')
	if (!id) return Response.json({ error: 'id is required' }, { status: 400 })
	const gone = await db
		.delete(notificationTargets)
		.where(eq(notificationTargets.id, id))
		.returning({ id: notificationTargets.id })
	if (gone.length === 0) return Response.json({ error: 'not found' }, { status: 404 })
	return Response.json({ ok: true })
}
