// Per-app DB inventory with size + actual container name.
//
// The DB container is not assumed to be `<containerName>-db` (a shared
// `postgres` container can hold many apps' DBs): the route uses the same
// backup_db_* override columns the backup pipeline uses, so the page reflects
// reality.

import { requireUser, visibleRepos } from '@/lib/access'
import { decryptSecret } from '@/lib/crypto'
import { type ServerConfig, listAllServers } from '@/lib/servers'
import { findEnvFile, listContainers, runCommand, writeFileViaSftp } from '@/lib/ssh'
import { randomTempPath } from '@/lib/temp-path'
import { shq } from '@/lib/shell'
import { postgresToolImage } from '@/lib/tool-images'
import { TOOL_RUN_HARDEN } from '@/lib/side-run'
import { parseRawEnv } from '@/lib/env-parse'
import { maskUrlPassword, revealDenied, revealRequested } from '@/lib/secret-mask'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface StorageRow {
	kind: 'postgres' | 'kv'
	serverId: string
	serverName: string
	containerName: string
	storeContainerName: string
	storeContainerState: string | null
	connectionString: string | null
	// New: bytes of the specific database (for postgres) reported by
	// pg_database_size. Null if the query failed, container is missing,
	// or kind is kv.
	sizeBytes: number | null
	// New: when set, the actual db host the app connects to is not a docker
	// container we can manage (e.g. host postgres on the server). The UI uses
	// this to show "host postgres" instead of the misleading "internal —
	// only your app can reach …" footer.
	mode: 'sibling' | 'shared-container' | 'host' | 'unknown'
	dbName?: string | null
	// Postgres rows: the app, so the page can link to its backups tab.
	appRepoId?: string
	error?: string
}

// Resolve which docker container actually holds this app's postgres data.
// Priority: explicit override → naming convention → shared container heuristics.
function resolvePostgresContainer(repo: {
	containerName: string
	backupDbContainer: string | null
	backupDbHost: string | null
}): { container: string | null; mode: StorageRow['mode'] } {
	if (repo.backupDbHost) return { container: null, mode: 'host' }
	if (repo.backupDbContainer) {
		// If explicit and matches the powder convention it's a sibling; else shared.
		return {
			container: repo.backupDbContainer,
			mode: repo.backupDbContainer === `${repo.containerName}-db` ? 'sibling' : 'shared-container',
		}
	}
	return { container: `${repo.containerName}-db`, mode: 'sibling' }
}

// Query the actual on-disk size of one database within a postgres container.
// 5-second SSH ceiling: pg_database_size is fast.
async function fetchDbSize(
	server: ServerConfig,
	container: string,
	user: string,
	dbName: string,
): Promise<number | null> {
	try {
		const { stdout, code } = await runCommand(
			server,
			`docker exec ${shq(container)} psql -U ${shq(user)} -d ${shq(dbName)} -tA -c "SELECT pg_database_size(current_database())" 2>/dev/null || true`,
			5_000,
		)
		if (code !== 0) return null
		const n = Number(stdout.trim())
		return Number.isFinite(n) && n > 0 ? n : null
	} catch {
		return null
	}
}

// Size for a database living on the server's host OS (not in docker). Uses the
// same throwaway-postgres-container trick as the backup pipeline: spawn
// postgres:17-alpine with --network host so it can reach 127.0.0.1, pass the
// password via --env-file (file written + removed inline) so it never appears
// in `ps aux`. 8-second timeout because the docker run startup has overhead.
async function fetchHostDbSize(
	server: ServerConfig,
	hostSpec: string,
	user: string,
	dbName: string,
	passwordEncrypted: string,
): Promise<number | null> {
	const password = (() => {
		try {
			return decryptSecret(passwordEncrypted)
		} catch {
			return null
		}
	})()
	if (!password) return null
	const [hostPart = '', portPart] = hostSpec.split(':')
	const port = portPart || '5432'
	// the password goes over SFTP (0600 env file), never as base64 in argv.
	// random name, created exclusively (no planted file or link is written through).
	const envTmp = randomTempPath('/tmp/powder-pgenv')
	const cmd = [
		`set -eo pipefail`,
		`F=${shq(envTmp)}`,
		`trap 'rm -f "$F"' EXIT`,
		`docker run --rm --network host ${TOOL_RUN_HARDEN} --env-file "$F" --entrypoint psql ${shq(postgresToolImage())} ` +
			`-h ${shq(hostPart)} -p ${shq(port)} -U ${shq(user)} -d ${shq(dbName)} ` +
			`-tA -c "SELECT pg_database_size(current_database())" 2>/dev/null || true`,
	].join('\n')
	try {
		await writeFileViaSftp(server, envTmp, `PGPASSWORD=${password}\n`, 0o600, 10_000, true, true)
		const { stdout, code } = await runCommand(server, cmd, 12_000)
		if (code !== 0) return null
		const lines = stdout
			.trim()
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)
		const last = lines[lines.length - 1]
		if (!last) return null
		const n = Number(last)
		return Number.isFinite(n) && n > 0 ? n : null
	} catch {
		await runCommand(server, `rm -f ${shq(envTmp)}`, 5_000).catch(() => {})
		return null
	}
}

export async function GET(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const user = userOrResp
	// connection strings leave the server without the password unless
	// ?reveal=1 from an admin browser session (never a bearer token).
	const denied = revealDenied(req, user)
	if (denied) return denied
	const reveal = revealRequested(req)
	const conn = (v: string | null) => (reveal ? v : maskUrlPassword(v))

	// never powder's own row: its DATABASE_URL is the platform database.
	const repos = await visibleRepos(user, 'never')
	const targets = repos.filter((r) => r.hasPostgres || r.hasKv)
	if (targets.length === 0) return Response.json({ dbs: [] })

	const servers = await listAllServers()
	const serverById = new Map(servers.map((s) => [s.id, s]))

	const rows: StorageRow[] = []
	await Promise.all(
		targets.map(async (repo) => {
			const server = serverById.get(repo.serverId)
			if (!server) {
				if (repo.hasPostgres) rows.push(blank('postgres', repo, '(unknown server)'))
				if (repo.hasKv) rows.push(blank('kv', repo, '(unknown server)'))
				return
			}

			let containers: Awaited<ReturnType<typeof listContainers>> = []
			try {
				containers = await listContainers(server)
			} catch {
				if (repo.hasPostgres) rows.push(blank('postgres', repo, server.name, 'unreachable'))
				if (repo.hasKv) rows.push(blank('kv', repo, server.name, 'unreachable'))
				return
			}

			let envEntries: { key: string; value: string }[] | null = null
			const envs = async () => {
				if (envEntries) return envEntries
				try {
					const { exists, contents } = await findEnvFile(server, repo.containerName)
					envEntries = exists ? parseRawEnv(contents) : []
				} catch {
					envEntries = []
				}
				return envEntries
			}

			if (repo.hasPostgres) {
				const { container, mode } = resolvePostgresContainer(repo)
				const dbName = repo.backupDbName ?? null
				const dbUser = repo.backupDbUser ?? 'app'
				const e = await envs()
				const connStr = e.find((x) => x.key === 'DATABASE_URL')?.value ?? null

				let state: string | null
				let sizeBytes: number | null = null
				if (mode === 'host') {
					state = 'host'
					// Host postgres — same throwaway-container pattern as backups uses,
					// so we get a real number instead of a misleading "—".
					if (repo.backupDbHost && repo.backupDbPasswordEncrypted && dbName) {
						sizeBytes = await fetchHostDbSize(
							server,
							repo.backupDbHost,
							dbUser,
							dbName,
							repo.backupDbPasswordEncrypted,
						)
					}
				} else if (container) {
					const c = containers.find((x) => x.name === container)
					state = c?.state ?? 'missing'
					// Only query size if the container is actually running.
					if (c?.state === 'running' && dbName) {
						sizeBytes = await fetchDbSize(server, container, dbUser, dbName)
					} else if (c?.state === 'running' && mode === 'sibling') {
						// Convention: db name is 'app' for sibling postgres created by powder.
						sizeBytes = await fetchDbSize(server, container, 'app', 'app')
					}
				} else {
					state = 'unknown'
				}

				rows.push({
					kind: 'postgres',
					serverId: server.id,
					serverName: server.name,
					containerName: repo.containerName,
					storeContainerName: container ?? (mode === 'host' ? '(host postgres)' : '(unknown)'),
					storeContainerState: state,
					connectionString: conn(connStr),
					sizeBytes,
					mode,
					dbName,
					appRepoId: repo.id,
				})
			}

			if (repo.hasKv) {
				const c = containers.find((x) => x.name === `${repo.containerName}-kv`)
				const e = await envs()
				rows.push({
					kind: 'kv',
					serverId: server.id,
					serverName: server.name,
					containerName: repo.containerName,
					storeContainerName: `${repo.containerName}-kv`,
					storeContainerState: c?.state ?? 'missing',
					connectionString: conn(e.find((x) => x.key === 'REDIS_URL')?.value ?? null),
					sizeBytes: null,
					mode: 'sibling',
				})
			}
		}),
	)

	return Response.json({ dbs: rows })
}

function blank(
	kind: 'postgres' | 'kv',
	repo: { serverId: string; containerName: string },
	serverName: string,
	error?: string,
): StorageRow {
	return {
		kind,
		serverId: repo.serverId,
		serverName,
		containerName: repo.containerName,
		storeContainerName: `${repo.containerName}-${kind === 'postgres' ? 'db' : 'kv'}`,
		storeContainerState: null,
		connectionString: null,
		sizeBytes: null,
		mode: 'unknown',
		error,
	}
}
