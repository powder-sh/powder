'use client'

import { SkeletonList } from '@/components/ui/skeleton'
import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface Bucket {
	t: string
	req: number
	bytes: number
	s2: number
	s3: number
	s4: number
	s5: number
}

interface TrafficResponse {
	supported?: boolean
	days: number
	totalRequests: number
	totalBytes: number
	buckets: Bucket[]
}

const RANGES = [
	{ days: 1, label: '24h' },
	{ days: 7, label: '7d' },
	{ days: 30, label: '30d' },
] as const

export function TrafficCard({
	serverId,
	containerName,
}: {
	serverId: string
	containerName: string
}) {
	const [data, setData] = useState<TrafficResponse | null>(null)
	const [days, setDays] = useState<number>(7)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false
		setLoading(true)
		setError(null)
		fetch(`/api/servers/${serverId}/containers/${containerName}/traffic?days=${days}`)
			.then(async (r) => {
				if (cancelled) return
				if (!r.ok) {
					setError(`failed to load (${r.status})`)
					setData(null)
				} else {
					setData(await r.json())
				}
			})
			.catch((e) => {
				if (!cancelled) setError(e instanceof Error ? e.message : 'load failed')
			})
			.finally(() => {
				if (!cancelled) setLoading(false)
			})
		return () => {
			cancelled = true
		}
	}, [serverId, containerName, days])

	if (data && data.supported === false) return null
	const empty = !loading && !error && data && data.totalRequests === 0

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle className="flex items-center gap-2">
						<Activity className="h-4 w-4" />
						traffic
					</CardTitle>
					<div className="flex items-center gap-1 text-xs">
						{RANGES.map((r) => (
							<button
								key={r.days}
								type="button"
								onClick={() => setDays(r.days)}
								className={`rounded px-2 py-0.5 ${
									days === r.days
										? 'bg-accent text-accent-foreground'
										: 'text-muted-foreground hover:text-foreground'
								}`}
							>
								{r.label}
							</button>
						))}
					</div>
				</div>
			</CardHeader>
			<CardContent>
				{loading && <SkeletonList rows={2} bare />}
				{error && <p className="text-xs text-destructive">{error}</p>}
				{empty && (
					<p className="text-xs text-muted-foreground">
						no traffic recorded in the last {days === 1 ? '24 hours' : `${days} days`}.
					</p>
				)}
				{data && data.totalRequests > 0 && <Chart data={data} days={days} />}
			</CardContent>
		</Card>
	)
}

function Chart({ data, days }: { data: TrafficResponse; days: number }) {
	const slots = bucketize(data.buckets, days)
	const maxReq = Math.max(1, ...slots.map((s) => s.req))
	const totals = data.buckets.reduce(
		(acc, b) => {
			acc.s2 += b.s2
			acc.s3 += b.s3
			acc.s4 += b.s4
			acc.s5 += b.s5
			return acc
		},
		{ s2: 0, s3: 0, s4: 0, s5: 0 },
	)

	return (
		<div className="space-y-3">
			<div className="flex items-baseline gap-4">
				<div>
					<div className="font-mono text-2xl font-semibold">{formatNum(data.totalRequests)}</div>
					<div className="text-2xs text-muted-foreground">requests</div>
				</div>
				<div>
					<div className="font-mono text-2xl font-semibold">{formatBytes(data.totalBytes)}</div>
					<div className="text-2xs text-muted-foreground">bytes out</div>
				</div>
			</div>

			<div className="flex h-20 items-end gap-px">
				{slots.map((s) => {
					const total = s.req || 0
					const errorPct = total ? (s.s4 + s.s5) / total : 0
					const h = total ? Math.max(2, (total / maxReq) * 80) : 0
					return (
						<div
							key={s.label}
							className="group relative flex-1 cursor-default"
							style={{ height: '80px' }}
							title={`${s.label} · ${total} req · ${s.s2} 2xx · ${s.s3} 3xx · ${s.s4} 4xx · ${s.s5} 5xx`}
						>
							<div
								className={`absolute bottom-0 w-full rounded-sm ${
									errorPct > 0.1
										? 'bg-destructive/70'
										: errorPct > 0
											? 'bg-warning/70'
											: 'bg-powder/70'
								}`}
								style={{ height: `${h}px` }}
							/>
						</div>
					)
				})}
			</div>

			<div className="flex flex-wrap items-center gap-3 text-2xs text-muted-foreground">
				<span>
					<span className="font-mono text-foreground">{formatNum(totals.s2)}</span> 2xx
				</span>
				<span>
					<span className="font-mono text-foreground">{formatNum(totals.s3)}</span> 3xx
				</span>
				<span>
					<span className="font-mono text-warning">{formatNum(totals.s4)}</span> 4xx
				</span>
				<span>
					<span className="font-mono text-destructive">{formatNum(totals.s5)}</span> 5xx
				</span>
				<span className="ml-auto text-2xs">updates every 5 min</span>
			</div>
		</div>
	)
}

interface Slot {
	label: string
	req: number
	s2: number
	s3: number
	s4: number
	s5: number
}

// Bucketize hourly rows into a fixed grid the chart can render: 24 hour-slots
// for 24h view, 7 day-slots for 7d, 30 day-slots for 30d. Empty slots stay 0.
function bucketize(buckets: Bucket[], days: number): Slot[] {
	const now = Date.now()
	const slotMs = days === 1 ? 60 * 60_000 : 24 * 60 * 60_000
	const numSlots = days === 1 ? 24 : days
	const start = now - numSlots * slotMs

	const slots: Slot[] = Array.from({ length: numSlots }, (_, i) => {
		const slotStart = start + i * slotMs
		const d = new Date(slotStart)
		const label =
			days === 1 ? d.toISOString().slice(11, 13) + ':00 UTC' : d.toISOString().slice(5, 10)
		return { label, req: 0, s2: 0, s3: 0, s4: 0, s5: 0 }
	})

	for (const b of buckets) {
		const t = new Date(b.t).getTime()
		if (t < start) continue
		const i = Math.floor((t - start) / slotMs)
		if (i < 0 || i >= numSlots) continue
		slots[i].req += b.req
		slots[i].s2 += b.s2
		slots[i].s3 += b.s3
		slots[i].s4 += b.s4
		slots[i].s5 += b.s5
	}
	return slots
}

function formatNum(n: number): string {
	if (n < 1000) return String(n)
	if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
	return (n / 1_000_000).toFixed(1) + 'M'
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
