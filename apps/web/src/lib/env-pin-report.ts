// which apps render their env OUTSIDE their own dir, and whether powder will
// keep that target (a pin, or evidence that predates the cutoff, see
// env-target.ts). Read-only: never pins, never writes. Run by
// bin/self-deploy.sh --pin-report (and printed by bin/self-deploy.sh before the recreate).

import { envTargetHardRefusal, envTargetInAppDir, pinSql } from './env-target'

export interface PinReportRow {
	serverId: string
	app: string
	target: string | null
	pinned: string | null
	hard: string | null
	evidence: 'snapshot' | null
	error?: string
}

/** Pure: one report line (plus the INSERT when the target needs a hand pin). */
export function pinReportLine(r: PinReportRow): string {
	const head = `${r.serverId}/${r.app}`
	if (r.error) return `?  ${head}: could not check (${r.error})`
	if (!r.target) return `ok ${head}: no env target`
	if (r.target === `/opt/apps/${r.app}.env` || envTargetInAppDir(r.target, r.app))
		return `ok ${head}: ${r.target} (inside the app)`
	if (r.hard)
		return `NO ${head}: ${r.target} can never be used: ${r.hard}; point env_file at /opt/apps/${r.app}.env or inside /opt/apps/${r.app}/`
	if (r.pinned === r.target) return `ok ${head}: ${r.target} (pinned)`
	if (r.evidence)
		return `ok ${head}: ${r.target} (will be pinned at the next deploy, evidence: ${r.evidence})`
	return `NO ${head}: ${r.target} has no pre-upgrade evidence; the next deploy refuses the env render. Check it is this app's file, then run in powder's DB:\n   ${pinSql(r.serverId, r.app, r.target)}`
}

/** Pure: the closing line. `?` rows (could not check) need attention too: their
 *  target is unknown, so the upgrade may refuse their env render. */
export function pinReportSummary(refused: number, unchecked: number): string {
	const total = refused + unchecked
	if (unchecked === 0) return `[env-pin-report] ${total} app(s) need attention`
	return `[env-pin-report] ${total} app(s) need attention (${refused} refused, ${unchecked} could not be checked: fix the reason shown and run the report again)`
}

/** the report runs before the migrations of the new code (--pin-report applies none),
 *  so it reads only the server columns it needs instead of getServer (which selects
 *  every current column, ingress_ip from 0046 included). */
async function reportServer(
	id: string,
): Promise<import('./servers').ServerConfig | undefined> {
	const { db, sql } = await import('./db')
	const rows = (await db.execute(
		sql`SELECT id, name, host, ssh_user, ssh_port, kind::text AS kind, build_host, proxy FROM servers WHERE id = ${id}`,
	)) as unknown as Array<{
		id: string
		name: string
		host: string
		ssh_user: string
		ssh_port: string
		kind: 'compose' | 'raw-docker'
		build_host: string | null
		proxy: 'nginx' | 'nginx-container' | 'traefik'
	}>
	const r = rows[0]
	if (!r) return undefined
	return {
		id: r.id,
		name: r.name,
		host: r.host,
		user: r.ssh_user,
		port: Number(r.ssh_port) || 22,
		kind: r.kind,
		buildHost: r.build_host ?? null,
		proxy: r.proxy,
	}
}

/** Every app: its current render target and what powder will do with it. */
export async function runPinReport(log: (line: string) => void = console.log): Promise<number> {
	const { db, sql } = await import('./db')
	const { envFileCandidatesFor } = await import('./ssh')
	const { envTargetEvidence, loadEnvTargetCtx } = await import('./env-vars-db')
	const apps = (
		(await db.execute(sql`SELECT server_id, container_name FROM app_repos`)) as unknown as Array<{
			server_id: string
			container_name: string
		}>
	).map((r) => ({ serverId: r.server_id, app: r.container_name }))
	let missing = 0
	let unchecked = 0
	log(
		'[env-pin-report] env render targets (ok = keeps working, NO = refused until fixed or pinned, ? = could not check)',
	)
	for (const a of apps.sort((x, y) =>
		`${x.serverId}/${x.app}`.localeCompare(`${y.serverId}/${y.app}`),
	)) {
		const row: PinReportRow = {
			serverId: a.serverId,
			app: a.app,
			target: null,
			pinned: null,
			hard: null,
			evidence: null,
		}
		try {
			const server = await reportServer(a.serverId)
			if (!server) throw new Error('server not found')
			row.target = (await envFileCandidatesFor(server, a.app))[0] ?? null
			if (
				row.target &&
				row.target !== `/opt/apps/${a.app}.env` &&
				!envTargetInAppDir(row.target, a.app)
			) {
				const { ctx, cutoff } = await loadEnvTargetCtx(a.serverId, a.app)
				row.pinned = ctx.pinned
				row.hard = envTargetHardRefusal(row.target, ctx)
				if (!row.hard && ctx.pinned !== row.target)
					row.evidence = await envTargetEvidence(server, a.app, row.target, cutoff ?? new Date())
			}
		} catch (err) {
			row.error = err instanceof Error ? err.message.slice(0, 160) : String(err)
		}
		const line = pinReportLine(row)
		if (line.startsWith('NO')) missing++
		else if (line.startsWith('?')) unchecked++
		log(line)
	}
	log(pinReportSummary(missing, unchecked))
	return missing + unchecked
}
