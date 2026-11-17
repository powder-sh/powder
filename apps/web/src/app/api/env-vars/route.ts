import { requireUser, visibleRepos } from '@/lib/access'
import { listAllServers, updateServerStatus, getServer } from '@/lib/servers'
import { bulkReadAppEnvFiles, listContainers, findEnvFile } from '@/lib/ssh'
import { parseRawEnv } from '@/lib/env-parse'
import { isPowderSelfContainer, maskEntries, revealDenied, revealRequested } from '@/lib/secret-mask'
import { clientErrorMessage } from '@/lib/pg-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface AppEnv {
	serverId: string
	serverName: string
	containerName: string
	appRepoId?: string | null
	exists: boolean
	path: string | null
	entries: { key: string; value: string }[]
	error?: string
}

// One SSH per server fetches every env file in a single round trip, instead of
// one docker inspect + read per container. Parallel across servers; one SSH
// round trip per server.
//
// `?app=<containerName>` scopes the response to a single app, used by the
// /projects/[id]/settings "go to env vars" link: one SSH call and one env file
// read instead of fanning out across every server.
export async function GET(req: Request) {
	const userOrResp = await requireUser()
	if (userOrResp instanceof Response) return userOrResp
	const user = userOrResp
	// values leave the server masked; full values need ?reveal=1 AND
	// an admin browser session (never a bearer token).
	const denied = revealDenied(req, user)
	if (denied) return denied
	const reveal = revealRequested(req)
	const entriesOf = (contents: string) => {
		const e = parseRawEnv(contents)
		return reveal ? e : maskEntries(e)
	}

	const url = new URL(req.url)
	const appFilter = url.searchParams.get('app')?.trim() || null

	// never powder's own row (its env holds the platform secrets).
	const userRepos = await visibleRepos(user, 'never')
	const allowedKey = new Set(userRepos.map((r) => `${r.serverId}|${r.containerName}`))
	const repoIdByKey = new Map(userRepos.map((r) => [`${r.serverId}|${r.containerName}`, r.id]))

	// Fast path: caller named a specific app. Resolve repo → server → read one
	// env file. No fan-out across other servers/containers.
	if (appFilter) {
		const repo = userRepos.find((r) => r.containerName === appFilter && !isPowderSelfContainer(r.containerName))
		if (!repo) {
			// Either it doesn't exist or this user can't see it; same response either way.
			return Response.json({ apps: [], isAdmin: user.isAdmin })
		}
		const server = await getServer(repo.serverId)
		if (!server) return Response.json({ apps: [], isAdmin: user.isAdmin })
		try {
			const e = await findEnvFile(server, repo.containerName)
			return Response.json({
				isAdmin: user.isAdmin,
				apps: [
					{
						serverId: server.id,
						serverName: server.name,
						containerName: repo.containerName,
							appRepoId: repo.id,
						exists: e.exists,
						path: e.path,
						entries: e.exists ? entriesOf(e.contents) : [],
					} satisfies AppEnv,
				],
			})
		} catch (err) {
			const msg = clientErrorMessage(err, 'env read failed', 'env-vars')
			return Response.json({
				isAdmin: user.isAdmin,
				apps: [
					{
						serverId: server.id,
						serverName: server.name,
						containerName: repo.containerName,
							appRepoId: repo.id,
						exists: false,
						path: null,
						entries: [],
						error: msg,
					} satisfies AppEnv,
				],
			})
		}
	}

	const servers = await listAllServers()

	const results: AppEnv[] = []
	await Promise.all(
		servers.map(async (server) => {
			let containers: Awaited<ReturnType<typeof listContainers>>
			try {
				containers = await listContainers(server)
			} catch (err) {
				const msg = clientErrorMessage(err, 'unreachable', 'env-vars')
				await updateServerStatus(server.id, 'unreachable', msg)
				results.push({
					serverId: server.id,
					serverName: server.name,
					containerName: '',
					exists: false,
					path: null,
					entries: [],
					error: msg,
				})
				return
			}

			// managed apps only, never powder's own container (it holds the
			// platform secrets), and never an unmanaged container.
			const filtered = containers.filter(
				(c) => allowedKey.has(`${server.id}|${c.name}`) && !isPowderSelfContainer(c.name),
			)
			if (filtered.length === 0) return

			let envByName: Awaited<ReturnType<typeof bulkReadAppEnvFiles>>
			try {
				envByName = await bulkReadAppEnvFiles(
					server,
					filtered.map((c) => c.name),
				)
			} catch (err) {
				envByName = new Map()
				const msg = clientErrorMessage(err, 'env read failed', 'env-vars')
				for (const c of filtered) {
					results.push({
						serverId: server.id,
						serverName: server.name,
						containerName: c.name,
						appRepoId: repoIdByKey.get(`${server.id}|${c.name}`) ?? null,
						exists: false,
						path: null,
						entries: [],
						error: msg,
					})
				}
				return
			}

			for (const c of filtered) {
				const e = envByName.get(c.name)
				if (!e) {
					results.push({
						serverId: server.id,
						serverName: server.name,
						containerName: c.name,
						appRepoId: repoIdByKey.get(`${server.id}|${c.name}`) ?? null,
						exists: false,
						path: null,
						entries: [],
					})
					continue
				}
				results.push({
					serverId: server.id,
					serverName: server.name,
					containerName: c.name,
						appRepoId: repoIdByKey.get(`${server.id}|${c.name}`) ?? null,
					exists: e.exists,
					path: e.path,
					entries: e.exists ? entriesOf(e.contents) : [],
					...(e.error ? { error: e.error } : {}),
				})
			}
		}),
	)

	results.sort(
		(a, b) =>
			a.serverName.localeCompare(b.serverName) || a.containerName.localeCompare(b.containerName),
	)

	return Response.json({ apps: results, isAdmin: user.isAdmin })
}
