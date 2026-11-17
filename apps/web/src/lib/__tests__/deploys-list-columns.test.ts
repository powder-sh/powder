import { afterAll, describe, expect, it } from 'vitest'

// listDeploysFor selects named columns and log tails: full rows carry every
// deploy's whole build log, which can be many MB.
const url = process.env.POWDER_TEST_DATABASE_URL
if (url) process.env.DATABASE_URL = url

// Every field the callers read: MCP list_deploys (lib/mcp/tools.ts) and the
// app page's DeployRow (app/(dashboard)/servers/[id]/[name]/page.tsx).
const MCP_FIELDS = [
	'id',
	'status',
	'kind',
	'triggeredBy',
	'gitSha',
	'gitBranch',
	'queuedAt',
	'startedAt',
	'finishedAt',
	'failedStep',
	'errorSummary',
]
const DASHBOARD_FIELDS = [
	'id',
	'serverId',
	'containerName',
	'kind',
	'status',
	'startedAt',
	'finishedAt',
	'output',
	'error',
	'triggeredBy',
	'gitSha',
	'gitBranch',
	'imageTag',
	'rolledBackFromId',
	'snapshotUrl',
	'snapshotExpiresAt',
]

describe('deploy list columns', () => {
	it('select exactly what the callers use, never the whole row', async () => {
		const { deployListColumns } = await import('../deploys')
		const keys = Object.keys(deployListColumns())
		for (const f of [...MCP_FIELDS, ...DASHBOARD_FIELDS]) expect(keys).toContain(f)
		for (const f of ['heartbeatAt', 'requestedSha', 'githubDeploymentId', 'snapshotContainer']) {
			expect(keys).not.toContain(f)
		}
	})
})

describe.skipIf(!url)('listDeploysFor on a real postgres', () => {
	const server = `srv_list_${Date.now()}`
	afterAll(async () => {
		const d = await import('../db')
		await d.db.delete(d.deploys).where(d.eq(d.deploys.serverId, server))
	})

	it('cuts big logs to a tail with a note, leaves small ones whole', async () => {
		const d = await import('../db')
		const { LIST_LOG_TAIL_CHARS, listDeploysFor } = await import('../deploys')
		const big = `${'build step ok\n'.repeat(160_000)}THE-END`
		await d.db.insert(d.deploys).values([
			{
				id: `${server}_1`,
				serverId: server,
				containerName: 'app',
				kind: 'git_deploy',
				status: 'failed',
				output: big,
				error: 'small error',
				startedAt: new Date(1000),
			},
			{
				id: `${server}_2`,
				serverId: server,
				containerName: 'app',
				kind: 'restart',
				status: 'success',
				output: 'ok',
				startedAt: new Date(2000),
			},
		])
		const rows = await listDeploysFor(server, 'app', 20)
		expect(rows.map((r) => r.id)).toEqual([`${server}_2`, `${server}_1`])
		const [small, failed] = rows
		expect(small?.output).toBe('ok')
		expect(failed?.error).toBe('small error')
		expect(failed?.output?.endsWith('THE-END')).toBe(true)
		expect(failed?.output?.startsWith('[earlier output cut here')).toBe(true)
		expect(failed?.output?.length).toBeLessThan(LIST_LOG_TAIL_CHARS + 200)
		expect(Object.keys(failed ?? {})).not.toContain('heartbeatAt')
	})

	it('re-masks stored rows whose deploy text is not masked', async () => {
		const d = await import('../db')
		const { listDeploysFor } = await import('../deploys')
		const tok = `ghp_${'a1B2'.repeat(9)}`
		await d.db.insert(d.deploys).values({
			id: `${server}_3`,
			serverId: server,
			containerName: 'legacy',
			kind: 'git_deploy',
			status: 'failed',
			output: `clone with ${tok}`,
			error: `push ${tok}`,
			errorSummary: `auth ${tok}`,
		})
		const [row] = await listDeploysFor(server, 'legacy', 20)
		for (const v of [row?.output, row?.error, row?.errorSummary]) {
			expect(v).not.toContain(tok)
			expect(v).toContain('[redacted]')
		}
	})
})
