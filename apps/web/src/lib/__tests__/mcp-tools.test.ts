// Each MCP tool runs the REST handler the dashboard uses, after checking the
// token's scope for that exact route. Handlers are mocked: the test asserts
// which handler runs with which params, that a scope miss never reaches it,
// and that the handler's own access refusal (404/403/409) comes back as a
// plain tool error with nothing internal in it.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const ok = (body: unknown) => Response.json(body)
const h = {
	projects: vi.fn(async () =>
		ok({ projects: [{ id: 'rep_1', containerName: 'web', deployDays: [1, 2] }] }),
	),
	context: vi.fn(async (_req: Request, _c: unknown) =>
		ok({ project: { id: 'rep_1' }, recentDeploys: [] }),
	),
	domains: vi.fn(async (_req: Request, _c: unknown) =>
		ok({
			autoAssigned: 'web.example',
			domains: [{ hostname: 'a.com', status: 'live', txtChallenge: 'x' }],
		}),
	),
	deploys: vi.fn(async (_req: Request, _c: unknown) =>
		ok({ deploys: [{ id: 'dep_1', status: 'success', output: 'LOTS OF LOG' }] }),
	),
	deploy: vi.fn(async (_req: Request, _c: unknown) =>
		ok({
			deploy: {
				id: 'dep_1',
				status: 'failed',
				output: 'a\nb\nDATABASE_URL=postgres://u:hunter2@db/app\nd',
				error: null,
			},
		}),
	),
	redeploy: vi.fn(async (_req: Request, _c: unknown) => ok({ ok: true, deployId: 'dep_2' })),
	envGet: vi.fn(async (_req: Request, _c: unknown) =>
		ok({ vars: [{ key: 'A', scope: 'production', valuePreview: '(5 chars)' }] }),
	),
	envPut: vi.fn(async (_req: Request, _c: unknown) => ok({ ok: true, var: { key: 'A' } })),
	envDelete: vi.fn(async (_req: Request, _c: unknown) => ok({ deleted: 1 })),
	servers: vi.fn(async () => ok({ servers: [{ id: 's1' }] })),
}
vi.mock('@/app/api/projects/route', () => ({ GET: () => h.projects() }))
vi.mock('@/app/api/projects/[id]/context/route', () => ({
	GET: (r: Request, c: unknown) => h.context(r, c),
}))
vi.mock('@/app/api/projects/[id]/domains/route', () => ({
	GET: (r: Request, c: unknown) => h.domains(r, c),
}))
vi.mock('@/app/api/servers/[id]/containers/[name]/deploys/route', () => ({
	GET: (r: Request, c: unknown) => h.deploys(r, c),
}))
vi.mock('@/app/api/deploys/[deployId]/route', () => ({
	GET: (r: Request, c: unknown) => h.deploy(r, c),
}))
vi.mock('@/app/api/projects/[id]/redeploy/route', () => ({
	POST: (r: Request, c: unknown) => h.redeploy(r, c),
}))
vi.mock('@/app/api/projects/[id]/env/route', () => ({
	GET: (r: Request, c: unknown) => h.envGet(r, c),
	PUT: (r: Request, c: unknown) => h.envPut(r, c),
}))
vi.mock('@/app/api/projects/[id]/env/[key]/route', () => ({
	DELETE: (r: Request, c: unknown) => h.envDelete(r, c),
}))
vi.mock('@/app/api/servers/list/route', () => ({ GET: () => h.servers() }))
vi.mock('../access', () => ({
	visibleRepos: async () => [
		{ id: 'rep_1', serverId: 's1', containerName: 'web' },
		{ id: 'rep_2', serverId: 's1', containerName: 'dup' },
		{ id: 'rep_3', serverId: 's2', containerName: 'dup' },
	],
}))

import { type ToolCtx, callTool, isWriteTool, listTools } from '../mcp/tools'
import { MCP_READ_SCOPES, MCP_WRITE_SCOPES } from '../token-scopes'

function ctx(scopes: string[] | null = null): ToolCtx {
	return {
		user: {
			id: 'u',
			email: 'e',
			name: 'n',
			isAdmin: true,
			viaToken: true,
			tokenId: 't',
			tokenScopes: scopes,
		},
		headers: new Headers({
			'user-agent': 'claude-code',
			'x-real-ip': '1.2.3.4',
			authorization: 'Bearer pwd_secret',
		}),
		origin: 'https://dash.example',
	}
}
async function run(name: string, args: Record<string, unknown>, c = ctx()) {
	const r = await callTool(name, args, c)
	if (!r) throw new Error('unknown tool')
	return { isError: !!r.isError, text: r.content[0]?.text }
}
const params = async (fn: { mock: { calls: unknown[][] } }) =>
	(fn.mock.calls.at(-1)?.[1] as { params: Promise<unknown> }).params

beforeEach(() => {
	for (const f of Object.values(h)) f.mockClear()
})

describe('tool list', () => {
	it('has the v1 tools, write tools marked destructive, reads marked read-only', () => {
		const tools = listTools()
		expect(tools.map((t) => t.name).sort()).toEqual(
			[
				'delete_env_var',
				'deploy_app',
				'get_app',
				'get_deploy_log',
				'list_apps',
				'list_deploys',
				'list_env_keys',
				'list_servers',
				'set_env_var',
			].sort(),
		)
		for (const t of tools) {
			if (isWriteTool(t.name))
				expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
			else expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
		}
		expect(
			tools
				.filter((t) => isWriteTool(t.name))
				.map((t) => t.name)
				.sort(),
		).toEqual(['delete_env_var', 'deploy_app', 'set_env_var'])
	})
	it('no tool takes a command or shell argument', () => {
		for (const t of listTools()) {
			for (const k of Object.keys(t.inputSchema.properties))
				expect(k).not.toMatch(/cmd|command|shell|exec|script/i)
		}
	})
	it('unknown tool -> null', async () => {
		expect(await callTool('nope', {}, ctx())).toBeNull()
	})
})

describe('each tool runs its REST handler', () => {
	it('list_apps -> GET /api/projects, drops deployDays', async () => {
		const r = await run('list_apps', {})
		expect(h.projects).toHaveBeenCalledTimes(1)
		expect(JSON.parse(r.text).apps[0]).toEqual({ id: 'rep_1', containerName: 'web' })
	})
	it('get_app -> context + domains for the resolved id (by name too)', async () => {
		const r = await run('get_app', { app: 'web' })
		expect(await params(h.context)).toEqual({ id: 'rep_1' })
		expect(await params(h.domains)).toEqual({ id: 'rep_1' })
		const body = JSON.parse(r.text)
		expect(body.domains.configured).toEqual([{ hostname: 'a.com', status: 'live' }])
		expect(r.text).not.toContain('txtChallenge')
	})
	it('list_deploys -> container deploys route, no log bodies', async () => {
		const r = await run('list_deploys', { app: 'rep_1' })
		expect(await params(h.deploys)).toEqual({ id: 's1', name: 'web' })
		expect(r.text).not.toContain('LOTS OF LOG')
	})
	it('get_deploy_log -> deploy route, tails and redacts', async () => {
		const r = await run('get_deploy_log', { deploy_id: 'dep_1', tail: 2 })
		expect(await params(h.deploy)).toEqual({ deployId: 'dep_1' })
		const body = JSON.parse(r.text)
		expect(body.log).toBe('DATABASE_URL=postgres://[redacted]@db/app\nd')
		expect(r.text).not.toContain('hunter2')
		expect(body.logTruncated).toBe(true)
	})
	it('deploy_app -> redeploy route (dashboard button path)', async () => {
		const r = await run('deploy_app', { app: 'rep_1' })
		expect(await params(h.redeploy)).toEqual({ id: 'rep_1' })
		expect(JSON.parse(r.text).deployId).toBe('dep_2')
	})
	it('list_env_keys -> env GET', async () => {
		await run('list_env_keys', { app: 'rep_1' })
		expect(await params(h.envGet)).toEqual({ id: 'rep_1' })
	})
	it('set_env_var -> env PUT with the body, audit headers passed on, bearer not', async () => {
		const r = await run('set_env_var', {
			app: 'rep_1',
			key: 'A',
			value: 's3cret',
			scope: 'preview',
		})
		const req = h.envPut.mock.calls[0]?.[0] as Request
		expect(req.method).toBe('PUT')
		expect(await req.json()).toEqual({ key: 'A', value: 's3cret', scope: 'preview' })
		expect(req.headers.get('user-agent')).toBe('claude-code')
		expect(req.headers.get('x-real-ip')).toBe('1.2.3.4')
		expect(req.headers.get('authorization')).toBeNull()
		expect(r.text).not.toContain('s3cret')
	})
	it('delete_env_var -> env/[key] DELETE with ?scope', async () => {
		await run('delete_env_var', { app: 'rep_1', key: 'A', scope: 'development' })
		const req = h.envDelete.mock.calls[0]?.[0] as Request
		expect(new URL(req.url).pathname).toBe('/api/projects/rep_1/env/A')
		expect(new URL(req.url).searchParams.get('scope')).toBe('development')
		expect(await params(h.envDelete)).toEqual({ id: 'rep_1', key: 'A' })
	})
	it('list_servers -> servers list', async () => {
		const r = await run('list_servers', {})
		expect(h.servers).toHaveBeenCalledTimes(1)
		expect(JSON.parse(r.text).servers).toEqual([{ id: 's1' }])
	})
})

describe('scopes: same as the REST route', () => {
	it('read preset: every read tool works, every write tool is refused before its handler', async () => {
		const c = ctx([...MCP_READ_SCOPES])
		for (const [name, args] of [
			['list_apps', {}],
			['get_app', { app: 'rep_1' }],
			['list_deploys', { app: 'rep_1' }],
			['get_deploy_log', { deploy_id: 'dep_1' }],
			['list_env_keys', { app: 'rep_1' }],
			['list_servers', {}],
		] as const) {
			expect((await run(name, args, c)).isError, name).toBe(false)
		}
		for (const [name, args, fn] of [
			['deploy_app', { app: 'rep_1' }, h.redeploy],
			['set_env_var', { app: 'rep_1', key: 'A', value: 'v' }, h.envPut],
			['delete_env_var', { app: 'rep_1', key: 'A' }, h.envDelete],
		] as const) {
			const r = await run(name, args, c)
			expect(r.isError, name).toBe(true)
			expect(r.text).toMatch(/lacks the scope/)
			expect(fn).not.toHaveBeenCalled()
		}
	})
	it('write preset allows the write tools', async () => {
		expect((await run('deploy_app', { app: 'rep_1' }, ctx([...MCP_WRITE_SCOPES]))).isError).toBe(
			false,
		)
	})
	it('a token scoped to one app cannot act on another', async () => {
		const c = ctx(['POST /api/mcp', 'POST /api/projects/rep_2/redeploy'])
		expect((await run('deploy_app', { app: 'rep_1' }, c)).isError).toBe(true)
		expect(h.redeploy).not.toHaveBeenCalled()
		expect((await run('deploy_app', { app: 'rep_2' }, c)).isError).toBe(false)
	})
})

describe('ownership and errors', () => {
	it("the handler's refusal is returned as a tool error (404, 403, 409)", async () => {
		h.context.mockResolvedValueOnce(Response.json({ error: 'project not found' }, { status: 404 }))
		expect(await run('get_app', { app: 'rep_1' })).toEqual({
			isError: true,
			text: 'powder answered 404: project not found',
		})
		h.deploy.mockResolvedValueOnce(Response.json({ error: 'unknown container' }, { status: 404 }))
		expect((await run('get_deploy_log', { deploy_id: 'dep_9' })).text).toBe(
			'powder answered 404: unknown container',
		)
		h.redeploy.mockResolvedValueOnce(Response.json({ error: 'single_tenant' }, { status: 403 }))
		expect((await run('deploy_app', { app: 'rep_1' })).text).toBe(
			'powder answered 403: single_tenant',
		)
		h.redeploy.mockResolvedValueOnce(
			Response.json({ error: 'deploy already in flight' }, { status: 409 }),
		)
		expect((await run('deploy_app', { app: 'rep_1' })).text).toMatch(
			/409: deploy already in flight/,
		)
	})
	it('unknown or ambiguous app is refused without calling a handler', async () => {
		expect((await run('get_app', { app: 'ghost' })).text).toMatch(/unknown app/)
		const amb = await run('deploy_app', { app: 'dup' })
		expect(amb.text).toMatch(/several servers/)
		expect(amb.text).not.toMatch(/rep_2|rep_3/)
		expect(h.redeploy).not.toHaveBeenCalled()
	})
	it('path-bending ids and keys are refused', async () => {
		expect((await run('get_deploy_log', { deploy_id: '../tokens' })).isError).toBe(true)
		expect((await run('delete_env_var', { app: 'rep_1', key: 'A/../../x' })).isError).toBe(true)
		expect(h.deploy).not.toHaveBeenCalled()
		expect(h.envDelete).not.toHaveBeenCalled()
	})
	it('an unexpected throw is a generic message, no stack or detail', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
		h.servers.mockRejectedValueOnce(
			new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'),
		)
		const r = await run('list_servers', {})
		expect(r.isError).toBe(true)
		expect(r.text).not.toMatch(/ECONNREFUSED|hunter2|at /)
		spy.mockRestore()
	})
	it('argument validation', async () => {
		expect((await run('get_app', {})).text).toMatch(/missing argument: app/)
		expect((await run('list_deploys', { app: 'rep_1', limit: 99 })).isError).toBe(true)
		expect((await run('set_env_var', { app: 'rep_1', key: 'A', value: 1 })).isError).toBe(true)
		expect(
			(await run('set_env_var', { app: 'rep_1', key: 'A', value: 'v', scope: 'prod' })).isError,
		).toBe(true)
	})
})
