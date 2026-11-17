import { requireContainerAccess } from '@/lib/access'
import { cronSessionOnlyDenied } from '@/lib/session-only'
import { redactSecrets } from '@/lib/secret-text'
import { insertCronJob } from '@/lib/cron-job-create'
import { appCronTokenSet } from '@/lib/cron-scheduler'
import { cronTokenField } from '@/lib/cron-token-reveal'
import { defaultHostFor } from '@/lib/app-hosts'
import { matchCronsForContainer, parseCrontab } from '@/lib/crons'
import { and, cronJobRuns, cronJobs, db, desc, eq, inArray } from '@/lib/db'
import type { CronJobRun } from '@/lib/db'
import { serializeJob } from '@/lib/cron-job-view'
import { parseJobInput } from '@/lib/managed-crons'
import { extractHostPorts, getRootCrontab, inspectContainer } from '@/lib/ssh'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Runs returned per job on the Crons tab.
const RUNS_PER_JOB = 10

// ?part=managed answers from the DB only (fast); ?part=host only reads the host
// crontab over SSH (slow). No part: both, as before.
export async function GET(req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server } = access
	const part = new URL(req.url).searchParams.get('part')
	if (part === 'managed') {
		return Response.json({
			managedJobs: await managedJobsFor(id, name),
			cronTokenSet: await appCronTokenSet(id, name),
		})
	}

	let hostPorts: number[] = []
	let publicHost: string | null = null
	try {
		const detail = await inspectContainer(server, name)
		hostPorts = extractHostPorts((detail.ports ?? []).join(', '))
		// Traefik apps live at Host(<name>.<servers.base_domain>). Cheap inference
		// for the common case; doesn't try to read the compose file.
		publicHost = defaultHostFor(server, name)
	} catch {
		// no detail — still try to match by name only
	}

	let hostError: string | null = null
	let crontabText = ''
	try {
		crontabText = await getRootCrontab(server)
	} catch (err) {
		// ssh / shell error text can carry secrets
		hostError = redactSecrets(clientErrorMessage(err, 'crontab read failed', 'servers/:id/containers/:name/crons'))
	}
	const all = parseCrontab(crontabText)
	const matchedHost = matchCronsForContainer(all, {
		containerName: name,
		hostPorts,
		publicHost,
	})

	const host = {
		// Host crontab lines can carry PGPASSWORD=, bearer tokens...: masked.
		hostJobs: matchedHost.map((h) => ({ ...h, command: redactSecrets(h.command) })),
		hostError,
		totalLinesInCrontab: all.length,
	}
	if (part === 'host') return Response.json(host)

	return Response.json({
		...host,
		managedJobs: await managedJobsFor(id, name),
		// only whether the app has a cron token, never the token
		cronTokenSet: await appCronTokenSet(id, name),
	})
}

async function managedJobsFor(id: string, name: string) {
	const managed = await db
		.select()
		.from(cronJobs)
		.where(and(eq(cronJobs.serverId, id), eq(cronJobs.containerName, name)))
		.orderBy(desc(cronJobs.createdAt))

	const runsByJob = new Map<string, CronJobRun[]>()
	if (managed.length > 0) {
		const runs = await db
			.select()
			.from(cronJobRuns)
			.where(
				inArray(
					cronJobRuns.cronJobId,
					managed.map((m) => m.id),
				),
			)
			.orderBy(desc(cronJobRuns.startedAt))
		for (const r of runs) {
			const list = runsByJob.get(r.cronJobId) ?? []
			if (list.length < RUNS_PER_JOB) list.push(r)
			runsByJob.set(r.cronJobId, list)
		}
	}
	return managed.map((m) => serializeJob(m, runsByJob.get(m.id) ?? []))
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { user } = access

	const parsed = parseJobInput(await req.json().catch(() => null))
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
	// exec crons and a non-default bearer env var need an admin browser session
	const denied = cronSessionOnlyDenied(parsed.job, user)
	if (denied) return denied
	const created = await insertCronJob(user.id, id, name, parsed.job)
	// the token only when newly minted, and only to an admin browser session.
	return Response.json({ id: created.id, ...cronTokenField(created.cronToken, user) })
}
