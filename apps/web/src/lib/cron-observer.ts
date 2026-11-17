// Scrapes each managed server's `journalctl -t CRON` output every 5 minutes
// and inserts one cron_runs row per discovered firing. Activity feed UNIONs
// these in so cron firings finally show up on /activity.
//
// Most of the cron_jobs rows are `enabled = false` and represent crons that
// actually run from host crontabs (parsed by /api/crons for display). The
// in-process scheduler doesn't fire them, so cron_jobs.last_run_at stays NULL.
// This observer is the bridge: we don't try to *run* the host crons, we just
// notice when they fired and record it.
//
// We do NOT attempt per-row matching against cron_jobs (the command strings
// often differ in whitespace / quoting between crontab and journal). Activity
// feed shows the raw `commandSnippet` instead.

import { createId, cronRuns, db, prefixes } from './db'
import { redactSecrets } from './secret-text'
import { type ServerConfig, listAllServers } from './servers'
import { runCommand } from './ssh'

// Conservative window. Tick runs every 5 min, so 10 min gives 2× overlap; the
// UNIQUE constraint dedupes overlaps cheaply.
const LOOKBACK_MINUTES = 10

// journalctl with -o short-iso emits lines like:
//   2026-05-14T18:00:01+0000 hostname CRON[12345]: (root) CMD (/usr/bin/foo)
// We parse the timestamp + the CMD body. The `(root)` user marker is the
// reliable anchor that distinguishes a CMD-fire line from a session start /
// pam_unix line that also tags as CRON.
const CRON_LINE = /^(\S+)\s+\S+\s+CRON\[\d+\]:\s*\(\S+\)\s+CMD\s+\((.+)\)\s*$/

// Trim the command down to something usable as the dedup key + display value.
// Drop leading env-var sets, `cd … &&`, and any closing redirection so the
// same logical cron isn't deduped on shell ornamentation.
// Masks the FULL command first, then cuts: cutting first could leave a token
// fragment shorter than any rule's minimum, stored raw.
export function snippetFor(cmd: string): string {
	let s = redactSecrets(cmd).trim()
	s = s.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, '')
	s = s.replace(/^cd\s+\S+\s*&&\s*/, '')
	s = s.replace(/\s*[>&]\s*\S+(\s+2>&1)?\s*$/, '')
	return s.slice(0, 240)
}

// Figure out which app a host cron targets. Four signal types, in order of
// reliability:
//   1. `docker exec <name>` — name is right there.
//   2. `/opt/apps/<name>/` path — convention for compose dirs.
//   3. localhost-port curls (`http://127.0.0.1:<port>` / `http://localhost:<port>`) —
//      requires a port→container map fetched from `docker ps` per-server.
//   4. Anything else → '(host)' (logrotate, backup.sh, etc). Those won't match
//      any app_repo so they're filtered from /activity, which is correct.
function containerForCommand(cmd: string, portMap: Map<string, string>): string {
	const exec = cmd.match(/docker\s+exec\s+(?:-\S+\s+)*(\S+)/)
	if (exec?.[1]) return exec[1]
	const compose = cmd.match(/-f\s+\/opt\/apps\/([^/\s]+)\//)
	if (compose?.[1]) return compose[1]
	const path = cmd.match(/\/opt\/apps\/([^/\s]+)\//)
	if (path?.[1]) return path[1]
	const port = cmd.match(/(?:127\.0\.0\.1|localhost):(\d+)/)
	if (port?.[1]) {
		const c = portMap.get(port[1])
		if (c) return c
	}
	return '(host)'
}

// Build a port → container-name map by parsing `docker ps`. The Ports field
// looks like: `0.0.0.0:3006->3000/tcp, :::3006->3000/tcp`. We want the
// HOST-SIDE port (3006 in that example) as the key, because that's what the
// cron's curl will be hitting on 127.0.0.1.
async function fetchPortMap(server: ServerConfig): Promise<Map<string, string>> {
	const map = new Map<string, string>()
	try {
		const { stdout, code } = await runCommand(
			server,
			`docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null`,
			10_000,
		)
		if (code !== 0) return map
		for (const line of stdout.split('\n')) {
			const [name, portsField] = line.split('|', 2)
			if (!name || !portsField) continue
			for (const m of portsField.matchAll(/(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):(\d+)->/g)) {
				const hostPort = m[1]
				if (hostPort && !map.has(hostPort)) map.set(hostPort, name.trim())
			}
		}
	} catch {
		// Empty map → fall through to '(host)' for port-based crons. Better than
		// crashing the whole tick on one server's docker hiccup.
	}
	return map
}

async function scrapeServer(server: ServerConfig): Promise<number> {
	// Fetch the port map first; if the curl-based crons can't resolve a
	// container name we can't surface them on /activity (filtered out by the
	// repos-IN clause). One SSH per tick per server — cheap.
	const portMap = await fetchPortMap(server)

	// journalctl is universal on Ubuntu/Debian (which all managed servers run).
	// `-t CRON` filters by syslog tag. `-o short-iso` gives parseable timestamps.
	// `--no-pager` for clean stdout. We pull the last LOOKBACK_MINUTES with a
	// hard line cap so a runaway cron can't blow the SSH buffer.
	// the syslog tag alone is not proof: an app container with the journald
	// logging driver and `tag: CRON` (or any process calling logger -t CRON) writes
	// the same tag. Also match the sending process: the cron daemon's job child
	// (comm `cron`; journalctl ORs two values of one field and ANDs fields), so a
	// container's lines (sent by dockerd) or a `logger` call do not count as runs.
	const cmd = `journalctl --no-pager -t CRON _COMM=cron _COMM=CRON -o short-iso --since '${LOOKBACK_MINUTES} minutes ago' 2>/dev/null | tail -500`

	let output: string
	try {
		const res = await runCommand(server, cmd, 15_000)
		if (res.code !== 0) return 0
		output = res.stdout
	} catch {
		return 0
	}

	const rows: { id: string; serverId: string; containerName: string; commandSnippet: string; startedAt: Date }[] = []
	for (const line of output.split('\n')) {
		const m = line.match(CRON_LINE)
		if (!m) continue
		const ts = new Date(m[1] ?? '')
		if (Number.isNaN(ts.getTime())) continue
		const snippet = snippetFor(m[2] ?? '')
		if (!snippet) continue
		rows.push({
			id: createId(prefixes.cronRun),
			serverId: server.id,
			containerName: containerForCommand(m[2] ?? '', portMap),
			// Masked (snippetFor): shown on the crons tab and returned by the API.
			commandSnippet: snippet,
			startedAt: ts,
		})
	}

	if (rows.length === 0) return 0

	// Bulk insert with conflict-on-dedup-do-nothing. The UNIQUE
	// (server_id, started_at, command_snippet) makes the re-scrape harmless.
	await db.insert(cronRuns).values(rows).onConflictDoNothing()
	return rows.length
}

export async function cronObserverTick(): Promise<void> {
	const allServers = await listAllServers()
	for (const s of allServers) {
		try {
			const seen = await scrapeServer(s)
			if (seen > 0) {
				console.log(`[cron-observer] ${s.id}: parsed ${seen} CRON lines`)
			}
		} catch (err) {
			console.error(
				`[cron-observer] ${s.id} failed:`,
				err instanceof Error ? err.message : err,
			)
		}
	}
}
