import { requireContainerAccess } from '@/lib/access'
import { isTraefikServer } from '@/lib/traefik-servers'
import { and, appTrafficStats, db, eq, gte } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_DAYS = 30

export async function GET(req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
	const { id, name } = await ctx.params
	const access = await requireContainerAccess(id, name)
	if (access instanceof Response) return access

	if (!(await isTraefikServer(id))) {
		return Response.json({ supported: false, days: 0, totalRequests: 0, totalBytes: 0, buckets: [] })
	}

	const url = new URL(req.url)
	const daysParam = Number(url.searchParams.get('days') ?? '7')
	const days = Math.min(MAX_DAYS, Math.max(1, Number.isFinite(daysParam) ? daysParam : 7))
	const since = new Date(Date.now() - days * 24 * 60 * 60_000)

	const rows = await db
		.select()
		.from(appTrafficStats)
		.where(
			and(
				eq(appTrafficStats.serverId, id),
				eq(appTrafficStats.containerName, name),
				gte(appTrafficStats.hourBucket, since),
			),
		)

	rows.sort((a, b) => a.hourBucket.getTime() - b.hourBucket.getTime())

	let totalRequests = 0
	let totalBytes = 0
	for (const r of rows) {
		totalRequests += r.requests
		totalBytes += r.bytesOut
	}

	return Response.json({
		supported: true,
		days,
		totalRequests,
		totalBytes,
		buckets: rows.map((r) => ({
			t: r.hourBucket.toISOString(),
			req: r.requests,
			bytes: r.bytesOut,
			s2: r.status2xx,
			s3: r.status3xx,
			s4: r.status4xx,
			s5: r.status5xx,
		})),
	})
}
