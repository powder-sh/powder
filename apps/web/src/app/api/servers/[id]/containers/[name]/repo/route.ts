import type { NextRequest } from 'next/server'
import { requireContainerAccess } from '@/lib/access'
import { adoptContainerProblem, adoptWorkingDirProblem } from '@/lib/app-names'
import { branchProblem, repoUrlProblem } from '@/lib/git-input'
import { generateDeployKey } from '@/lib/keygen'
import {
	ServerGoneError,
	createRepo,
	deleteRepo,
	appNamesOnServer,
	getRepoFor,
	projectNameProblem,
} from '@/lib/repos'
import { type AppCheckout, checkoutNote, cloneRefusal } from '@/lib/app-checkout'
import { deleteRemoteFile, inspectContainer, writeFileSecret } from '@/lib/ssh'
import { deployKeyMissingForRepo, probeAppCheckout } from '@/lib/ssh/git'
import { removeGithubObjects } from '@/lib/github-disconnect'
import { archiveAppEnvFiles } from '@/lib/deleted-env'
import { webhookConfigError, webhookUrl as buildWebhookUrl } from '@/lib/hosts'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Split: always the public-site host, so new hooks match the installed ones (lib/hosts.ts).
function publicWebhookUrl(req: NextRequest, token: string): string {
	return buildWebhookUrl(token, req.headers)
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name, { allowUnmanaged: true })
	if (access instanceof Response) return access
	const { server } = access

	const row = await getRepoFor(id, name)
	if (!row) return Response.json({ connected: false })

	// where the app's checkout is (src/ first: lib/app-checkout.ts). The UI offers the
	// clone action only when cloneRefusal allows it; checkoutNote says what is true.
	let checkout: AppCheckout = { kind: 'unknown' }
	let workingDir: string | null = null
	try {
		const detail = await inspectContainer(server, name)
		workingDir = detail.compose.workingDir ?? null
		if (workingDir) checkout = await probeAppCheckout(server, workingDir)
	} catch {
		// ignore; checkout stays unknown
	}
	const isCheckout = checkout.kind === 'src' || checkout.kind === 'workdir'
	// a clone whose deploy key could not be written afterwards: the clone action then
	// writes only the key (repo/clone route)
	const keyMissing =
		checkout.kind === 'src' && !!workingDir
			? await deployKeyMissingForRepo(server, workingDir.replace(/\/+$/, ''), row.repoUrl).catch(() => false)
			: false

	return Response.json({
		connected: true,
		repoUrl: row.repoUrl,
		branch: row.branch,
		deployKeyPub: row.deployKeyPub,
		webhookUrl: publicWebhookUrl(req, row.webhookToken),
		webhookSecret: null,
		isCheckout,
		checkout,
		checkoutNote: checkoutNote(workingDir, checkout),
		// the clone action (into <working dir>/src) is offered only when the layout allows it
		cloneAllowed: !!workingDir && cloneRefusal(workingDir, checkout) === null,
		keyMissing,
		createdAt: row.createdAt,
	})
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name, { allowUnmanaged: true })
	if (access instanceof Response) return access
	const { server, user } = access
	// Refuse before connecting: the webhook URL needs this install's own base URL.
	const hookConfig = webhookConfigError()
	if (hookConfig) return Response.json({ error: hookConfig }, { status: 503 })

	const existing = await getRepoFor(id, name)
	if (existing) {
		return Response.json({ error: 'already connected; disconnect first' }, { status: 400 })
	}

	const body = (await req.json()) as { repoUrl?: unknown; branch?: unknown }
	if (typeof body.repoUrl !== 'string' || !body.repoUrl) {
		return Response.json({ error: 'repoUrl required' }, { status: 400 })
	}
	const branch = body.branch === undefined ? 'main' : body.branch
	if (typeof branch !== 'string') return Response.json({ error: 'unsafe branch name' }, { status: 400 })
	// Validate before anything is stored or reaches git (option injection, credentials in the URL).
	const bad = repoUrlProblem(body.repoUrl) ?? branchProblem(branch)
	if (bad) return Response.json({ error: bad }, { status: 400 })

	const detail = await inspectContainer(server, name)
	if (!detail.compose.workingDir) {
		return Response.json(
			{ error: 'container has no compose working dir; cannot connect repo' },
			{ status: 400 },
		)
	}
	// never a reserved name, powder's own container or powder's compose project
	const adopt = adoptContainerProblem(name, detail.compose.project) ?? adoptWorkingDirProblem(detail.compose.workingDir)
	if (adopt) return Response.json({ error: adopt }, { status: 400 })

	// no compose project name another app on the server (or powder) has.
	const clash = await projectNameProblem(id, name)
	if (clash) return Response.json({ error: clash }, { status: 400 })

	const { pub, priv } = await generateDeployKey()
	// The server row is share-locked while the app row goes in (lib/repos.ts): a server
	// deleted meanwhile answers 404 and leaves no app pointing at it.
	let created: Awaited<ReturnType<typeof createRepo>>
	try {
		created = await createRepo({
			serverId: id,
			containerName: name,
			repoUrl: body.repoUrl,
			branch,
			pub,
			priv,
			ownerUserId: user.id,
		})
	} catch (err) {
		if (err instanceof ServerGoneError) return Response.json({ error: err.message }, { status: 404 })
		throw err
	}
	const { row, webhookSecret } = created

	// plant the deploy key on the server at <workingDir>/.deploy-key
	const keyPath = `${detail.compose.workingDir}/.deploy-key`
	try {
		await writeFileSecret(server, keyPath, priv)
	} catch (err) {
		// rollback the DB row if we couldn't plant the key
		await deleteRepo(row.id)
		return Response.json(
			{ error: `failed to plant deploy key on server: ${clientErrorMessage(err, String(err), 'servers/:id/containers/:name/repo')}` },
			{ status: 500 },
		)
	}

	return Response.json({
		connected: true,
		repoUrl: row.repoUrl,
		branch: row.branch,
		deployKeyPub: row.deployKeyPub,
		webhookUrl: publicWebhookUrl(req, row.webhookToken),
		webhookSecret, // shown ONCE to user on connect
		createdAt: row.createdAt,
	})
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server, user } = access

	const existing = await getRepoFor(id, name)
	if (!existing) return Response.json({ ok: true, alreadyMissing: true })

	const detail = await inspectContainer(server, name).catch(() => null)
	if (detail?.compose.workingDir) {
		await deleteRemoteFile(server, `${detail.compose.workingDir}/.deploy-key`).catch(() => {})
	}
	// remove the GitHub deploy key and webhook powder installed
	// (best effort; failures are logged and reported, the disconnect goes on).
	const github = await removeGithubObjects(existing, user.id)
	await deleteRepo(existing.id)
	// when no container of the app is left, its env files leave /opt/apps for a
	// root-only archive (best effort); the answer names the archive dir, or why they stay.
	const otherApps = await appNamesOnServer(id).catch(() => [] as string[])
	const envArchive = await archiveAppEnvFiles(server, name, otherApps)
	return Response.json({ ok: true, github, envArchive })
}
