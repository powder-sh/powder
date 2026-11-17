// Traefik access-log aggregator. Runs every 5 min from the cron-scheduler
// tick. SSHes to each Traefik server, awk-filters access.log lines
// newer than the cursor, parses JSON, accumulates per-(container, hour)
// counters, UPSERTs into app_traffic_stats, advances cursor.

import { listTraefikServerIds } from './traefik-servers'
import {
	appTrafficStats,
	db,
	eq,
	sql,
	trafficCursors,
} from './db'
import { getServer } from './servers'
import { runCommand } from './ssh'

const ACCESS_LOG_PATH = '/var/log/traefik/access.log'
const SSH_TIMEOUT_MS = 30_000
// Cap how far back we'll process on a brand-new server (no cursor row).
// Avoids replaying the whole log on first boot if it already has data.
const COLD_START_LOOKBACK_MS = 60 * 60_000 // 1 hour

interface AccessLogLine {
	time?: string
	StartUTC?: string
	RouterName?: string
	ServiceName?: string
	DownstreamStatus?: number
	DownstreamContentSize?: number
}

interface Bucket {
	requests: number
	bytesOut: number
	s2: number
	s3: number
	s4: number
	s5: number
}

async function aggregateTrafficForServer(serverId: string): Promise<{
	processed: number
	buckets: number
}> {
	const server = await getServer(serverId)
	if (!server) return { processed: 0, buckets: 0 }

	const [cursor] = await db
		.select()
		.from(trafficCursors)
		.where(eq(trafficCursors.serverId, serverId))
	const sinceIso =
		cursor?.lastProcessedAt?.toISOString() ??
		new Date(Date.now() - COLD_START_LOOKBACK_MS).toISOString()

	// Pull lines newer than the cursor. awk extracts the "time":"..." field
	// (the top-level RFC3339 ts Traefik writes) and emits matching lines.
	// File-missing → empty output, no error.
	const cmd =
		`test -f ${ACCESS_LOG_PATH} || exit 0; ` +
		`awk -v c='${sinceIso}' '` +
		`match($0, /"time":"[^"]+"/) { ` +
		`  t = substr($0, RSTART+8, RLENGTH-9); ` +
		`  if (t > c) print ` +
		`}' ${ACCESS_LOG_PATH}`

	const { stdout, code } = await runCommand(server, cmd, SSH_TIMEOUT_MS)
	if (code !== 0) {
		console.warn(`[traffic-stats] awk exit ${code} on ${serverId}`)
		return { processed: 0, buckets: 0 }
	}

	const lines = stdout.split('\n').filter((l) => l.length > 0)
	if (lines.length === 0) return { processed: 0, buckets: 0 }

	// Bucket by (containerName, hourBucket-iso).
	const buckets = new Map<string, { container: string; hour: Date; b: Bucket }>()
	let maxTime = sinceIso

	for (const raw of lines) {
		let entry: AccessLogLine
		try {
			entry = JSON.parse(raw)
		} catch {
			continue
		}
		const time = entry.time ?? entry.StartUTC
		if (!time) continue
		if (time > maxTime) maxTime = time

		// RouterName is `<container>@docker` for our docker provider. Strip the
		// suffix. Skip entries with no router (404s for unmapped hosts).
		const router = entry.RouterName ?? ''
		if (!router) continue
		const container = router.replace(/@docker$/, '')

		const status = entry.DownstreamStatus ?? 0
		const bytes = entry.DownstreamContentSize ?? 0

		const hour = new Date(time)
		hour.setUTCMinutes(0, 0, 0)
		const key = `${container}\x00${hour.toISOString()}`

		let slot = buckets.get(key)
		if (!slot) {
			slot = { container, hour, b: zeroBucket() }
			buckets.set(key, slot)
		}
		slot.b.requests++
		slot.b.bytesOut += bytes
		if (status >= 200 && status < 300) slot.b.s2++
		else if (status >= 300 && status < 400) slot.b.s3++
		else if (status >= 400 && status < 500) slot.b.s4++
		else if (status >= 500) slot.b.s5++
	}

	// UPSERT each bucket: row may already exist for this hour from a previous
	// tick. += counters via ON CONFLICT.
	for (const { container, hour, b } of buckets.values()) {
		await db
			.insert(appTrafficStats)
			.values({
				serverId,
				containerName: container,
				hourBucket: hour,
				requests: b.requests,
				bytesOut: b.bytesOut,
				status2xx: b.s2,
				status3xx: b.s3,
				status4xx: b.s4,
				status5xx: b.s5,
			})
			.onConflictDoUpdate({
				target: [
					appTrafficStats.serverId,
					appTrafficStats.containerName,
					appTrafficStats.hourBucket,
				],
				set: {
					requests: sql`${appTrafficStats.requests} + ${b.requests}`,
					bytesOut: sql`${appTrafficStats.bytesOut} + ${b.bytesOut}`,
					status2xx: sql`${appTrafficStats.status2xx} + ${b.s2}`,
					status3xx: sql`${appTrafficStats.status3xx} + ${b.s3}`,
					status4xx: sql`${appTrafficStats.status4xx} + ${b.s4}`,
					status5xx: sql`${appTrafficStats.status5xx} + ${b.s5}`,
				},
			})
	}

	// Advance cursor to the latest line read (NOT now(): gives us a clean
	// resume point if the next tick fails).
	await db
		.insert(trafficCursors)
		.values({ serverId, lastProcessedAt: new Date(maxTime) })
		.onConflictDoUpdate({
			target: trafficCursors.serverId,
			set: { lastProcessedAt: new Date(maxTime), updatedAt: new Date() },
		})

	return { processed: lines.length, buckets: buckets.size }
}

export async function trafficAggregateTick(): Promise<void> {
	for (const serverId of await listTraefikServerIds()) {
		try {
			await aggregateTrafficForServer(serverId)
		} catch (err) {
			console.error(`[traffic-stats] ${serverId}:`, err)
		}
	}
}

function zeroBucket(): Bucket {
	return { requests: 0, bytesOut: 0, s2: 0, s3: 0, s4: 0, s5: 0 }
}
