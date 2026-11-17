// Recent activity / logs for a single cron row. The /crons page calls this
// when a row is expanded — keeping the heavy SSH+journalctl work off the main
// list endpoint.
//
// Three flavours, dispatched on `origin`:
//   - systemd:<unit>.timer  → `journalctl -u <unit>.service --since 7d`
//   - container:<name>      → `docker logs` + dcron file fallback
//   - everything else (root/user/system/cron.d crontab) → syslog CRON entries
//     filtered by a command fragment

import { isManagedContainer, requireServerForUser, requireUser } from '@/lib/access'
import { composeProjectNameFor } from '@/lib/compose-safety'
import { managedContainerNames } from '@/lib/managed-containers'
import { isPowderSelfContainer, powderSelfDenied } from '@/lib/secret-mask'
import { redactSecrets } from '@/lib/secret-text'
import { getServer } from '@/lib/servers'
import { runCommand } from '@/lib/ssh'
import { shq } from '@/lib/shell'
import { grepNeedle } from '@/lib/cron-needle'
import { timerListed } from '@/lib/cron-timers'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
	serverId: string
	origin: string // 'user-root' | 'user:<u>' | 'system-etc' | 'cron.d:<f>' | 'container:<c>' | 'systemd:<t>.timer'
	command: string | null
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export async function POST(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp

	let body: Body
	try {
		body = (await req.json()) as Body
	} catch {
		return Response.json({ error: 'invalid body' }, { status: 400 })
	}
	if (!body.serverId || !body.origin) {
		return Response.json({ error: 'serverId + origin required' }, { status: 400 })
	}

	const serverCheck = await requireServerForUser(body.serverId)
	if (serverCheck instanceof Response) return serverCheck
	const server = await getServer(body.serverId)
	if (!server) return Response.json({ error: 'unknown server' }, { status: 404 })

	const origin = body.origin
	let cmd: string
	let label: string

	if (origin.startsWith('systemd:')) {
		const timer = origin.slice('systemd:'.length)
		if (!/^[A-Za-z0-9@._-]+\.timer$/.test(timer)) {
			return Response.json({ error: 'invalid timer name' }, { status: 400 })
		}
		// only a timer that exists on the server (fail closed). Without this the name
		// picked any unit's journal (`systemd:ssh.timer` read ssh.service's log).
		if (!(await timerExists(server, timer))) return Response.json({ error: 'unknown timer' }, { status: 404 })
		const service = `${timer.slice(0, -'.timer'.length)}.service`
		label = `journalctl -u ${service}`
		cmd = [
			`echo '=== timer state ==='`,
			`systemctl show ${shq(timer)} --property=LastTriggerUSec,NextElapseUSecRealtime,Result --no-pager 2>/dev/null`,
			'echo',
			`echo '=== service state ==='`,
			`systemctl show ${shq(service)} --property=ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp --no-pager 2>/dev/null`,
			'echo',
			`echo '=== journal (last 7d) ==='`,
			`journalctl -u ${shq(service)} --no-pager --since '7 days ago' --lines=80 2>/dev/null || echo '(no journal entries)'`,
		].join('\n')
	} else if (origin.startsWith('container:')) {
		const container = origin.slice('container:'.length)
		if (!SAFE_NAME.test(container)) {
			return Response.json({ error: 'invalid container name' }, { status: 400 })
		}
		// never powder's own containers, and only a container of a powder app
		// (the app itself, a preview, or a service in a managed app's compose project,
		// e.g. its cron sidecar). Same 404 for every refusal.
		const self = powderSelfDenied(container)
		if (self) return self
		if (!(await cronContainerAllowed(server, container)))
			return Response.json({ error: 'unknown container' }, { status: 404 })
		label = `docker logs ${container}`
		// dcron typically writes to stderr (visible in docker logs) but some apps
		// route cron output to a file inside the container. Show both when present.
		cmd = [
			`echo '=== docker logs (last 7d, tail 60) ==='`,
			`docker logs --since 168h --tail 60 ${shq(container)} 2>&1 || echo '(no docker logs)'`,
			'echo',
			`echo '=== internal cron log (if any) ==='`,
			`docker exec ${shq(container)} sh -c 'tail -n 80 /var/log/cron.log 2>/dev/null || tail -n 80 /var/log/crond.log 2>/dev/null || echo "(no internal log file)"' 2>/dev/null || true`,
		].join('\n')
	} else if (
		origin === 'user-root' ||
		origin === 'system-etc' ||
		origin.startsWith('user:') ||
		origin.startsWith('cron.d:')
	) {
		const needle = body.command ? grepNeedle(body.command) : ''
		label = 'journalctl CRON'
		// Standard cron logs every fire as syslog tag CRON. ``journalctl -t CRON``
		// pulls them. If the user-supplied command gives us a usable substring we
		// filter to relevant lines; otherwise we return the recent CRON tail so
		// at least the user sees what's happening on the server.
		const filter = needle.length >= 6 ? `| grep -F -- ${shq(needle)}` : ''
		cmd = [
			`echo '=== syslog/journal CRON (last 7d) ==='`,
			// only entries the cron daemon sent (a container logging through the
			// journald driver with tag CRON carries _COMM=dockerd).
			`CJ=$( ( journalctl --no-pager --since '7 days ago' -t CRON _COMM=cron _COMM=CRON 2>/dev/null ${filter} | tail -60 ) || true); [ -n "$CJ" ] && printf '%s\\n' "$CJ"`,
			'echo',
			// the syslog file only when the journal has nothing for the job (no
			// journald, or cron logging only to syslog), and only lines whose syslog tag is
			// the cron daemon's (`CRON[pid]:`), not any line that says CRON.
			`if [ -z "$CJ" ]; then echo '=== /var/log/syslog CRON lines (nothing in the journal) ==='; ( grep -E ' CRON\\[[0-9]+\\]: ' /var/log/syslog 2>/dev/null ${filter} | tail -40 ) || echo '(no syslog file)'; fi`,
		].join('\n')
	} else {
		return Response.json({ error: `unknown origin: ${origin}` }, { status: 400 })
	}

	try {
		const { stdout, stderr, code } = await runCommand(server, cmd, 15_000)
		// cron output carries whatever the job printed; mask secrets like every log.
		const out = redactSecrets((stdout + (stderr ? `\n${stderr}` : '')).trimEnd())
		return Response.json({
			source: label,
			logs: out || '(no output)',
			code,
		})
	} catch (err) {
		return Response.json(
			{
				source: label,
				logs: redactSecrets(`error reading logs: ${clientErrorMessage(err, String(err), 'crons/logs')}`),
				code: -1,
			},
			{ status: 200 },
		)
	}
}

/** a `container:` cron origin may only read a powder app's container (app_repos
 *  or preview), or a container in the compose project of one (its cron sidecar), never
 *  powder's own project. */
async function cronContainerAllowed(
	server: NonNullable<Awaited<ReturnType<typeof getServer>>>,
	container: string,
): Promise<boolean> {
	if (await isManagedContainer(server.id, container)) return true
	const r = await runCommand(
		server,
		`docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' ${shq(container)} 2>/dev/null`,
		8_000,
	).catch(() => null)
	const project = r && r.code === 0 ? r.stdout.trim() : ''
	if (!project) return false
	if (['powder', 'powder-worker'].some((n) => composeProjectNameFor(n) === project)) return false
	const apps = await managedContainerNames(server.id)
	return apps.some((n) => !isPowderSelfContainer(n) && composeProjectNameFor(n) === project)
}

/** the timer must be one `systemctl list-timers --all` lists. Any error,
 *  timeout or empty list is false (fail closed). */
async function timerExists(
	server: NonNullable<Awaited<ReturnType<typeof getServer>>>,
	timer: string,
): Promise<boolean> {
	const r = await runCommand(server, 'systemctl list-timers --all --no-legend --no-pager 2>/dev/null', 8_000).catch(() => null)
	return !!r && r.code === 0 && timerListed(r.stdout, timer)
}
