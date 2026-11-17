import { requireContainerAccess } from '@/lib/access'
import { cronSessionOnlyDenied } from '@/lib/session-only'
import { and, cronJobRuns, cronJobs, db, eq } from '@/lib/db'
import { computeNextRun, parseJobInput } from '@/lib/managed-crons'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function loadOwnedJob(id: string, name: string, cronId: string) {
	const [job] = await db.select().from(cronJobs).where(eq(cronJobs.id, cronId))
	if (!job) return Response.json({ error: 'unknown cron' }, { status: 404 })
	if (job.serverId !== id || job.containerName !== name) {
		return Response.json({ error: 'cron does not belong to this container' }, { status: 400 })
	}
	return job
}

export async function DELETE(
	_req: Request,
	ctx: { params: Promise<{ id: string; name: string; cronId: string }> },
) {
	const { id, name, cronId } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access

	const job = await loadOwnedJob(id, name, cronId)
	if (job instanceof Response) return job
	await db.delete(cronJobs).where(eq(cronJobs.id, cronId))
	await db.delete(cronJobRuns).where(eq(cronJobRuns.cronJobId, cronId))
	return Response.json({ ok: true })
}

// Two shapes: { enabled } pauses/resumes; a full job body (as POST) edits.
export async function PATCH(
	req: Request,
	ctx: { params: Promise<{ id: string; name: string; cronId: string }> },
) {
	const { id, name, cronId } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access

	const job = await loadOwnedJob(id, name, cronId)
	if (job instanceof Response) return job

	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
	if (!body || typeof body !== 'object') {
		return Response.json({ error: 'expected a JSON object' }, { status: 400 })
	}

	const where = and(
		eq(cronJobs.id, cronId),
		eq(cronJobs.serverId, id),
		eq(cronJobs.containerName, name),
	)

	if (Object.keys(body).length === 1 && 'enabled' in body) {
		if (typeof body.enabled !== 'boolean') {
			return Response.json({ error: 'expected { enabled: boolean }' }, { status: 400 })
		}
		// resuming an exec cron (or one with a non-default bearer env var)
		// schedules it again: admin session only
		if (body.enabled) {
			const denied = cronSessionOnlyDenied(job, access.user)
			if (denied) return denied
		}
		// Resuming recomputes the next firing from now, so a job paused for a day
		// does not fire a missed run the moment it is resumed.
		await db
			.update(cronJobs)
			.set({
				enabled: body.enabled,
				nextRunAt: body.enabled
					? computeNextRun(job.schedule, new Date(), job.timezone)
					: job.nextRunAt,
			})
			.where(where)
		return Response.json({ ok: true })
	}

	const parsed = parseJobInput(body)
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
	const denied = cronSessionOnlyDenied(parsed.job, access.user)
	if (denied) return denied
	const j = parsed.job
	await db
		.update(cronJobs)
		.set({
			schedule: j.schedule,
			timezone: j.timezone,
			kind: j.kind,
			httpMethod: j.httpMethod,
			urlPath: j.urlPath,
			bearerEnvVar: j.bearerEnvVar,
			// An edit always stores argv; an sh -c string (execCommand) is dropped.
			execCommand: null,
			execArgv: j.execArgv,
			timeoutSeconds: j.timeoutSeconds,
			description: j.description,
			enabled: j.enabled,
			nextRunAt: j.enabled ? computeNextRun(j.schedule, new Date(), j.timezone) : null,
		})
		.where(where)
	return Response.json({ ok: true })
}
