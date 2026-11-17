import { createHash } from 'node:crypto'
import { containerReadError } from '@/lib/container-state'
import { requireContainerAccess } from '@/lib/access'
import { redactSecrets } from '@/lib/secret-text'
import {
	envFileCandidatesFor,
	findEnvFile,
	inspectContainer,
	readEnvFile,
	readEnvRestoreMarker,
	writeEnvFile,
} from '@/lib/ssh'
import { and, appRepos, db, eq } from '@/lib/db'
import {
	deleteForProject,
	envWriteCtx,
	isEnvDbModeEnabled,
	listForProject,
	renderEnvFile,
	setForProject,
} from '@/lib/env-vars-db'
import {
	maskEntries,
	revealDenied,
	revealKey,
	revealRequested,
	revealView,
} from '@/lib/secret-mask'
import { parseRawEnv, RENDER_NOISE_KEYS, serializeEnv } from '@/lib/env-parse'
import { envTargetInAppDir } from '@/lib/env-target'
import { EnvKeyDeniedError, envKeyDeleteDenied, envKeyWriteDenied, isAdminSession, TOKEN_ENV_FILE_REFUSAL } from '@/lib/env-key-policy'
import { clientErrorMessage } from '@/lib/pg-error'

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// For apps on a Traefik server with previews, preview deploys read this OVERRIDES
// file in addition to the production one. Keys here win.
function previewEnvFilePath(containerName: string): string {
	return `/opt/apps/${containerName}.preview.env`
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server, user } = access
	const denied = revealDenied(req, user)
	if (denied) return denied
	const reveal = revealRequested(req)
	const key = revealKey(req)
	// masked unless `?reveal=1` from an admin session; `&key=` reveals one entry.
	// `live` = the running container's env (production): each entry gets
	// `differs`, compared on the raw values here, so the page can show drift
	// without ever holding the values.
	const view = (contents: string, live: Map<string, string> | null = null) => {
		const raw = parseRawEnv(contents)
		const entries = live ? raw.map((e) => ({ ...e, differs: live.get(e.key) !== e.value })) : raw
		if (reveal && key === null) return { entries, raw: contents }
		const shown = revealView(entries, reveal, key)
		return { entries: shown, raw: serializeEnv(maskEntries(raw)) }
	}

	const url = new URL(req.url)
	const scope = url.searchParams.get('scope') === 'preview' ? 'preview' : 'production'

	try {
		// Preview scope reads the dedicated preview env file
		// (/opt/apps/<app>.preview.env); missing = empty. A preview reads only that
		// file, never the production env.
		if (scope === 'preview') {
			const path = previewEnvFilePath(name)
			const { exists, contents } = await readEnvFile(server, path)
			return Response.json({
				supported: true,
				scope: 'preview',
				kind: server.kind,
				autoApply: false, // changes apply on the next preview deploy, not immediately
				path,
				exists,
				candidates: [path],
				...view(contents),
			})
		}
		const { path, exists, contents, candidates } = await findEnvFile(server, name)
		const live = await inspectContainer(server, name)
			.then((d) => new Map(d.env.map((e) => [e.key, e.value])))
			.catch(() => null)
		return Response.json({
			supported: true,
			scope: 'production',
			kind: server.kind,
			autoApply: server.kind === 'compose',
			path,
			exists,
			candidates,
			...view(contents, live),
		})
	} catch (err) {
		// ssh / file error text can carry env values: containerReadError redacts it.
		return containerReadError(err)
	}
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server } = access

	const url = new URL(req.url)
	const scope = url.searchParams.get('scope') === 'preview' ? 'preview' : 'production'

	const body = (await req.json()) as {
		entries: { key: string; value: string }[]
		path?: string
	}
	if (!body?.entries || !Array.isArray(body.entries)) {
		return Response.json({ error: 'expected { entries: [...] }' }, { status: 400 })
	}
	const badKey = body.entries.find(
		(e) => typeof e?.key !== 'string' || typeof e?.value !== 'string' || (e.key && !ENV_KEY_RE.test(e.key)),
	)
	if (badKey) {
		return Response.json({ error: `invalid env key: ${String(badKey?.key).slice(0, 60)}` }, { status: 400 })
	}

	try {
		// Validate the path against an allowlist derived from this container's
		// compose config. Without this, a tenant owning app A could write to any
		// path on the server (powder's SSH is root) — including /etc/cron.d/* or
		// another app's env file. Same allowlist for both "auto-pick" and
		// "user-supplied path" paths so the auto-pick can't introduce a path
		// that wouldn't pass validation.
		const allowedPaths =
			scope === 'preview'
				? [previewEnvFilePath(name)]
				: await envFileCandidatesFor(server, name)
		const path = body.path ?? allowedPaths[0]
		if (!path) return Response.json({ error: 'no candidate env path' }, { status: 400 })
		if (!allowedPaths.includes(path)) {
			return Response.json(
				{ error: 'path not in allowlist for this container', allowedPaths },
				{ status: 400 },
			)
		}
		// the file is saved whole. Skipping the rule for a key whose sent value equals the
		// disk value would let a token confirm a guessed secret (200 vs 403), so every key
		// in the save, changed or not, and
		// every key it drops is checked, and every token refusal is the same 403: the
		// answer never depends on a value the token cannot read.
		const adminSession = isAdminSession(access.user)
		if (!adminSession) {
			const diskText = (await readEnvFile(server, path)).contents
			const onDisk = new Map(parseRawEnv(diskText).map((e) => [e.key, e.value]))
			let refused = false
			for (const e of body.entries) if (e.key && envKeyWriteDenied(e.key, e.value, false)) refused = true
			// a key the save drops is a delete of that key, under the same rule.
			const kept = new Set(body.entries.map((e) => e.key))
			for (const k of onDisk.keys()) if (!kept.has(k) && envKeyDeleteDenied(k, false)) refused = true
			// a rollback's env snapshot restore (or a hand edit) can leave values and
			// keys on disk that are not the DB's; saving the file whole would pin them as the
			// token's own write. Refuse until an admin session saves it or a deploy re-renders.
			if (!refused && scope === 'production' && (await tokenEnvFilePinRefusal(server, id, name, path, diskText, onDisk)))
				refused = true
			if (refused) return Response.json({ error: TOKEN_ENV_FILE_REFUSAL, code: 'token_env_file' }, { status: 403 })
		}
		// Write through to the DB first. The disk file is a deploy artifact: a
		// disk-only edit either gets clobbered on the next deploy or trips the
		// drift guard and freezes the app's env render. Mirror the change into
		// app_env_vars so disk and DB agree.
		// the candidates come from the compose (a repo file in the workdir layout);
		// the same containment as the deploy render applies (env-target.ts).
		if (scope === 'production') {
			const { checkEnvRenderTarget } = await import('@/lib/env-vars-db')
			// Never creates a pin: only a deploy render may, from pre-upgrade evidence.
			const unsafe = await checkEnvRenderTarget(server, name, path, { allowPin: false })
			if (unsafe) return Response.json({ error: unsafe }, { status: 400 })
		}
		let synced = 0
		if (scope === 'production') {
			synced = await writeThroughToDb(req, access.user, server, id, name, path, body.entries)
		}
		const contents = serializeEnv(body.entries)
		await writeEnvFile(server, path, contents, {
			noSymlinkBelow:
				scope === 'production' && envTargetInAppDir(path, name) ? `/opt/apps/${name}` : undefined,
		})
		return Response.json({ ok: true, path, dbSynced: synced })
	} catch (err) {
		return Response.json(
			// ssh / file error text can carry env values
			{ error: redactSecrets(clientErrorMessage(err, 'unknown error', 'servers/:id/containers/:name/env-file')) },
			{ status: 500 },
		)
	}
}

/** why a non-admin save of the production env file is refused, or null. Refused while
 *  the file is still what a rollback's env snapshot restore wrote, and, for an
 *  app whose env lives in the DB (DB mode on, at least one production key), while the file on disk holds a key the DB does not. */
async function tokenEnvFilePinRefusal(
	server: Parameters<typeof readEnvFile>[0],
	serverId: string,
	containerName: string,
	path: string,
	diskText: string,
	onDisk: Map<string, string>,
): Promise<string | null> {
	// The marker is the sha256 of the file the restore wrote: an admin save or a deploy
	// render since then changed the file, and the rule below still applies.
	const marker = await readEnvRestoreMarker(server, path).catch(() => 'unreadable')
	if (marker && (marker === 'unreadable' || createHash('sha256').update(diskText, 'utf8').digest('hex') === marker))
		return 'the env file was restored from an older deploy by a rollback; a token cannot save it. Save it from an admin session, or redeploy so powder renders it from the database first.'
	if (!isEnvDbModeEnabled()) return null
	const [repo] = await db
		.select({ id: appRepos.id })
		.from(appRepos)
		.where(and(eq(appRepos.serverId, serverId), eq(appRepos.containerName, containerName)))
		.limit(1)
	if (!repo) return null
	const dbKeys = new Set((await listForProject(repo.id)).filter((v) => v.scope === 'production').map((v) => v.key))
	if (dbKeys.size === 0) return null
	const extra = [...onDisk.keys()].filter((k) => k && !dbKeys.has(k) && !RENDER_NOISE_KEYS.has(k))
	if (extra.length > 0)
		return `the env file on disk holds ${extra.length} key${extra.length === 1 ? '' : 's'} powder's database does not (${extra.slice(0, 10).join(', ')}); a token cannot save it. Save it from an admin session, or sync those keys into powder first.`
	return null
}

// Upserts changed/added keys and deletes keys the user removed from the file,
// for apps that are DB-managed (DB mode on + a registered app_repos row with at
// least one var). Unchanged keys are skipped so a save doesn't spam versions +
// audit rows. Returns the number of DB writes.
async function writeThroughToDb(
	req: Request,
	user: { id: string; isAdmin: boolean; viaToken?: boolean },
	server: Parameters<typeof readEnvFile>[0],
	serverId: string,
	containerName: string,
	path: string,
	entries: { key: string; value: string }[],
): Promise<number> {
	if (!isEnvDbModeEnabled()) return 0
	const [repo] = await db
		.select({ id: appRepos.id })
		.from(appRepos)
		.where(and(eq(appRepos.serverId, serverId), eq(appRepos.containerName, containerName)))
		.limit(1)
	if (!repo) return 0
	const dbVars = (await listForProject(repo.id)).filter((v) => v.scope === 'production')
	if (dbVars.length === 0) return 0

	const current = new Map(parseRawEnv(await renderEnvFile(repo.id, 'production')).map((e) => [e.key, e.value]))
	const onDisk = new Set(parseRawEnv((await readEnvFile(server, path)).contents).map((e) => e.key))
	const next = new Map(entries.filter((e) => e.key && !RENDER_NOISE_KEYS.has(e.key)).map((e) => [e.key, e.value]))
	const ctx = envWriteCtx(req, user)
	let n = 0
	for (const [key, value] of next) {
		if (current.get(key) === value) continue
		try {
			await setForProject(repo.id, key, value, 'production', ctx)
		} catch (err) {
			// Unchanged on disk (the PUT pre-check passed it) but not in the DB:
			// leave the DB as it was rather than let a token mirror a loader key.
			if (err instanceof EnvKeyDeniedError) continue
			throw err
		}
		n++
	}
	// Only delete keys the user could see (on disk) and removed — never a DB key
	// that simply wasn't rendered to this file.
	for (const v of dbVars) {
		if (next.has(v.key) || RENDER_NOISE_KEYS.has(v.key) || !onDisk.has(v.key)) continue
		try {
			await deleteForProject(repo.id, v.key, 'production', ctx)
		} catch (err) {
			if (err instanceof EnvKeyDeniedError) continue
			throw err
		}
		n++
	}
	return n
}
