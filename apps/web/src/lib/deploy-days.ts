// Per-day deploy history for the dashboard strips (apps list, app detail,
// fleet heartbeat). Built from the deploys table: powder keeps no uptime
// history (app_uptime_checks holds only the latest check per app), so the
// strip shows what is on record: successful and failed deploys per UTC day.
//
// Pure: no DB, no React. The query lives next to the routes that use it.

export const DEPLOY_DAYS = 30

export interface DeployDay {
	/** UTC calendar day, YYYY-MM-DD. */
	day: string
	ok: number
	failed: number
}

export interface DeployDayRow {
	server_id: string
	container_name: string
	/** A date or timestamp string; only the YYYY-MM-DD part is read. */
	day: string | Date
	ok: number | string
	failed: number | string
}

export type DayTone = 'none' | 'ok' | 'mixed' | 'failed'

const DAY_MS = 86_400_000

function isoDay(t: number): string {
	return new Date(t).toISOString().slice(0, 10)
}

function rowDay(d: string | Date): string {
	return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)
}

/** The last `days` UTC days ending today, oldest first, all zero. */
export function emptyDays(now = Date.now(), days = DEPLOY_DAYS): DeployDay[] {
	const out: DeployDay[] = []
	const today = Date.UTC(
		new Date(now).getUTCFullYear(),
		new Date(now).getUTCMonth(),
		new Date(now).getUTCDate(),
	)
	for (let i = days - 1; i >= 0; i--)
		out.push({ day: isoDay(today - i * DAY_MS), ok: 0, failed: 0 })
	return out
}

/**
 * Group per-(server, container, day) counts into one fixed-length series per
 * app key ("server|container"). Days outside the window are dropped; apps with
 * no deploys in the window are not in the map (callers fall back to emptyDays).
 */
export function bucketDeployDays(
	rows: readonly DeployDayRow[],
	now = Date.now(),
	days = DEPLOY_DAYS,
): Map<string, DeployDay[]> {
	const template = emptyDays(now, days)
	const index = new Map(template.map((d, i) => [d.day, i]))
	const out = new Map<string, DeployDay[]>()
	for (const r of rows) {
		const i = index.get(rowDay(r.day))
		if (i === undefined) continue
		const key = `${r.server_id}|${r.container_name}`
		let series = out.get(key)
		if (!series) {
			series = template.map((d) => ({ ...d }))
			out.set(key, series)
		}
		series[i].ok += Number(r.ok) || 0
		series[i].failed += Number(r.failed) || 0
	}
	return out
}

/** Sum several series day by day (fleet strip). All inputs share one window. */
export function sumDeployDays(
	series: readonly (readonly DeployDay[])[],
	now = Date.now(),
): DeployDay[] {
	const len = series[0]?.length ?? DEPLOY_DAYS
	const out = series[0]
		? series[0].map((d) => ({ day: d.day, ok: 0, failed: 0 }))
		: emptyDays(now, len)
	for (const s of series) {
		for (let i = 0; i < out.length && i < s.length; i++) {
			out[i].ok += s[i].ok
			out[i].failed += s[i].failed
		}
	}
	return out
}

export function dayTone(d: Pick<DeployDay, 'ok' | 'failed'>): DayTone {
	if (d.ok === 0 && d.failed === 0) return 'none'
	if (d.failed === 0) return 'ok'
	if (d.ok === 0) return 'failed'
	return 'mixed'
}

export function summarizeDays(days: readonly DeployDay[]): {
	ok: number
	failed: number
	activeDays: number
} {
	let ok = 0
	let failed = 0
	let activeDays = 0
	for (const d of days) {
		ok += d.ok
		failed += d.failed
		if (d.ok + d.failed > 0) activeDays++
	}
	return { ok, failed, activeDays }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** Weekday, day, short month, year, then "(UTC)": the strip's days are UTC calendar days. */
export function dayTitle(d: Pick<DeployDay, 'day'>): string {
	const t = new Date(`${d.day}T00:00:00Z`)
	if (Number.isNaN(t.getTime())) return `${d.day} (UTC)`
	return `${WEEKDAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()} (UTC)`
}

/** "2 ok, 1 failed", or "no deploys". */
export function dayCounts(d: Pick<DeployDay, 'ok' | 'failed'>): string {
	if (d.ok === 0 && d.failed === 0) return 'no deploys'
	const parts: string[] = []
	if (d.ok) parts.push(`${d.ok} ok`)
	if (d.failed) parts.push(`${d.failed} failed`)
	return parts.join(', ')
}

/** dayTitle, a colon, then dayCounts: one line for assistive tech. */
export function dayLabel(d: DeployDay): string {
	return `${dayTitle(d)}: ${dayCounts(d)}`
}
