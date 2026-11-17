// Automatic rollback preflight for an ops hub (admin bearer, read-only).
//
//   GET /api/internal/auto-rollback?deploy=<deployId>
//
// The hub decided a deploy made its app worse; this answers whether powder allows undoing it
// without a human, and to which deploy. It changes nothing: the hub then calls the existing
// POST /api/servers/{serverId}/containers/{name}/rollback {targetDeployId} (same path as the
// Roll back button), so the rollback itself is the one powder already runs and health-gates.
// The rules live in lib/auto-rollback.ts. Reads the app's git diff and image list over SSH.

import { requireUser } from '@/lib/access'
import { and, appRepos, db, deploys, desc, eq, sql } from '@/lib/db'
import { heldSql } from '@/lib/deploy-settle'
import {
	type Blocker,
	classifyMigrations,
	type DeployRow,
	newPreflightNonce,
	parsePreflightOutput,
	preflightScript,
	pickRollbackTarget,
	previousGitDeploy,
	SHA_RE,
	staticBlockers,
} from '@/lib/auto-rollback'
import { clientErrorMessage } from '@/lib/pg-error'
import { getServer } from '@/lib/servers'
import { inspectContainer, runCommand } from '@/lib/ssh'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	if (!userOrResp.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 })

	const deployId = new URL(req.url).searchParams.get('deploy')?.trim()
	if (!deployId) return Response.json({ error: 'deploy required' }, { status: 400 })

	const [bad] = await db
		.select({
			id: deploys.id,
			serverId: deploys.serverId,
			containerName: deploys.containerName,
			kind: deploys.kind,
			status: deploys.status,
			startedAt: deploys.startedAt,
			queuedAt: deploys.queuedAt,
			finishedAt: deploys.finishedAt,
			gitSha: deploys.gitSha,
			imageTag: deploys.imageTag,
		})
		.from(deploys)
		.where(eq(deploys.id, deployId))
	if (!bad) return Response.json({ error: 'not found' }, { status: 404 })

	const historyRows = await db
		.select({
			id: deploys.id,
			kind: deploys.kind,
			status: deploys.status,
			startedAt: deploys.startedAt,
			queuedAt: deploys.queuedAt,
			finishedAt: deploys.finishedAt,
			gitSha: deploys.gitSha,
			imageTag: deploys.imageTag,
			// the one definition of a held push (lib/deploy-settle.ts)
			held: sql<boolean>`${sql.raw(heldSql('"deploys"'))}`,
		})
		.from(deploys)
		.where(and(eq(deploys.serverId, bad.serverId), eq(deploys.containerName, bad.containerName)))
		.orderBy(desc(deploys.startedAt))
		.limit(60)
	const history: DeployRow[] = historyRows.map((d) => ({
		...d,
		kind: String(d.kind),
		status: String(d.status),
	}))
	const deploy: DeployRow = {
		id: bad.id,
		kind: String(bad.kind),
		status: String(bad.status),
		startedAt: bad.startedAt,
		queuedAt: bad.queuedAt,
		finishedAt: bad.finishedAt,
		gitSha: bad.gitSha,
		imageTag: bad.imageTag,
	}

	const [repo] = await db
		.select({ id: appRepos.id, autoRollback: appRepos.autoRollback })
		.from(appRepos)
		.where(and(eq(appRepos.serverId, bad.serverId), eq(appRepos.containerName, bad.containerName)))

	const blockers: Blocker[] = staticBlockers({
		deploy,
		containerName: bad.containerName,
		autoRollback: repo ? repo.autoRollback : null,
		history,
		now: new Date(),
	})
	// The same container name on another server: the hub keys apps by name, so it cannot be
	// sure which server its errors came from.
	const sameName = await db
		.select({ serverId: appRepos.serverId })
		.from(appRepos)
		.where(eq(appRepos.containerName, bad.containerName))
	if (sameName.length > 1) blockers.push('ambiguous')
	const target = pickRollbackTarget(deploy, history)
	const previous = previousGitDeploy(deploy, history)

	// SSH checks only when nothing cheaper already said no. Fail closed: the answer is
	// 'diff-unknown' until the diff and image were actually read.
	let migration: { touched: string[]; reversible: boolean; why: string | null } | null = null
	let diffError: string | null = null
	let changedFiles = 0
	if (blockers.length === 0) {
		const from = target?.gitSha ?? ''
		const to = deploy.gitSha ?? ''
		if (!target?.imageTag || !SHA_RE.test(from) || !SHA_RE.test(to)) {
			blockers.push('diff-unknown')
			diffError = 'no commit range to read'
		} else {
			try {
				const server = await getServer(bad.serverId)
				if (!server) throw new Error('server not found')
				const detail = await inspectContainer(server, bad.containerName)
				const wd =
					detail.compose.workingDir || detail.compose.configFile?.replace(/\/[^/]*$/, '') || ''
				if (!wd) throw new Error('container has no compose working dir')
				const nonce = newPreflightNonce()
				const script = preflightScript({ workingDir: wd, from, to, imageTag: target.imageTag, nonce })
				const res = await runCommand(server, script, 30_000)
				const parsed = parsePreflightOutput(res.stdout, nonce)
				if ('error' in parsed)
					throw new Error(parsed.error === 'no-workdir' ? `no working dir ${wd}` : parsed.error)
				if (!parsed.imageOk) blockers.push('image-missing')
				const { entries, addedSql, codeDdl } = parsed
				changedFiles = entries.length
				migration = classifyMigrations(entries, addedSql)
				if (migration.reversible && codeDdl > 0)
					migration = {
						...migration,
						reversible: false,
						why: `${codeDdl} added line(s) of destructive DDL in code`,
					}
				if (!migration.reversible) blockers.push('migration')
			} catch (err) {
				blockers.push('diff-unknown')
				diffError = clientErrorMessage(err, 'diff unreadable', 'auto-rollback')
			}
		}
	}

	return Response.json({
		eligible: blockers.length === 0,
		blockers,
		deploy: {
			id: bad.id,
			serverId: bad.serverId,
			containerName: bad.containerName,
			kind: bad.kind,
			status: bad.status,
			gitSha: bad.gitSha,
			finishedAt: bad.finishedAt?.toISOString() ?? null,
		},
		target: target
			? { id: target.id, gitSha: target.gitSha, imageTag: target.imageTag, kind: target.kind }
			: null,
		previousGitDeployId: previous?.id ?? null,
		autoRollback: repo ? repo.autoRollback : null,
		diff:
			target?.gitSha && bad.gitSha
				? { from: target.gitSha, to: bad.gitSha, files: changedFiles }
				: null,
		migration,
		diffError,
	})
}
