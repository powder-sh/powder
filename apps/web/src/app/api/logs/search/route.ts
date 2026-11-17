// Cross-deploy full-text-ish search over deploys.output + deploys.error.
// Uses Postgres ILIKE (no FTS index in v1, fine for ~hundreds of deploys
// per app; switch to tsvector + GIN when search latency becomes an issue).
//
// Filters by ownership: results are restricted to deploys for app_repos the
// current user owns. Admins see everything.

import { requireUser, visibleRepos } from '@/lib/access'
import { and, db, deploys, desc, eq, or, sql } from '@/lib/db'
import { LOG_SEARCH_LIMIT, LOG_SEARCH_TIMEOUT_MS, parseSinceDays } from '@/lib/list-params'
import { redactNullable } from '@/lib/secret-text'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const user = userOrResp

	const url = new URL(req.url)
	const q = (url.searchParams.get('q') ?? '').trim()
	const status = url.searchParams.get('status') ?? '' // '', 'success', 'failed', 'running'
	const app = (url.searchParams.get('app') ?? '').trim()
	const serverId = (url.searchParams.get('serverId') ?? '').trim()
	const sinceDays = parseSinceDays(url.searchParams.get('sinceDays'))

	if (q.length < 2) return Response.json({ results: [], hint: 'enter at least 2 characters' })

	// the deploy history of powder's own row only to an admin session, as on its
	// project page; never to a token.
	const repos = await visibleRepos(user, 'admin-session')
	if (repos.length === 0) return Response.json({ results: [] })

	const sinceDate = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
	// Escape ILIKE wildcards in user input (% and _).
	const safe = q.replace(/[\\%_]/g, (m) => `\\${m}`)
	const pattern = `%${safe}%`

	// build (serverId, containerName) ownership filter
	const ownership = or(
		...repos.map((r) =>
			and(eq(deploys.serverId, r.serverId), eq(deploys.containerName, r.containerName)),
		),
	)
	const filters = [
		ownership,
		or(sql`${deploys.output} ILIKE ${pattern}`, sql`${deploys.error} ILIKE ${pattern}`),
		sql`${deploys.startedAt} >= ${sinceDate}`,
	]
	if (app) filters.push(eq(deploys.containerName, app))
	if (serverId) filters.push(eq(deploys.serverId, serverId))
	if (status === 'success' || status === 'failed' || status === 'running') {
		filters.push(eq(deploys.status, status))
	}

	// an ILIKE over every deploy's output is a sequential scan; bound its
	// time (SET LOCAL lasts only for this transaction) as well as its rows.
	let rows: Awaited<ReturnType<typeof searchRows>>
	try {
		rows = await db.transaction(async (tx) => {
			await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${LOG_SEARCH_TIMEOUT_MS}`))
			return searchRows(tx, filters)
		})
	} catch (err) {
		if (
			/statement timeout|canceling statement/i.test(
				err instanceof Error ? `${err.message} ${String(err.cause)}` : String(err),
			)
		)
			return Response.json(
				{ error: 'search took too long; narrow it (app, server, status or fewer days)' },
				{ status: 503 },
			)
		throw err
	}

	// the SQL matches the RAW text, so a row whose match lies only inside a
	// secret has no snippet in the masked text. Listing it would confirm the guess
	// (a search oracle for secret values): such rows are dropped.
	const results = rows.flatMap((r) => {
		// the snippet is cut from the masked text (a search for a secret's
		// prefix finds the [redacted] marker, never the value).
		const fromError = extractSnippet(redactNullable(r.error), q)
		const fromOutput = extractSnippet(redactNullable(r.output), q)
		const snippet = fromError ?? fromOutput
		if (!snippet) return []
		return {
			id: r.id,
			serverId: r.serverId,
			containerName: r.containerName,
			kind: r.kind,
			status: r.status,
			startedAt: r.startedAt,
			gitSha: r.gitSha,
			gitBranch: r.gitBranch,
			snippet,
			snippetSource: fromError ? 'error' : 'output',
		}
	})

	return Response.json({ results, query: q })
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

function searchRows(tx: Tx, filters: Parameters<typeof and>) {
	return tx
		.select({
			id: deploys.id,
			serverId: deploys.serverId,
			containerName: deploys.containerName,
			kind: deploys.kind,
			status: deploys.status,
			startedAt: deploys.startedAt,
			gitSha: deploys.gitSha,
			gitBranch: deploys.gitBranch,
			output: deploys.output,
			error: deploys.error,
		})
		.from(deploys)
		.where(and(...filters))
		.orderBy(desc(deploys.startedAt))
		.limit(LOG_SEARCH_LIMIT)
}

function extractSnippet(text: string | null, q: string, ctx = 100): string | null {
	if (!text) return null
	const lower = text.toLowerCase()
	const idx = lower.indexOf(q.toLowerCase())
	if (idx === -1) return null
	const start = Math.max(0, idx - ctx)
	const end = Math.min(text.length, idx + q.length + ctx)
	return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '')
}
