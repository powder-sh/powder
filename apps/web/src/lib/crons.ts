// Crontab parsing + per-container matching.
// Crons live in the host root crontab (cron jobs are not migrated into Powder
// yet). This module reads them as-is and tries to
// associate each line with a container by URL/path/name heuristics.

import { type SafeText, redactSecrets } from './secret-text'

export interface CronJob {
	schedule: string // raw 5-field cron expression
	command: string
	comment: string | null
	source: 'host' // future: 'host', 'container', '/etc/cron.d', etc
	matchedBy: ('port' | 'name-path' | 'docker-exec' | 'subdomain' | 'comment')[]
}

interface MatchHints {
	containerName: string
	hostPorts?: number[] // bound host ports (for apps served on a host port)
	publicHost?: string | null // e.g. <name>.<base_domain> (for traefik apps)
}

const SCHED_RE = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/

export function parseCrontab(
	text: string,
): { schedule: string; command: string; comment: string | null }[] {
	const out: { schedule: string; command: string; comment: string | null }[] = []
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim()
		if (!line || line.startsWith('#')) continue
		// skip env-var lines: KEY=value
		if (/^[A-Z_][A-Z0-9_]*=/.test(line)) continue
		// shorthand schedules (@reboot, @daily) are not parsed yet
		if (line.startsWith('@')) continue
		const m = line.match(SCHED_RE)
		if (!m) continue
		const schedule = m[1] ?? ''
		let command = (m[2] ?? '').trim()
		let comment: string | null = null
		// inline comment: split on " # " (with surrounding space) — bare # inside a URL is unlikely but let's be conservative
		const hashIdx = command.search(/\s#\s/)
		if (hashIdx >= 0) {
			comment = command.slice(hashIdx + 3).trim()
			command = command.slice(0, hashIdx).trim()
		}
		out.push({ schedule, command, comment })
	}
	return out
}

export function matchCronsForContainer(
	allCrons: { schedule: string; command: string; comment: string | null }[],
	hints: MatchHints,
): CronJob[] {
	const out: CronJob[] = []
	const name = hints.containerName
	if (!name) return out
	const namePat = new RegExp(`(^|[/\\s:@])${escapeRe(name)}([/\\s:.-]|$)`)
	const hostPortPats = (hints.hostPorts ?? []).map((p) => new RegExp(`:${p}\\b`))
	const subdomainPats = hints.publicHost ? [new RegExp(`//${escapeRe(hints.publicHost)}\\b`)] : []
	const dockerExecPat = new RegExp(`docker\\s+exec\\s+(?:-\\w+\\s+\\S+\\s+)*${escapeRe(name)}\\b`)

	for (const c of allCrons) {
		const matched: CronJob['matchedBy'] = []
		if (hostPortPats.some((p) => p.test(c.command))) matched.push('port')
		if (subdomainPats.some((p) => p.test(c.command))) matched.push('subdomain')
		if (dockerExecPat.test(c.command)) matched.push('docker-exec')
		if (/\/opt\/apps\/[^/\s]+/.test(c.command) && namePat.test(c.command)) {
			matched.push('name-path')
		}
		if (c.comment && namePat.test(c.comment)) matched.push('comment')
		if (matched.length > 0) {
			out.push({
				schedule: c.schedule,
				command: c.command,
				comment: c.comment,
				source: 'host',
				matchedBy: matched,
			})
		}
	}
	return out
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Pretty-print a 5-field cron expression in plain English. Falls back to the
// raw expression for anything we can't recognize quickly.
export function describeSchedule(expr: string): string {
	const [m, h, dom, mo, dow] = expr.split(/\s+/)
	if (!m || !h || !dom || !mo || !dow) return expr
	if (m === '*' && h === '*' && dom === '*' && mo === '*' && dow === '*') return 'every minute'
	if (m.startsWith('*/') && h === '*' && dom === '*' && mo === '*' && dow === '*') {
		return `every ${m.slice(2)} minutes`
	}
	if (h.startsWith('*/') && m === '0' && dom === '*' && mo === '*' && dow === '*') {
		return `every ${h.slice(2)} hours`
	}
	if (m === '0' && h === '*' && dom === '*' && mo === '*' && dow === '*') return 'hourly'
	if (dom === '*' && mo === '*' && dow === '*' && /^\d+$/.test(m) && /^\d+$/.test(h)) {
		return `daily at ${pad(h)}:${pad(m)}`
	}
	if (dom === '*' && mo === '*' && /^\d+$/.test(m) && /^\d+$/.test(h) && /^\d+$/.test(dow)) {
		return `${dayName(dow)} at ${pad(h)}:${pad(m)}`
	}
	return expr
}

function pad(s: string): string {
	return s.length === 1 ? `0${s}` : s
}
function dayName(dow: string): string {
	return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][Number(dow) % 7] ?? dow
}

// Redact secrets before showing a command. The rules live in lib/secret-text.ts.
export function maskSecrets(s: string): SafeText {
	return redactSecrets(s)
}
