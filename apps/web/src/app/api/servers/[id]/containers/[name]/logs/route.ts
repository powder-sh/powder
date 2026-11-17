import type { NextRequest } from 'next/server'
import { requireContainerAccess } from '@/lib/access'
import { parseLogTail } from '@/lib/log-tail'
import { getContainerLogs } from '@/lib/ssh'
import { redactSecrets } from '@/lib/secret-text'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
	req: NextRequest,
	ctx: { params: Promise<{ id: string; name: string }> },
) {
	const { id, name } = await ctx.params
	// never powder's own containers (POWDER_SELF_CONTAINER).
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access
	const { server } = access
	// a non-numeric tail was NaN; the one tail parser (1..5000, default 200)
	const tail = parseLogTail(req.nextUrl.searchParams.get('tail'))
	try {
		const logs = await getContainerLogs(server, name, tail)
		// app logs and ssh errors are masked like every deploy log (lib/secret-text.ts).
		return Response.json({ logs: redactSecrets(logs) })
	} catch (err) {
		return Response.json(
			{ error: redactSecrets(clientErrorMessage(err, 'unknown error', 'servers/:id/containers/:name/logs')) },
			{ status: 500 },
		)
	}
}
