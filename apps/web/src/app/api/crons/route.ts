// Global cron list across all the user's apps. Two sources:
//
//   - `powder` rows: cronJobs table entries that powder's scheduler manages.
//   - `host` rows: parsed from each server's root crontab: jobs that run
//     outside powder's scheduler (they can be imported as powder rows).
//
// We surface both so the page reflects "what's actually scheduled to run"
// rather than only what powder manages.

import { redactNullable } from '@/lib/secret-text'
import { excludeSelf, requireUser } from '@/lib/access'
import { appRepos, cronJobs, db, desc, inArray, sql } from '@/lib/db'
import { listAllServers, type ServerConfig } from '@/lib/servers'
import { getAllCronSources } from '@/lib/ssh'
import { argvToDisplay } from '@/lib/managed-crons'
import { CronExpressionParser } from 'cron-parser'
import { clientErrorMessage } from '@/lib/pg-error'

// Compute the next firing time of a 5- or 6-field cron expression, or null if
// it doesn't parse. We don't try to handle @hourly etc here — those were
// already translated by parseCrontabLine before this point, but cron-parser
// understands them directly too.
function nextRunFromCronExpr(expr: string, tz = 'UTC'): string | null {
	if (!expr || expr === '(no schedule)') return null
	try {
		const it = CronExpressionParser.parse(expr, { tz })
		return it.next().toDate().toISOString()
	} catch {
		return null
	}
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface CronRow {
	id: string
	source: 'powder' | 'host'
	// For host rows, the raw origin from getAllCronSources (e.g. 'user-root',
	// 'cron.d:backup', 'container:foo', 'systemd:bar.timer'). The /api/crons/logs
	// endpoint needs this to pick the right log source. Null for powder rows.
	origin: string | null
	serverId: string
	serverName: string
	containerName: string
	appRepoId: string | null
	schedule: string
	kind: 'http' | 'exec'
	urlPath: string | null
	execCommand: string | null
	description: string | null
	enabled: boolean
	nextRunAt: string | null
	lastRunAt: string | null
	lastRunStatus: string | null
	lastRunError: string | null
	lastRunHttpStatus: number | null
}

// Parse a single crontab line. Two formats:
//   - user crontab:    `MIN HR DOM MON DOW COMMAND`
//   - system crontab:  `MIN HR DOM MON DOW USER COMMAND` (in /etc/crontab + /etc/cron.d/*)
// Also handles `@daily` / `@hourly` / etc shortcuts. Skips comments, blanks, env vars.
function parseCrontabLine(
	line: string,
	hasUserField: boolean,
): { schedule: string; user: string | null; command: string } | null {
	const trimmed = line.trim()
	if (!trimmed || trimmed.startsWith('#')) return null
	if (/^[A-Z_][A-Z0-9_]*=/.test(trimmed)) return null

	// @keyword shortcuts: `@daily [user] command`
	const at = trimmed.match(/^(@(?:reboot|yearly|annually|monthly|weekly|daily|midnight|hourly))\s+(.+)$/)
	if (at) {
		const rest = (at[2] ?? '').trim()
		if (hasUserField) {
			const split = rest.match(/^(\S+)\s+(.+)$/)
			if (!split) return null
			return { schedule: at[1] ?? '', user: split[1] ?? '', command: (split[2] ?? '').trim() }
		}
		return { schedule: at[1] ?? '', user: null, command: rest }
	}

	if (hasUserField) {
		const re = trimmed.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s+(.+)$/)
		if (re) return { schedule: re[1] ?? '', user: re[2] ?? '', command: (re[3] ?? '').trim() }
	} else {
		const re = trimmed.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/)
		if (re) return { schedule: re[1] ?? '', user: null, command: (re[2] ?? '').trim() }
	}
	return null
}

// Heuristic: pull the target container name out of a docker exec/compose command.
// Examples that work:
//   docker exec foo /bin/bash -c …      → "foo"
//   docker compose -f /opt/apps/bar/docker-compose.yml run --rm cron → "bar"
//   /opt/apps/baz/cron.sh               → "baz"
function extractContainerFromCommand(cmd: string): string | null {
	const exec = cmd.match(/docker\s+exec\s+(?:-\S+\s+)*(\S+)/)
	if (exec) return exec[1] ?? null
	const compose = cmd.match(/-f\s+\/opt\/apps\/([^/\s]+)\//)
	if (compose) return compose[1] ?? null
	const path = cmd.match(/\/opt\/apps\/([^/\s]+)\//)
	if (path) return path[1] ?? null
	return null
}

// Parse a systemd timer's `systemctl cat` + show output blob into the fields
// we care about. The shell side emits one line per relevant directive, plus
// a `NextElapse=<usec>` line for the next-run epoch and `Service.<key>=<val>`
// for the linked .service unit. systemd timers don't have 5-field cron
// schedules — we surface whatever schedule directive was set.
function parseSystemdTimerBody(body: string): {
	schedule: string
	command: string | null
	description: string | null
	nextRunAt: string | null
} {
	const lines = body.split('\n').map((l) => l.trim()).filter(Boolean)
	let onCalendar: string | null = null
	let onUnitActive: string | null = null
	let onBoot: string | null = null
	let timerDesc: string | null = null
	let serviceDesc: string | null = null
	let serviceExec: string | null = null
	let nextElapse: string | null = null

	for (const line of lines) {
		const eq = line.indexOf('=')
		if (eq < 0) continue
		const k = line.slice(0, eq)
		const v = line.slice(eq + 1)
		if (k === 'OnCalendar') onCalendar = v
		else if (k === 'OnUnitActiveSec') onUnitActive = v
		else if (k === 'OnBootSec') onBoot = v
		else if (k === 'Description') timerDesc = v
		else if (k === 'NextElapse') nextElapse = v
		else if (k === 'Service.Description') serviceDesc = v
		else if (k === 'Service.ExecStart') serviceExec = v
	}

	const schedule = onCalendar
		? onCalendar
		: onUnitActive
			? `every ${onUnitActive}`
			: onBoot
				? `boot+${onBoot}`
				: '(no schedule)'
	// systemd often prefixes ExecStart with `path ; argv[...]` — strip the
	// argv[0]/argv listing that systemd appends after a `;`.
	const command = serviceExec ? (serviceExec.split(' ; ')[0] ?? '').trim() : null
	const description = serviceDesc || timerDesc
	const nextRunAt = parseSystemdEpoch(nextElapse)
	return { schedule, command, description, nextRunAt }
}

// systemctl `NextElapseUSecRealtime` is microseconds since unix epoch.
// `0` or empty = no next run scheduled.
function parseSystemdEpoch(usecStr: string | null): string | null {
	if (!usecStr) return null
	const n = Number(usecStr)
	if (!Number.isFinite(n) || n <= 0) return null
	return new Date(n / 1000).toISOString()
}

async function hostCronsForServer(server: ServerConfig): Promise<{
	rows: Omit<CronRow, 'appRepoId'>[]
	error: string | null
}> {
	let sources: Awaited<ReturnType<typeof getAllCronSources>>
	try {
		sources = await getAllCronSources(server)
	} catch (err) {
		return { rows: [], error: clientErrorMessage(err, 'crontab read failed', 'crons') }
	}
	const rows: Omit<CronRow, 'appRepoId'>[] = []
	let idx = 0
	for (const source of sources) {
		// systemd timer entries don't use cron grammar — handle as a one-off.
		if (source.origin.startsWith('systemd:')) {
			const timerName = source.origin.slice('systemd:'.length)
			const parsed = parseSystemdTimerBody(source.content)
			rows.push({
				id: `host:${server.id}:${idx}`,
				source: 'host',
				origin: source.origin,
				serverId: server.id,
				serverName: server.name,
				containerName: extractContainerFromCommand(parsed.command ?? '') ?? '(host)',
				schedule: parsed.schedule,
				kind: 'exec',
				urlPath: null,
				// Masked server-side: host crontab lines carry PGPASSWORD=, bearer tokens...
				execCommand: redactNullable(parsed.command),
				description: parsed.description
					? `systemd: ${timerName} — ${parsed.description}`
					: `systemd: ${timerName}`,
				enabled: true,
				nextRunAt: parsed.nextRunAt,
				lastRunAt: null,
				lastRunStatus: null,
				lastRunError: null,
				lastRunHttpStatus: null,
			})
			idx++
			continue
		}

		// /etc/crontab + /etc/cron.d/* have the extra USER column; user + container don't.
		const hasUserField = source.origin === 'system-etc' || source.origin.startsWith('cron.d:')
		const isContainerSource = source.origin.startsWith('container:')
		const sourceContainer = isContainerSource ? source.origin.slice('container:'.length) : null
		for (const line of source.content.split('\n')) {
			const parsed = parseCrontabLine(line, hasUserField)
			if (!parsed) continue
			const container =
				sourceContainer ?? extractContainerFromCommand(parsed.command) ?? '(host)'
			const sourceLabel =
				source.origin === 'user-root'
					? 'root crontab'
					: source.origin.startsWith('user:')
						? `${source.origin.slice('user:'.length)} crontab`
						: source.origin === 'system-etc'
							? '/etc/crontab'
							: source.origin.startsWith('container:')
								? `inside ${sourceContainer} (dcron/cron)`
								: source.origin // 'cron.d:<filename>'
			rows.push({
				id: `host:${server.id}:${idx}`,
				source: 'host',
				origin: source.origin,
				serverId: server.id,
				serverName: server.name,
				containerName: container,
				schedule: parsed.schedule,
				kind: 'exec',
				urlPath: null,
				// Masked server-side: host crontab lines carry PGPASSWORD=, bearer tokens...
				execCommand: redactNullable(parsed.command),
				description: parsed.user
					? `${sourceLabel} (as ${parsed.user})`
					: sourceLabel,
				enabled: true,
				nextRunAt: nextRunFromCronExpr(parsed.schedule),
				lastRunAt: null,
				lastRunStatus: null,
				lastRunError: null,
				lastRunHttpStatus: null,
			})
			idx++
		}
	}
	return { rows, error: null }
}

interface CronsResponse {
	crons: CronRow[]
	hostErrors: { serverId: string; serverName: string; error: string }[]
}

export async function GET() {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const user = userOrResp

	const dbRows = await db.select().from(cronJobs).orderBy(desc(cronJobs.createdAt))

	// Resolve appRepoId per (serverId, containerName) so the UI can link to
	// the project page. One query for all rows.
	const dbServerIds = [...new Set(dbRows.map((r) => r.serverId))]
	let repoByKey = new Map<string, string>()
	if (dbServerIds.length > 0) {
		const repos = await db
			.select({
				id: appRepos.id,
				serverId: appRepos.serverId,
				containerName: appRepos.containerName,
			})
			.from(appRepos)
			.where(inArray(appRepos.serverId, dbServerIds))
		repoByKey = new Map(repos.map((r) => [`${r.serverId}|${r.containerName}`, r.id]))
	}

	const servers = await listAllServers()
	const serverNameById = new Map(servers.map((s) => [s.id, s.name]))
	const visibleServerIds = new Set(servers.map((s) => s.id))

	const powderRows: CronRow[] = dbRows.map((r) => ({
		id: r.id,
		source: 'powder',
		origin: null,
		serverId: r.serverId,
		serverName: serverNameById.get(r.serverId) ?? r.serverId,
		containerName: r.containerName,
		appRepoId: repoByKey.get(`${r.serverId}|${r.containerName}`) ?? null,
		schedule: r.schedule,
		kind: r.kind as 'http' | 'exec',
		urlPath: r.urlPath,
		execCommand: redactNullable(r.execArgv?.length ? argvToDisplay(r.execArgv) : r.execCommand),
		description: r.description,
		enabled: r.enabled,
		nextRunAt: r.nextRunAt ? r.nextRunAt.toISOString() : null,
		lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
		lastRunStatus: r.lastRunStatus,
		lastRunError: redactNullable(r.lastRunError),
		lastRunHttpStatus: r.lastRunHttpStatus,
	}))

	// Fan out host crontab reads across all servers in parallel. Server failures
	// are non-fatal — surface them so the UI can show a banner instead of
	// pretending those servers have no crons.
	//
	// Filter policy: if the user can see the server (because they own at least
	// one app there), they see ALL crons on it. The previous policy filtered
	// per-(server, containerName) which dropped legitimate crons like
	// `stack-cron-1` (whose container name doesn't match any app_repo
	// row) even though the user owns that app on the same server.
	const hostResults = await Promise.all(
		servers.map(async (server) => {
			if (!visibleServerIds.has(server.id)) return { server, rows: [], error: null }
			const { rows, error } = await hostCronsForServer(server)
			return { server, rows, error }
		}),
	)
	const hostRows: CronRow[] = []
	const hostErrors: CronsResponse['hostErrors'] = []
	for (const r of hostResults) {
		if (r.error) {
			hostErrors.push({ serverId: r.server.id, serverName: r.server.name, error: r.error })
		}
		for (const row of r.rows) {
			hostRows.push({
				...row,
				appRepoId: repoByKey.get(`${row.serverId}|${row.containerName}`) ?? null,
			})
		}
	}

	// Backfill lastRunAt for host crons from cron_runs. cron-observer scrapes
	// journalctl every 5 min and records every CRON invocation. We match a host
	// cron row to a cron_runs row by (server_id, command_snippet) where the
	// snippet matches the START of the cron's execCommand (cron_runs stores at
	// most the first ~120 chars of the command).
	if (hostRows.length > 0) {
		const visibleServers = [...new Set(hostRows.map((r) => r.serverId))]
		// Latest run per (server_id, command_snippet). DISTINCT ON keeps the
		// query cheap even with many rows.
		const runs = (await db.execute(sql`
			SELECT DISTINCT ON (server_id, command_snippet)
				server_id, command_snippet, started_at
			FROM cron_runs
			WHERE server_id IN (${sql.join(visibleServers.map((s) => sql`${s}`), sql`, `)})
			  AND started_at > NOW() - INTERVAL '24 hours'
			ORDER BY server_id, command_snippet, started_at DESC
		`)) as unknown as Array<{ server_id: string; command_snippet: string; started_at: Date }>

		// Group by server for cheap prefix-match scans per host cron row.
		const runsByServer = new Map<string, Array<{ snippet: string; at: Date }>>()
		for (const r of runs) {
			const list = runsByServer.get(r.server_id) ?? []
			list.push({ snippet: r.command_snippet, at: r.started_at })
			runsByServer.set(r.server_id, list)
		}

		for (const row of hostRows) {
			if (!row.execCommand) continue
			const candidates = runsByServer.get(row.serverId) ?? []
			let best: { at: Date } | null = null
			for (const c of candidates) {
				// cron_runs.command_snippet is a prefix of the full command; the
				// cron's execCommand is the full thing. Match either direction.
				if (
					row.execCommand.startsWith(c.snippet) ||
					c.snippet.startsWith(row.execCommand.slice(0, 60))
				) {
					if (!best || c.at > best.at) best = c
				}
			}
			if (best) {
				row.lastRunAt = best.at.toISOString()
				row.lastRunStatus = 'success' // journalctl can only tell us the daemon invoked the cmd; status is observed-fired, not exit-code
			}
		}
	}

	// never a cron of powder's own container (crons/logs refuses those too).
	const out: CronRow[] = excludeSelf([...powderRows, ...hostRows], user, 'never', (r) => r.containerName || '').sort((a, b) =>
		(a.containerName || '').localeCompare(b.containerName || ''),
	)

	const body: CronsResponse = { crons: out, hostErrors }
	return Response.json(body)
}
