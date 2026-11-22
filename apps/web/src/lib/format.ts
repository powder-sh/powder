export function timeAgo(iso: string | Date | null | undefined): string {
	if (!iso) return '-'
	const ms = Date.now() - new Date(iso).getTime()
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s ago`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ago`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h ago`
	const d = Math.floor(h / 24)
	if (d < 30) return `${d}d ago`
	const mo = Math.floor(d / 30)
	if (mo < 12) return `${mo}mo ago`
	return `${Math.floor(d / 365)}y ago`
}

/** A queue wait shorter than this is not shown: a claim takes seconds, so a wait of two
 *  minutes or more means the deploy sat behind another build on its app or server. */
export const QUEUE_WAIT_SHOW_MS = 2 * 60_000

/**
 * Queue wait label ("waited 12m") when a deploy sat queued for QUEUE_WAIT_SHOW_MS or more
 * before it was claimed (started_at is reset on claim, queued_at is not).
 * Returns null when there was no meaningful wait.
 */
export function waitedLabel(
	queuedAt: string | Date | null | undefined,
	startedAt: string | Date | null | undefined,
): string | null {
	if (!queuedAt || !startedAt) return null
	const ms = new Date(startedAt).getTime() - new Date(queuedAt).getTime()
	if (!(ms >= QUEUE_WAIT_SHOW_MS)) return null
	const s = Math.floor(ms / 1000)
	if (s < 3600) return `waited ${Math.floor(s / 60)}m`
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	if (h < 24) return m ? `waited ${h}h ${m}m` : `waited ${h}h`
	return `waited ${Math.floor(h / 24)}d`
}

/** The one deploy duration format: "850ms", "45s", "1m 30s", "1h 5m". "-" when unknown. */
export function formatDuration(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms)) return '-'
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ${s % 60}s`
	return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Like timeAgo but caps at days ("45d ago"), for lists that never roll up to months. */
export function timeAgoDays(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s ago`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ago`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h ago`
	return `${Math.floor(h / 24)}d ago`
}

export function fmtBytes(n: number | null | undefined): string {
	if (n == null) return '-'
	if (n < 1024) return `${n} B`
	const kb = n / 1024
	if (kb < 1024) return `${kb.toFixed(1)} KiB`
	const mb = kb / 1024
	if (mb < 1024) return `${mb.toFixed(1)} MiB`
	return `${(mb / 1024).toFixed(2)} GiB`
}

// The one date formatter for the dashboard: day, short month, year and 24-hour time in the
// viewer's time zone. Day-month-year with a month name reads the same in every
// locale (10/11/2026 does not), and the month names are fixed here so no
// locale data can turn "Sep" into "Sept".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type DateInput = string | number | Date | null | undefined

interface DateParts {
	year: string
	month: string
	day: string
	hour: string
	minute: string
	second: string
}

function dateParts(v: DateInput, timeZone?: string): DateParts | null {
	if (v == null || v === '') return null
	const d = v instanceof Date ? v : new Date(v)
	if (Number.isNaN(d.getTime())) return null
	const fmt = new Intl.DateTimeFormat('en-US', {
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
		timeZone,
	})
	const p: Record<string, string> = {}
	for (const { type, value } of fmt.formatToParts(d)) p[type] = value
	return {
		year: p.year,
		month: MONTHS[Number(p.month) - 1] ?? p.month,
		day: String(Number(p.day)),
		hour: p.hour,
		minute: p.minute,
		second: p.second,
	}
}

export interface DateFormatOptions {
	/** Append seconds ("19:32:05"). */
	seconds?: boolean
	/** IANA zone; the viewer's own zone when unset. */
	timeZone?: string
}

/** day, short month, year and 24-hour time; "-" for a missing or invalid date. */
export function formatDateTime(v: DateInput, opts: DateFormatOptions = {}): string {
	const p = dateParts(v, opts.timeZone)
	if (!p) return '-'
	const time = opts.seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`
	return `${p.day} ${p.month} ${p.year}, ${time}`
}

/** day, short month and year; "-" for a missing or invalid date. */
export function formatDate(v: DateInput, opts: Pick<DateFormatOptions, 'timeZone'> = {}): string {
	const p = dateParts(v, opts.timeZone)
	return p ? `${p.day} ${p.month} ${p.year}` : '-'
}

/** "19:32"; "-" for a missing or invalid date. */
export function formatTime(v: DateInput, opts: DateFormatOptions = {}): string {
	const p = dateParts(v, opts.timeZone)
	if (!p) return '-'
	return opts.seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`
}
