import { POWDER_GIT_NOREPO, gitCmd, gitHardenShellFunctions } from '@/lib/git-harden'
import type { NextRequest } from 'next/server'
import { branchProblem, repoUrlProblem } from '@/lib/git-input'
import { requireContainerAccess } from '@/lib/access'
import { adoptContainerProblem, adoptWorkingDirProblem } from '@/lib/app-names'
import { bulkImportFromText, envWriteCtx } from '@/lib/env-vars-db'
import { createDeployKey, createWebhook, getRepoInfo } from '@/lib/github'
import { getGithubIntegration } from '@/lib/integrations'
import { generateDeployKey } from '@/lib/keygen'
import { ServerGoneError, createRepo, projectNameProblem, deleteRepo, getRepoFor, setRepoGithubIds } from '@/lib/repos'
import {
	GITHUB_KNOWN_HOSTS_SETUP,
	GIT_SSH_HOSTKEY_OPTS,
	findEnvFile,
	inspectContainer,
	runCommand,
	writeFileSecret,
} from '@/lib/ssh'
import { shq } from '@/lib/shell'
import { probeAppCheckout } from '@/lib/ssh/git'
import { webhookConfigError, webhookUrl as buildWebhookUrl } from '@/lib/hosts'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Split: always the public-site host, so new hooks match the installed ones (lib/hosts.ts).
function publicWebhookUrl(req: NextRequest, token: string): string {
	return buildWebhookUrl(token, req.headers)
}

// A connect step that isn't fatal: it's attempted, the outcome is recorded, and
// the flow continues. The response returns the full list so the UI can show a
// green/amber checklist instead of a single opaque "connected": a step that did
// not happen is named, so the operator knows what is left to do by hand.
interface Step {
	step: string
	ok: boolean
	detail: string
}

// Connect (adopt) an already-running container to powder. Unlike /new this does
// NOT clone or create the container — it adopts what's there. The goal is that
// after this returns, a `git push` actually deploys, with zero manual follow-up:
// deploy key planted both sides, the push webhook installed, env backfilled into
// the DB before DB-mode can wipe disk-only keys, and a dry-run that proves the
// key + branch resolve.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params

	const access = await requireContainerAccess(id, name, { allowUnmanaged: true })
	if (access instanceof Response) return access
	const { server, user } = access

	// Refuse before touching GitHub: a webhook needs this install's own base URL.
	const hookConfig = webhookConfigError()
	if (hookConfig) return Response.json({ error: hookConfig }, { status: 503 })

	const gh = await getGithubIntegration(user.id)
	if (!gh) {
		return Response.json({ error: 'github not connected — visit /integrations' }, { status: 400 })
	}

	const existing = await getRepoFor(id, name)
	if (existing) {
		return Response.json({ error: 'already connected; disconnect first' }, { status: 400 })
	}

	const body = (await req.json()) as { repoFullName?: string; branch?: string }
	if (!body.repoFullName) {
		return Response.json({ error: 'repoFullName required' }, { status: 400 })
	}
	const [owner, repoName] = body.repoFullName.split('/')
	if (!owner || !repoName) {
		return Response.json({ error: 'expected owner/repo format' }, { status: 400 })
	}

	const detail = await inspectContainer(server, name)
	const workingDir = detail.compose.workingDir
	if (!workingDir) {
		return Response.json({ error: 'container has no compose working dir' }, { status: 400 })
	}
	// never a reserved name, powder's own container or powder's compose project
	const adopt = adoptContainerProblem(name, detail.compose.project) ?? adoptWorkingDirProblem(detail.compose.workingDir)
	if (adopt) return Response.json({ error: adopt }, { status: 400 })

	// no compose project name another app on the server (or powder) has.
	const clash = await projectNameProblem(id, name)
	if (clash) return Response.json({ error: clash }, { status: 400 })

	const { pub, priv } = await generateDeployKey()
	const repoUrl = `git@github.com:${owner}/${repoName}.git`
	const branch = body.branch ?? 'main'
	const bad = repoUrlProblem(repoUrl) ?? branchProblem(branch)
	if (bad) return Response.json({ error: bad }, { status: 400 })

	// The server row is share-locked while the app row goes in (lib/repos.ts): a server
	// deleted meanwhile answers 404 and leaves no app pointing at it.
	let created: Awaited<ReturnType<typeof createRepo>>
	try {
		created = await createRepo({
			serverId: id,
			containerName: name,
			repoUrl,
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

	// best effort cleanup if a HARD step below fails
	const rollback = async () => {
		await deleteRepo(row.id).catch(() => {})
	}

	// ── HARD steps: if any fail, the connection is fundamentally broken, so we
	// tear the row back down and surface the error. ──────────────────────────

	// 1) plant the deploy key on the server
	const keyPath = `${workingDir}/.deploy-key`
	try {
		await writeFileSecret(server, keyPath, priv)
	} catch (err) {
		await rollback()
		return Response.json(
			{ error: `couldn't plant deploy key on server: ${clientErrorMessage(err, String(err), 'servers/:id/containers/:name/repo/import')}` },
			{ status: 500 },
		)
	}

	// 2) install deploy key on github (read-only — powder only ever pulls)
	let ghKey: { id: number } | null = null
	try {
		ghKey = await createDeployKey(gh.token, owner, repoName, `powder · ${name}`, pub, true)
	} catch (err) {
		await rollback()
		return Response.json(
			{ error: `couldn't add deploy key to github: ${clientErrorMessage(err, String(err), 'servers/:id/containers/:name/repo/import')}` },
			{ status: 502 },
		)
	}

	// 3) install push webhook on github: the deploy trigger for every app. A
	// registry-mode app (compose `image:` without `build:`) pulls its image on that
	// deploy instead of building it on the server.
	const webhookUrl = publicWebhookUrl(req, row.webhookToken)
	let hookId: number | null = null
	try {
		hookId = (await createWebhook(gh.token, owner, repoName, webhookUrl, webhookSecret)).id
	} catch (err) {
		await rollback()
		return Response.json(
			{
				error: `couldn't create webhook: ${clientErrorMessage(err, String(err), 'servers/:id/containers/:name/repo/import')}. deploy key on github may need manual cleanup (key id: ${ghKey?.id}).`,
			},
			{ status: 502 },
		)
	}

	// remember what was installed so disconnect can remove it.
	// and the repository id every push must keep naming.
	const repoId = await getRepoInfo(gh.token, owner, repoName).then((r) => r.id).catch(() => null)
	await setRepoGithubIds(row.id, { deployKeyId: ghKey?.id ?? null, hookId, repoId })

	// ── SOFT steps: best-effort hardening. Each is attempted and recorded;
	// a failure is reported in the checklist but does NOT undo the connection. ──
	const steps: Step[] = [
		{ step: 'deploy-key planted on server', ok: true, detail: keyPath },
		{ step: 'deploy-key installed on github (read-only)', ok: true, detail: `key id ${ghKey?.id}` },
		{ step: 'push webhook installed on github', ok: true, detail: webhookUrl },
	]

	// 4) backfill the on-disk env file into the DB (non-overwriting). Critical with
	// POWDER_ENV_VARS_DB_MODE on: once the DB has ANY key, the next deploy renders
	// the full DB set to disk — so disk-only secrets must be in the DB FIRST.
	try {
		const env = await findEnvFile(server, name)
		if (!env.exists) {
			steps.push({ step: 'env backfill', ok: true, detail: 'no env file on server — nothing to import' })
		} else {
			const r = await bulkImportFromText(
				row.id, env.contents, 'production', envWriteCtx(req, user), { overwrite: false },
			)
			steps.push({
				step: 'env backfilled disk → DB',
				ok: true,
				detail: `${env.path}: imported ${r.imported}, already-present ${r.existing}, skipped ${r.skipped}${r.deniedKeys.length ? ` (not imported, set them from the dashboard: ${r.deniedKeys.join(', ')})` : ''}`,
			})
		}
	} catch (err) {
		steps.push({
			step: 'env backfill',
			ok: false,
			detail: `failed: ${clientErrorMessage(err, String(err), 'servers/:id/containers/:name/repo/import')}`,
		})
	}

	// 5) dry-run verify: prove the planted deploy key authenticates AND the
	// registered branch exists on the remote, before anyone pushes. ls-remote is
	// read-only and fast.
	try {
		// Pinned GitHub host keys, not trust-on-first-use.
		const verifyCmd = `${GITHUB_KNOWN_HOSTS_SETUP}export GIT_SSH_COMMAND="ssh -i ${shq(keyPath)} -o IdentitiesOnly=yes ${GIT_SSH_HOSTKEY_OPTS}"; cd / && ${gitHardenShellFunctions()}${POWDER_GIT_NOREPO} ls-remote -- ${shq(repoUrl)} ${shq('refs/heads/' + branch)}`
		const res = await runCommand(server, verifyCmd, 30_000)
		if (res.code === 0 && res.stdout.trim()) {
			steps.push({ step: 'deploy-key + branch verified', ok: true, detail: `ls-remote resolved refs/heads/${branch}` })
		} else if (res.code === 0) {
			steps.push({
				step: 'deploy-key + branch verified',
				ok: false,
				detail: `key works but branch "${branch}" not found on remote — set the correct branch`,
			})
		} else {
			steps.push({
				step: 'deploy-key + branch verified',
				ok: false,
				detail: `ls-remote failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 300)}`,
			})
		}
	} catch (err) {
		steps.push({
			step: 'deploy-key + branch verified',
			ok: false,
			detail: `verify errored: ${clientErrorMessage(err, String(err), 'servers/:id/containers/:name/repo/import')}`,
		})
	}

	// 6) detect (don't auto-fix) the two traps that silently break adopted
	// apps: an on-disk checkout sitting on a different branch than the one
	// registered (powder's reattach only handles detached HEAD, not a misnamed
	// branch), and a compose that builds on the server (can OOM a server with little memory).
	try {
		// the checkout the deploy syncs (src/ first: lib/app-checkout.ts)
		const co = await probeAppCheckout(server, workingDir)
		const coDir = co.kind === 'src' || co.kind === 'workdir' ? co.dir : null
		const onDisk = coDir
			? await runCommand(
					server, `${gitHardenShellFunctions()}${gitCmd(shq(coDir), shq(coDir))} rev-parse --abbrev-ref HEAD 2>/dev/null || true`, 10_000,
				)
			: { stdout: '' }
		const cur = onDisk.stdout.trim()
		if (coDir && cur && cur !== 'HEAD' && cur !== branch) {
			steps.push({
				step: 'on-disk branch',
				ok: false,
				detail: `checkout is on "${cur}" but registered branch is "${branch}"; run: git -C ${coDir} checkout ${branch} (deploys pull the registered branch)`,
			})
		} else {
			steps.push({ step: 'on-disk branch', ok: true, detail: cur ? `on ${cur}` : 'not a git checkout (registry-mode)' })
		}
	} catch {
		// non-fatal; skip
	}

	try {
		const cfg = detail.compose.configFile
		if (cfg) {
			const buildGrep = await runCommand(server, `grep -qE '^[[:space:]]*build:' ${shq(cfg)} && echo build || echo image`, 10_000)
			if (buildGrep.stdout.trim() === 'build') {
				steps.push({
					step: 'deploy mode',
					ok: false,
					detail: `compose has a build: block, powder will rebuild on the server (OOM risk on servers with little memory). Switch to registry-mode (image: ghcr.io/${owner}/${repoName}:latest) to pull the CI-built image instead.`,
				})
			} else {
				steps.push({ step: 'deploy mode', ok: true, detail: 'registry-mode (pulls prebuilt image)' })
			}
		}
	} catch {
		// non-fatal; skip
	}

	const allGreen = steps.every((s) => s.ok)
	return Response.json({
		connected: true,
		allGreen,
		repoUrl,
		branch,
		deployKeyPub: pub,
		webhookUrl,
		autoInstalled: true,
		steps,
		createdAt: row.createdAt,
	})
}
