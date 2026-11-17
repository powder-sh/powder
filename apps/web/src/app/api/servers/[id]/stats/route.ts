// Server-level stats: cpu, ram, disk, container count, uptime.
// Used by the /servers dashboards. One SSH command per server with all
// stats in a single call so we don't make N round trips.

import { requireServerForUser, requireUser } from '@/lib/access'
import { runCommand } from '@/lib/ssh'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const { id } = await ctx.params
	const server = await requireServerForUser(id)
	if (server instanceof Response) return server

	const cmd =
		`echo "===CPU==="; nproc; uptime | awk -F"load average: " '{print $2}'; ` +
		`echo "===MEM==="; free -b | awk '/^Mem:/ {print $2"|"$3"|"$7}'; ` +
		`echo "===DISK==="; df -B1 / | awk 'NR==2 {print $2"|"$3"|"$4}'; ` +
		`echo "===CONTAINERS==="; docker ps -q 2>/dev/null | wc -l; docker ps -aq 2>/dev/null | wc -l; ` +
		`echo "===UPTIME==="; awk '{print int($1)}' /proc/uptime`

	try {
		const { stdout, code } = await runCommand(server, cmd, 8_000)
		if (code !== 0) {
			return Response.json({ ok: false, error: 'ssh command failed' }, { status: 502 })
		}
		const sections = parseSections(stdout)

		const cpu = sections.CPU ?? ''
		const [coresLine, loadLine] = cpu.split('\n')
		const cores = Number.parseInt((coresLine || '0').trim(), 10) || 0
		const load = (loadLine || '').split(',').map((x) => Number.parseFloat(x.trim()) || 0)

		const mem = (sections.MEM ?? '').trim().split('|').map((n) => Number.parseInt(n, 10) || 0)
		const [memTotal, memUsed, memAvail] = mem

		const disk = (sections.DISK ?? '').trim().split('|').map((n) => Number.parseInt(n, 10) || 0)
		const [diskTotal, diskUsed, diskAvail] = disk

		const containerLines = (sections.CONTAINERS ?? '').trim().split('\n').map((n) => Number.parseInt(n, 10) || 0)
		const [running, total] = containerLines

		const uptimeSeconds = Number.parseInt((sections.UPTIME ?? '0').trim(), 10) || 0

		return Response.json({
			ok: true,
			cpu: { cores, load1: load[0] ?? 0, load5: load[1] ?? 0, load15: load[2] ?? 0 },
			memory: { total: memTotal, used: memUsed, available: memAvail },
			disk: { total: diskTotal, used: diskUsed, available: diskAvail },
			containers: { running: running ?? 0, total: total ?? 0 },
			uptimeSeconds,
		})
	} catch (err) {
		return Response.json({ ok: false, error: clientErrorMessage(err, 'unknown', 'servers/:id/stats') }, { status: 502 })
	}
}

function parseSections(out: string): Record<string, string> {
	const sections: Record<string, string> = {}
	let current: string | null = null
	let buf: string[] = []
	for (const line of out.split('\n')) {
		const m = line.match(/^===(\w+)===$/)
		if (m) {
			if (current) sections[current] = buf.join('\n')
			current = m[1] ?? ''
			buf = []
		} else {
			buf.push(line)
		}
	}
	if (current) sections[current] = buf.join('\n')
	return sections
}
