// import a host crontab line as a managed job SERVER-SIDE. The Crons
// tab only ever sees host lines masked; importing that masked text stored the
// mask token (a bearer header became "[redacted]"). Here powder re-reads the raw
// crontab, picks the line by its index in the matched list (the masked command
// the client saw must still match, so a crontab edit in between is caught), maps
// the RAW line and stores the job paused. The raw text never goes to the client.
import { requireContainerAccess } from '@/lib/access'
import { cronSessionOnlyDenied } from '@/lib/session-only'
import { defaultHostFor } from '@/lib/app-hosts'
import { insertCronJob } from '@/lib/cron-job-create'
import { cronTokenField } from '@/lib/cron-token-reveal'
import { matchCronsForContainer, parseCrontab } from '@/lib/crons'
import { mapHostCron, parseJobInput } from '@/lib/managed-crons'
import { redactSecrets } from '@/lib/secret-text'
import { extractHostPorts, getRootCrontab, inspectContainer } from '@/lib/ssh'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server, user } = access

	const body = (await req.json().catch(() => null)) as {
		index?: unknown
		command?: unknown
		timezone?: unknown
	} | null
	const index = body?.index
	if (typeof index !== 'number' || !Number.isInteger(index) || index < 0)
		return Response.json({ error: 'expected { index, command }' }, { status: 400 })
	if (typeof body?.command !== 'string')
		return Response.json({ error: 'expected { index, command }' }, { status: 400 })

	let hostPorts: number[] = []
	let publicHost: string | null = null
	try {
		const detail = await inspectContainer(server, name)
		hostPorts = extractHostPorts((detail.ports ?? []).join(', '))
		publicHost = defaultHostFor(server, name)
	} catch {
		// match by name only, as the list does
	}
	let crontabText: string
	try {
		crontabText = await getRootCrontab(server)
	} catch (err) {
		return Response.json(
			{ error: redactSecrets(clientErrorMessage(err, 'crontab read failed', 'servers/:id/containers/:name/crons/import')) },
			{ status: 502 },
		)
	}
	const matched = matchCronsForContainer(parseCrontab(crontabText), {
		containerName: name,
		hostPorts,
		publicHost,
	})
	const line = matched[index]
	if (!line || redactSecrets(line.command) !== body.command)
		return Response.json(
			{ error: 'the host crontab changed since the list was loaded; reload and try again' },
			{ status: 409 },
		)

	const r = mapHostCron(line.schedule, line.command, name, line.comment)
	if (!r.ok) return Response.json({ error: `can't import this line: ${r.reason}` }, { status: 400 })
	const parsed = parseJobInput({
		...r.draft,
		timezone: typeof body.timezone === 'string' ? body.timezone : r.draft.timezone,
		// Imported jobs start paused: the host line still fires until the user
		// removes it, and two schedulers running the same job is a double run.
		enabled: false,
		// The audit copy of the line is stored masked.
		importedFrom: redactSecrets(r.draft.importedFrom),
	})
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
	const denied = cronSessionOnlyDenied(parsed.job, user)
	if (denied) return denied
	const created = await insertCronJob(user.id, id, name, parsed.job)
	// the token only when newly minted, and only to an admin browser session.
	return Response.json({ id: created.id, ...cronTokenField(created.cronToken, user), warnings: r.warnings })
}
