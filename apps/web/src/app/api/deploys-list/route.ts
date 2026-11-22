// Cross-fleet deploy stream, Vercel-style. Returns one row per deploy with
// every column the /deploys page renders: status, duration, environment
// (production vs preview based on branch vs app_repos.branch), repo slug,
// short sha, branch, time, author. Commit messages are lazy-fetched from
// GitHub for the visible window - SHAs are immutable so the lookups cache
// forever per process.
//
// Newest push first: ordered and paginated by queued_at (lib/deploy-order.ts; started_at
// is reset when the worker claims a row), the id breaking ties. Filters: ?author=, ?repo=,
// ?branch=, ?status= - all optional, combine.

import { hiddenSelfNames, requireUser } from '@/lib/access'
import { db, sql } from '@/lib/db'
import { getCommitBySha, parseGitHubRepo } from '@/lib/github-ci'
import { getGithubIntegration } from '@/lib/integrations'
import { parseListLimit } from '@/lib/list-params'
import { encodeDeployCursor, parseDeployCursor } from '@/lib/deploy-order'
import { redactNullable } from '@/lib/secret-text'
import { settleNote } from '@/lib/deploy-settle'
import { deployCommit } from '@/lib/deploy-commit'
import { authorOptions, parseTrigger, triggersMatching } from '@/lib/deploy-status'

// distinct triggered_by values read for the author dropdown and filter (one per person and
// prefix, so far more than any install has)
const MAX_TRIGGERS = 2000

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface DeployRow {
	id: string
	/** the deploy's commit (lib/deploy-commit.ts): went live, else built, else requested */
	sha: string | null
	shortSha: string | null
	/** true when `sha` is only the commit the push requested (nothing built is recorded) */
	shaRequested: boolean
	branch: string | null
	status: string
	queuedAt: string
	startedAt: string
	finishedAt: string | null
	durationMs: number | null
	containerName: string
	serverId: string
	appRepoId: string | null
	repoSlug: string | null
	defaultBranch: string | null
	environment: 'production' | 'preview' | 'unknown'
	kind: string
	triggeredBy: string | null
	author: string | null
	authorAvatarLogin: string | null
	commitMessage: string | null
	errorSummary: string | null
	/** Set while a queued push is held on the settle window (lib/deploy-settle.ts). */
	waiting: string | null
}

export async function GET(req: Request) {
	const u = await requireUser()
	if (u instanceof Response) return u

	const url = new URL(req.url)
	const limit = parseListLimit(url.searchParams.get('limit'))
	const cursor = parseDeployCursor(url.searchParams.get('cursor')) // rows older than this
	if (cursor === 'invalid')
		return Response.json({ error: 'cursor must be the nextCursor of a previous page' }, { status: 400 })
	const filterAuthor = url.searchParams.get('author') || null
	const filterRepo = url.searchParams.get('repo') || null
	const filterBranch = url.searchParams.get('branch') || null
	const filterStatus = url.searchParams.get('status') || null

	// Build the query. Admins see everything; non-admins only see deploys for
	// app_repos they own (via the FK join).
	const whereClauses: ReturnType<typeof sql>[] = []
	// powder's own deploys only to an admin session (lib/access.ts visibleRepos), never to a token.
	const hidden = hiddenSelfNames(u, 'admin-session')
	const hiddenSql =
		hidden.length > 0 ? sql`d.container_name NOT IN (${sql.join(hidden.map((n) => sql`${n}`), sql`, `)})` : null
	if (hiddenSql) whereClauses.push(hiddenSql)
	// Every stored trigger, read by the one parser (lib/deploy-status.ts parseTrigger): the
	// author dropdown is built from it, and the author filter matches the stored values the
	// parser maps to that person (every push-like prefix of a login, manual deploys by user).
	const triggerRows = (await db.execute(sql`
		SELECT DISTINCT d.triggered_by
		FROM deploys d
		WHERE d.triggered_by IS NOT NULL ${hiddenSql ? sql`AND ${hiddenSql}` : sql``}
		LIMIT ${MAX_TRIGGERS}
	`)) as unknown as Array<{ triggered_by: string | null }>
	const triggers = triggerRows.map((r) => r.triggered_by)
	if (cursor && 'micros' in cursor) {
		whereClauses.push(
			sql`(d.queued_at, d.id) < (timestamptz 'epoch' + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id})`,
		)
	} else if (cursor) {
		whereClauses.push(sql`d.queued_at < ${cursor.iso}`)
	}
	if (filterAuthor) {
		const values = triggersMatching(filterAuthor, triggers)
		whereClauses.push(
			values.length > 0 ? sql`d.triggered_by IN (${sql.join(values.map((v) => sql`${v}`), sql`, `)})` : sql`FALSE`,
		)
	}
	if (filterRepo) {
		whereClauses.push(sql`d.container_name = ${filterRepo}`)
	}
	if (filterBranch) {
		whereClauses.push(sql`d.git_branch = ${filterBranch}`)
	}
	if (filterStatus) {
		whereClauses.push(sql`d.status = ${filterStatus}`)
	}
	const whereSql =
		whereClauses.length > 0 ? sql`WHERE ${sql.join(whereClauses, sql` AND `)}` : sql``

	const rawRows = (await db.execute(sql`
		SELECT
			d.id,
			d.git_sha,
			d.built_sha,
			d.requested_sha,
			d.git_branch,
			d.status,
			d.kind,
			d.queued_at,
			(extract(epoch from d.queued_at) * 1000000)::bigint::text AS queued_us,
			d.started_at,
			d.finished_at,
			d.triggered_by,
			d.container_name,
			d.server_id,
			d.error_summary,
			d.not_before,
			a.id              AS app_repo_id,
			a.repo_url        AS repo_url,
			a.branch          AS default_branch
		FROM deploys d
		LEFT JOIN app_repos a
			ON a.container_name = d.container_name AND a.server_id = d.server_id
		${whereSql}
		ORDER BY d.queued_at DESC, d.id DESC
		LIMIT ${limit + 1}
	`)) as unknown as Array<{
		id: string
		git_sha: string | null
		built_sha: string | null
		requested_sha: string | null
		git_branch: string | null
		status: string
		kind: string
		queued_at: Date
		queued_us: string
		started_at: Date
		finished_at: Date | null
		triggered_by: string | null
		container_name: string
		server_id: string
		error_summary: string | null
		not_before: Date | string | null
		app_repo_id: string | null
		repo_url: string | null
		default_branch: string | null
	}>

	const hasMore = rawRows.length > limit
	const rows = hasMore ? rawRows.slice(0, limit) : rawRows
	const last = rows.at(-1)
	const nextCursor = hasMore && last ? encodeDeployCursor(last.queued_us, last.id) : null

	// Build base rows, defer commit message lookups.
	const out: DeployRow[] = rows.map((r) => {
		const parsedRepo = r.repo_url ? parseGitHubRepo(r.repo_url) : null
		const slug = parsedRepo ? `${parsedRepo.owner}/${parsedRepo.repo}` : null
		const env: 'production' | 'preview' | 'unknown' =
			!r.git_branch || !r.default_branch
				? 'unknown'
				: r.git_branch === r.default_branch
					? 'production'
					: 'preview'
		const startedMs = new Date(r.started_at).getTime()
		const finishedMs = r.finished_at ? new Date(r.finished_at).getTime() : null
		const durationMs = finishedMs ? finishedMs - startedMs : null
		const trigger = parseTrigger(r.triggered_by)
		const commit = deployCommit({ gitSha: r.git_sha, builtSha: r.built_sha, requestedSha: r.requested_sha })
		return {
			id: r.id,
			sha: commit?.sha ?? null,
			shortSha: commit?.short ?? null,
			shaRequested: commit?.requested ?? false,
			branch: r.git_branch,
			status: r.status,
			queuedAt: new Date(r.queued_at).toISOString(),
			startedAt: new Date(r.started_at).toISOString(),
			finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
			durationMs,
			containerName: r.container_name,
			serverId: r.server_id,
			appRepoId: r.app_repo_id,
			repoSlug: slug,
			defaultBranch: r.default_branch,
			environment: env,
			kind: r.kind,
			triggeredBy: r.triggered_by,
			author: trigger.who,
			authorAvatarLogin: trigger.how === 'push' ? trigger.who : null,
			commitMessage: null,
			// deploy text read by raw SQL goes through the read-side redactor too.
			errorSummary: redactNullable(r.error_summary),
			waiting: settleNote({ status: r.status, notBefore: r.not_before }),
		}
	})

	// Lazy commit-message fetch - best-effort, all in parallel, swallow errors.
	// Cached per-SHA forever in github-ci.ts so subsequent pages are free.
	const tokenSource = await getGithubIntegration(u.id)
	if (tokenSource) {
		await Promise.allSettled(
			out.map(async (row) => {
				if (!row.sha || !row.repoSlug) return
				const [owner, repo] = row.repoSlug.split('/')
				if (!owner || !repo) return
				const commit = await getCommitBySha(tokenSource.token, owner, repo, row.sha)
				if (commit) {
					row.commitMessage = commit.message
					row.authorAvatarLogin = row.authorAvatarLogin ?? commit.authorLogin
				}
			}),
		)
	}

	return Response.json({ deploys: out, nextCursor, authors: authorOptions(triggers) })
}
