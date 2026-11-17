import { requireServerForUser, requireUser } from '@/lib/access'
import { readJsonCapped } from '@/lib/http-limits'
import type { StepId } from '@/lib/server-bootstrap'
import { runBootstrapApply, runBootstrapCheck } from '@/lib/server-bootstrap-run'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// apply may install Docker (apt repository, minutes).
export const maxDuration = 900

const STEP_IDS: readonly StepId[] = [
	'install-docker',
	'network-web',
	'network-internal',
	'mkdir-apps',
	'mkdir-dynamic',
	'start-traefik',
	'install-powder-migrate',
	'install-powder-image-prune',
	'replace-powder-migrate',
	'replace-powder-image-prune',
	'install-image-prune-cron',
	'install-traefik-logrotate',
]

// POST { mode: 'check' } (default, read-only) or { mode: 'apply', steps: [...] }.
// apply re-checks on the server and runs only planned steps listed in `steps`,
// which the dashboard sends from the plan it showed in the confirm dialog. An
// outdated helper is planned as replace-<bin>, so it is only overwritten when
// that id is in `steps` (the dialog leaves it unticked); install-<bin> never
// matches it.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	// Root SSH on the server: admin only, like registering a server.
	if (!userOrResp.isAdmin) return Response.json({ error: 'forbidden' }, { status: 403 })
	const server = await requireServerForUser(id)
	if (server instanceof Response) return server

	const body = (await readJsonCapped(req, 16 * 1024).catch(() => null)) as {
		mode?: unknown
		steps?: unknown
	} | null
	const mode = body?.mode ?? 'check'
	if (mode !== 'check' && mode !== 'apply') {
		return Response.json({ error: 'mode must be check or apply' }, { status: 400 })
	}

	try {
		if (mode === 'check') return Response.json({ check: await runBootstrapCheck(server) })
		const steps = Array.isArray(body?.steps)
			? body.steps.filter((s): s is StepId => STEP_IDS.includes(s as StepId))
			: []
		if (steps.length === 0) {
			return Response.json({ error: 'no steps confirmed' }, { status: 400 })
		}
		const { steps: results, after } = await runBootstrapApply(server, steps)
		return Response.json({ steps: results, check: after })
	} catch (err) {
		return Response.json(
			{ error: clientErrorMessage(err, 'ssh failed', 'servers/:id/bootstrap') },
			{ status: 502 },
		)
	}
}
