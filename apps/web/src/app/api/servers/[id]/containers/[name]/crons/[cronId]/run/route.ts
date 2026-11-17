import { after } from 'next/server'
import { requireContainerAccess } from '@/lib/access'
import { cronSessionOnlyDenied } from '@/lib/session-only'
import { runJobNow } from '@/lib/cron-scheduler'
import { cronJobs, db, eq } from '@/lib/db'
import { canStartRun } from '@/lib/managed-crons'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// "Run now". Starts the run after the response (a job may take up to its
// timeout, longer than a proxy waits), so the Crons tab polls for the result.
// Same overlap guard as the scheduler: runJob re-checks it atomically.
export async function POST(
	_req: Request,
	ctx: { params: Promise<{ id: string; name: string; cronId: string }> },
) {
	const { id, name, cronId } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access

	const [job] = await db.select().from(cronJobs).where(eq(cronJobs.id, cronId))
	if (!job || job.serverId !== id || job.containerName !== name) {
		return Response.json({ error: 'unknown cron' }, { status: 404 })
	}
	const denied = cronSessionOnlyDenied(job, access.user)
	if (denied) return denied
	if (!canStartRun(job.runningSince, new Date(), job.timeoutSeconds)) {
		return Response.json({ error: 'previous run still running' }, { status: 409 })
	}
	after(() =>
		runJobNow(cronId).catch((err) => console.error(`[cron ${cronId}] manual run failed:`, err)),
	)
	return Response.json({ started: true }, { status: 202 })
}
