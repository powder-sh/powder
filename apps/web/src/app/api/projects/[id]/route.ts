// Per-project detail: project metadata + recent deploys. A deploy carries the head of
// its output (preview) and, when it failed, its summary, failed step, exit code and the
// end of its log (lib/deploy-log-read.ts), never the whole log: that is on /deploys/<id>.
// Used by /projects/[id] to render the deploy history.

import { redactNullable, redactSecrets, safeSlice } from '@/lib/secret-text'
import type { NextRequest } from 'next/server'
import { db, appRepos, appUptimeChecks, cronJobs, eq, desc, and } from '@/lib/db'
import { requireProjectAccess } from '@/lib/access'
import { settleNote } from '@/lib/deploy-settle'
import { getServer } from '@/lib/servers'
import { inspectContainer } from '@/lib/ssh'
import { type ContainerState, isNoSuchContainer, readContainerState } from '@/lib/container-state'
import { webhookUrl as buildWebhookUrl } from '@/lib/hosts'
import { BodyTooLargeError, bodyTooLargeResponse, readJsonCapped } from '@/lib/http-limits'
import { argvToDisplay } from '@/lib/managed-crons'
import { BACKUP_DB_FIELDS, backupDbProblem, validateAppSettings } from '@/lib/app-settings'
import { encryptSecret } from '@/lib/crypto'
import { sessionOnlyActionDenied } from '@/lib/session-only'
import { emptyDays } from '@/lib/deploy-days'
import { deployDaysFor } from '@/lib/deploy-days-db'
import { failureTailFromWindows } from '@/lib/deploy-log-read'
import { recentDeploysQuery } from '@/lib/project-deploys-db'
import { previewBlockReason } from '@/lib/preview-deploys'
import { isTraefikServer } from '@/lib/traefik-servers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Split: always the public-site host, so new hooks match the installed ones (lib/hosts.ts).
function publicWebhookUrl(req: NextRequest, token: string): string {
	return buildWebhookUrl(token, req.headers)
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	// the one project access check (user, row, never powder's own container)
	const access = await requireProjectAccess(id, { selfRead: true })
	if (access instanceof Response) return access
	const { repo, user } = access

	// Recent deploys: windows of the log columns, only for the newest rows (lib/project-deploys-db.ts).
	const recentDeploys = await recentDeploysQuery(repo.serverId, repo.containerName)

	// Container state: running, missing, or server unreachable (lib/container-state.ts).
	// ?part=db skips it: that SSH round can take seconds on an unreachable server,
	// and the app tabs render from the database part while it runs.
	const server = await getServer(repo.serverId)
	const dbOnly = new URL(req.url).searchParams.get('part') === 'db'
	const container: ContainerState | undefined = dbOnly
		? undefined
		: server
			? await readContainerState(() => inspectContainer(server, repo.containerName), isNoSuchContainer)
			: { reachable: false, exists: false, error: 'server not found' }

	// Live uptime check - same source as the /projects list. Lets the page
	// header reflect "is this app actually responding right now" rather than
	// just "did the last deploy succeed at some point in the past."
	const [uptime] = await db
		.select()
		.from(appUptimeChecks)
		.where(eq(appUptimeChecks.appRepoId, repo.id))
		.limit(1)

	// Deploys per day, last 30 days (the strip on the overview tab).
	const days = await deployDaysFor([repo])

	// Crons attached to this app.
	const crons = await db
		.select()
		.from(cronJobs)
		.where(and(eq(cronJobs.serverId, repo.serverId), eq(cronJobs.containerName, repo.containerName)))
		.orderBy(desc(cronJobs.createdAt))

	return Response.json({
		project: {
			id: repo.id,
			serverId: repo.serverId,
			serverName: server?.name ?? repo.serverId,
			containerName: repo.containerName,
			repoUrl: repo.repoUrl,
			branch: repo.branch,
			hasPostgres: repo.hasPostgres,
			hasKv: repo.hasKv,
			createdAt: repo.createdAt,
			container,
		},
		uptime: uptime
			? {
				url: uptime.url,
				isUp: uptime.isUp,
				lastCheckedAt: uptime.lastCheckedAt ? uptime.lastCheckedAt.toISOString() : null,
				lastStatusCode: uptime.lastStatusCode,
				lastDownAt: uptime.lastDownAt ? uptime.lastDownAt.toISOString() : null,
			}
			: null,
		deployDays: days.get(`${repo.serverId}|${repo.containerName}`) ?? emptyDays(),
		// Surfaced on the Settings tab. The webhook URL is built from the public
		// site host (POWDER_SITE_HOST, else BETTER_AUTH_URL; lib/hosts.ts).
		// The token in it deploys the app: an API token caller gets a `<token>`
		// placeholder, like the context route.
		webhookUrl: publicWebhookUrl(req, user.viaToken === true ? '<token>' : repo.webhookToken),
		deployKeyPub: repo.deployKeyPub,
		syncDeploymentMd: repo.syncDeploymentMd,
		uptimeEnabled: repo.uptimeEnabled,
		healthUrl: repo.healthUrl,
		previewsEnabled: repo.previewsEnabled,
		// why previews cannot work on this app's server (no Traefik, no base domain), the
		// same reason the webhook gives when it skips one; null = they can
		previewBlockReason: previewBlockReason({
			traefik: !!server && (await isTraefikServer(server)),
			serverId: repo.serverId,
			baseDomain: server?.baseDomain ?? null,
		}),
		dockerfilePath: repo.dockerfilePath,
		containerPort: repo.containerPort,
		autoRollback: repo.autoRollback,
		// null: the install-wide settle window applies
		deploySettleSeconds: repo.deploySettleSeconds,
		crons: crons.map((c) => ({
			id: c.id,
			schedule: c.schedule,
			kind: c.kind,
			urlPath: c.urlPath,
			execCommand: redactNullable(c.execArgv?.length ? argvToDisplay(c.execArgv) : c.execCommand),
			description: c.description,
			enabled: c.enabled,
			lastRunAt: c.lastRunAt,
			lastRunStatus: c.lastRunStatus,
			nextRunAt: c.nextRunAt,
		})),
		deploys: recentDeploys.map((d) => ({
			id: d.id,
			status: d.status,
			kind: d.kind,
			queuedAt: d.queuedAt,
			startedAt: d.startedAt,
			finishedAt: d.finishedAt,
			gitSha: d.gitSha,
			builtSha: d.builtSha,
			requestedSha: d.requestedSha,
			gitBranch: d.gitBranch,
			imageTag: d.imageTag,
			// a failure: the one-line summary, the step and exit code, and the end of the log
			// (masked; lib/deploy-log-read.ts). The full log is on /deploys/<id>.
			failedStep: redactNullable(d.failedStep),
			exitCode: d.exitCode,
			errorSummary: redactNullable(d.errorSummary),
			...(d.status === 'failed'
				? failureTailFromWindows({ output: d.outputWindow, error: d.error })
				: { logTail: null, logCut: false }),
			// masked before the cut, so the 500 characters cannot hold half a secret.
			outputPreview: d.output ? safeSlice(redactSecrets(d.output), 0, 500) : null,
			// held on the settle window: when it deploys and how to skip the wait
			notBefore: d.notBefore,
			waiting: settleNote(d),
		})),
	})
}

// Settings tab: DEPLOYMENT.md sync (0051), uptime checks, health_url, preview
// deploys, the preview Dockerfile / port (0065), the automatic rollback opt-out
// (0061), the settle window (0063) and the database backups dump (has_postgres,
// backup_db_*; admin browser session only, the password stored encrypted and never
// returned). Any subset of the fields; validation in lib/app-settings.ts.
// Session-only (lib/session-only.ts): no API token changes app settings.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	const access = await requireProjectAccess(id)
	if (access instanceof Response) return access
	const body = await readJsonCapped(req, 4096).catch((e) => (e instanceof BodyTooLargeError ? e : {}))
	if (body instanceof BodyTooLargeError) return bodyTooLargeResponse()
	const v = validateAppSettings(body)
	if (!v.ok) return Response.json({ error: v.error }, { status: 400 })
	const { backupDbPassword, ...fields } = v.value
	if (BACKUP_DB_FIELDS.some((k) => k in v.value)) {
		const denied = sessionOnlyActionDenied('backup_db', access.user)
		if (denied) return denied
		const problem = backupDbProblem({
			container: 'backupDbContainer' in fields ? (fields.backupDbContainer ?? null) : access.repo.backupDbContainer,
			host: 'backupDbHost' in fields ? (fields.backupDbHost ?? null) : access.repo.backupDbHost,
			passwordSet:
				backupDbPassword !== undefined ? backupDbPassword !== null : !!access.repo.backupDbPasswordEncrypted,
		})
		if (problem) return Response.json({ error: problem }, { status: 400 })
	}
	const updated = await db
		.update(appRepos)
		.set({
			...fields,
			...(backupDbPassword !== undefined
				? { backupDbPasswordEncrypted: backupDbPassword === null ? null : encryptSecret(backupDbPassword) }
				: {}),
		})
		.where(eq(appRepos.id, id))
		.returning({
			syncDeploymentMd: appRepos.syncDeploymentMd,
			uptimeEnabled: appRepos.uptimeEnabled,
			healthUrl: appRepos.healthUrl,
			previewsEnabled: appRepos.previewsEnabled,
			dockerfilePath: appRepos.dockerfilePath,
			containerPort: appRepos.containerPort,
			autoRollback: appRepos.autoRollback,
			deploySettleSeconds: appRepos.deploySettleSeconds,
			hasPostgres: appRepos.hasPostgres,
			backupDbContainer: appRepos.backupDbContainer,
			backupDbHost: appRepos.backupDbHost,
			backupDbName: appRepos.backupDbName,
			backupDbUser: appRepos.backupDbUser,
			backupDbPasswordEncrypted: appRepos.backupDbPasswordEncrypted,
		})
	const [row] = updated
	if (!row) return Response.json({ error: 'not found' }, { status: 404 })
	const { backupDbPasswordEncrypted, ...out } = row
	return Response.json({ ok: true, ...out, backupDbPasswordSet: !!backupDbPasswordEncrypted })
}
