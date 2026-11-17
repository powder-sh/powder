import { randomBytes } from 'node:crypto'
import type { ServerConfig } from '../servers'
import { shq } from '../shell'
import { runCommand } from './connection'

/** control characters a container's crontab (or any file read here) could
 *  carry. A CR inside one line made the parser see a forged `---CONTAINER:<name>---`
 *  header (JS `^` with the m flag also matches after \r), so a container could file
 *  its crons under another container's name. Deleted on the server (C0 controls except
 *  tab and newline, and DEL); the parser drops CR and the Unicode line separators too. */
export const CRON_CTRL_TR = String.raw`tr -d '\000-\010\013-\037\177'`

function cronOutputClean(s: string): string {
	return s.replace(/[\r\u2028\u2029\u0085]/g, '')
}

// Returns the raw root crontab on the server. Empty string if no crontab.
export async function getRootCrontab(server: ServerConfig): Promise<string> {
	const { stdout, code } = await runCommand(server, 'crontab -l 2>/dev/null || true', 5_000)
	return code === 0 ? stdout : ''
}

// Returns every cron source on a server, labeled by origin. Places real Linux
// crons live, in increasing order of obscurity:
//   - root's user crontab        (`crontab -l`)         — 5-field schedule + command
//   - /etc/crontab               (system crontab)       — 5-field schedule + USER + command
//   - /etc/cron.d/*              (system cron drop-ins) — 5-field schedule + USER + command
//   - non-root user crontabs     (/var/spool/cron/crontabs/<user>) — 5-field schedule + command
//   - container:<name>           (dcron/cron inside a container)   — 5-field schedule + command
//   - systemd:<timer-name>       (.timer + .service unit pair)     — non-cron schedule format
// `systemd:` entries don't fit the 5-field grammar — content is a key=value
// block (Schedule, Service, ExecStart, Next, Last) that the caller parses.
export interface CrontabSource {
	origin:
		| 'user-root'
		| `user:${string}`
		| 'system-etc'
		| `cron.d:${string}`
		| `container:${string}`
		| `systemd:${string}`
	content: string
}

export async function getAllCronSources(server: ServerConfig): Promise<CrontabSource[]> {
	// One round-trip: read user crontab + /etc/crontab + /etc/cron.d/* + try
	// crontab inside every running container (most exec calls fail fast for
	// containers without cron; the ones that succeed give us app-internal crons).
	// every section marker and block header carries a random per-call nonce,
	// so a file read here (a user's crontab, a container's) cannot print a marker
	// that starts another section or files lines under another source.
	const n = randomBytes(12).toString('hex')
	const M = (name: string) => `===${name}_${n}===`
	const cmd = [
		`echo '${M('USER_ROOT')}'`,
		`crontab -l 2>/dev/null || true`,
		`echo '${M('SYSTEM_ETC')}'`,
		`cat /etc/crontab 2>/dev/null || true`,
		`echo '${M('CRON_D_START')}'`,
		`for f in /etc/cron.d/*; do`,
		`  [ -f "$f" ] || continue`,
		`  echo "---FILE_${n}:$(basename "$f")---"`,
		`  cat "$f"`,
		`done`,
		`echo '${M('USER_CRONS_START')}'`,
		// Non-root user crontabs. A host's `appuser` for example hits app webhooks
		// from cron and was invisible to the root-only previous read.
		`for f in /var/spool/cron/crontabs/* /var/spool/cron/* 2>/dev/null; do`,
		`  [ -f "$f" ] || continue`,
		`  u=$(basename "$f")`,
		`  [ "$u" = "root" ] && continue`,
		`  echo "---USER_${n}:$u---"`,
		`  cat "$f"`,
		`done`,
		`echo '${M('CONTAINERS_START')}'`,
		// For each running container, try the common cron file locations.
		// Skip output if nothing reads (most apps don't ship cron inside).
		// Filter the stock busybox /etc/periodic entries — every Alpine ships them
		// even when nothing populates the periodic dirs, so they're pure noise.
		`for c in $(docker ps --format '{{.Names}}' 2>/dev/null); do`,
		`  out=$(docker exec "$c" sh -c 'crontab -l 2>/dev/null; cat /etc/crontabs/root 2>/dev/null; cat /var/spool/cron/crontabs/root 2>/dev/null' 2>/dev/null | grep -vE '^[[:space:]]*(#|$)' | grep -vE 'run-parts[[:space:]]+/etc/periodic' | grep -E '^(@[a-z]+|[*0-9])' || true)`,
		`  if [ -n "$out" ]; then`,
		`    echo "---CONTAINER_${n}:$c---"`,
		`    echo "$out"`,
		`  fi`,
		`done`,
		`echo '${M('SYSTEMD_START')}'`,
		// systemd timers — filter out the OS housekeeping noise, keep app timers.
		// Pattern matches what /servers commonly run; expand if a noisy timer slips
		// through. Format: per timer, emit Schedule, Next, Last, ExecStart.
		`SYSD_NOISE='^(apt-|certbot|dpkg-|e2scrub|fstrim|logrotate|man-|motd-|sysstat|systemd-|update-|snap\\.|fwupd|ua-)'`,
		`systemctl list-timers --all --no-legend --no-pager 2>/dev/null | awk '{print $NF}' | grep '\\.timer$' | grep -vE "$SYSD_NOISE" | while read t; do`,
		`  [ -z "$t" ] && continue`,
		`  echo "---TIMER_${n}:$t---"`,
		`  systemctl cat "$t" 2>/dev/null | grep -E '^(OnCalendar|OnUnitActiveSec|OnBootSec|Description|ExecStart)=' | head -10`,
		`  ts=$(systemctl show "$t" --property=NextElapseUSecRealtime --value 2>/dev/null)`,
		`  echo "NextElapse=$ts"`,
		`  svc="\${t%.timer}.service"`,
		`  systemctl cat "$svc" 2>/dev/null | grep -E '^(Description|ExecStart)=' | head -4 | sed 's/^/Service./'`,
		`done`,
	].join('\n')
	// pipefail keeps the probe's own exit status through the control-char filter.
	const wrapped = `bash -o pipefail -c ${shq(`{\n${cmd}\n} | ${CRON_CTRL_TR}`)}`
	// Generous timeout: container-cron probing across many containers per
	// server can take a couple of seconds. Still well under the 30s SSH ceiling.
	const res = await runCommand(server, wrapped, 25_000)
	if (res.code !== 0) return []
	const stdout = cronOutputClean(res.stdout)

	const sources: CrontabSource[] = []
	const userRoot = section(stdout, M('USER_ROOT'), M('SYSTEM_ETC'))
	if (userRoot.trim()) sources.push({ origin: 'user-root', content: userRoot })

	const systemEtc = section(stdout, M('SYSTEM_ETC'), M('CRON_D_START'))
	if (systemEtc.trim()) sources.push({ origin: 'system-etc', content: systemEtc })

	const cronD = section(stdout, M('CRON_D_START'), M('USER_CRONS_START'))
	pushKeyedBlocks(cronD, new RegExp(`^---FILE_${n}:(.+)---\\s*$`, 'gm'), (name, body) => {
		sources.push({ origin: `cron.d:${name}`, content: body })
	})

	const userCrons = section(stdout, M('USER_CRONS_START'), M('CONTAINERS_START'))
	pushKeyedBlocks(userCrons, new RegExp(`^---USER_${n}:(.+)---\\s*$`, 'gm'), (name, body) => {
		sources.push({ origin: `user:${name}`, content: body })
	})

	const containers = section(stdout, M('CONTAINERS_START'), M('SYSTEMD_START'))
	pushKeyedBlocks(containers, new RegExp(`^---CONTAINER_${n}:(.+)---\\s*$`, 'gm'), (name, body) => {
		sources.push({ origin: `container:${name}`, content: body })
	})

	const systemd = section(stdout, M('SYSTEMD_START'), null)
	pushKeyedBlocks(systemd, new RegExp(`^---TIMER_${n}:(.+)---\\s*$`, 'gm'), (name, body) => {
		sources.push({ origin: `systemd:${name}`, content: body })
	})

	return sources
}

function pushKeyedBlocks(
	body: string,
	headerRe: RegExp,
	push: (name: string, content: string) => void,
): void {
	const headers: { name: string; start: number; bodyStart: number }[] = []
	let m: RegExpExecArray | null
	// biome-ignore lint/suspicious/noAssignInExpressions: the usual RegExp.exec loop
	while ((m = headerRe.exec(body)) !== null) {
		headers.push({ name: (m[1] ?? '').trim(), start: m.index, bodyStart: m.index + m[0].length })
	}
	for (const [i, cur] of headers.entries()) {
		const next = headers[i + 1]
		const content = body.slice(cur.bodyStart, next ? next.start : undefined)
		if (content.trim()) push(cur.name, content)
	}
}

function section(s: string, startMarker: string, endMarker: string | null): string {
	const start = s.indexOf(startMarker)
	if (start < 0) return ''
	const afterStart = start + startMarker.length
	const end = endMarker ? s.indexOf(endMarker, afterStart) : -1
	return s.slice(afterStart, end < 0 ? undefined : end)
}
