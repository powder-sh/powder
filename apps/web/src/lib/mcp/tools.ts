import 'server-only'
// MCP tools for /api/mcp. Each tool runs the REST route handler that the
// dashboard uses for the same action, in-process, after checking the token's
// scopes against that route's "METHOD /path". So a tool has exactly the REST
// route's auth, validation, ownership checks, locks and audit rows: there is
// no second implementation to drift. No tool runs shell on a server. Tools are
// bearer-only, user-scoped, and reach nothing but powder's own API.

import { GET as deployGET } from '@/app/api/deploys/[deployId]/route'
import { GET as contextGET } from '@/app/api/projects/[id]/context/route'
import { GET as domainsGET } from '@/app/api/projects/[id]/domains/route'
import { DELETE as envKeyDELETE } from '@/app/api/projects/[id]/env/[key]/route'
import { GET as envGET, PUT as envPUT } from '@/app/api/projects/[id]/env/route'
import { POST as redeployPOST } from '@/app/api/projects/[id]/redeploy/route'
import { GET as projectsGET } from '@/app/api/projects/route'
import { GET as containerDeploysGET } from '@/app/api/servers/[id]/containers/[name]/deploys/route'
import { GET as serversListGET } from '@/app/api/servers/list/route'
import { type CurrentUser, visibleRepos } from '../access'
import { type SafeText, redactSecrets } from '../secret-text'
import { sessionOnlyRule } from '../session-only'
import { tokenAllows } from '../token-scopes'
import type { ToolDef, ToolResult } from './protocol'

export interface ToolCtx {
	user: CurrentUser
	/** Headers of the MCP request; ip + user agent are passed on for audit rows. */
	headers: Headers
	/** Origin used to build the in-process Request URLs. */
	origin: string
}

type Args = Record<string, unknown>

interface McpTool extends ToolDef {
	write: boolean
	run(args: Args, ctx: ToolCtx): Promise<unknown>
}

/** A failure the caller should see verbatim (no stack, no internals). */
class ToolError extends Error {}

const FORWARDED_HEADERS = [
	'user-agent',
	'x-forwarded-for',
	'x-real-ip',
	'cf-connecting-ip',
] as const

// --- argument helpers ------------------------------------------------------

function str(
	args: Args,
	key: string,
	opts: { required?: boolean; max?: number } = {},
): string | undefined {
	const v = args[key]
	if (v === undefined || v === null || v === '') {
		if (opts.required) throw new ToolError(`missing argument: ${key}`)
		return undefined
	}
	if (typeof v !== 'string') throw new ToolError(`argument ${key} must be a string`)
	if (opts.max && v.length > opts.max)
		throw new ToolError(`argument ${key} is too long (max ${opts.max})`)
	return v
}

function reqStr(args: Args, key: string, max: number): string {
	const v = str(args, key, { required: true, max })
	if (v === undefined) throw new ToolError(`missing argument: ${key}`)
	return v
}

function int(args: Args, key: string, def: number, min: number, max: number): number {
	const v = args[key]
	if (v === undefined || v === null) return def
	const n = typeof v === 'number' ? v : Number(v)
	if (!Number.isInteger(n) || n < min || n > max)
		throw new ToolError(`argument ${key} must be an integer ${min}..${max}`)
	return n
}

const ENV_SCOPES = ['production', 'preview', 'development'] as const
function envScope(args: Args): string {
	const s = str(args, 'scope') ?? 'production'
	if (!(ENV_SCOPES as readonly string[]).includes(s))
		throw new ToolError('scope must be production, preview or development')
	return s
}

// Ids and keys end up in a URL path and in the scope string: keep them to a
// plain charset so neither can be bent with "/" or "..".
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]{1,200}$/
function segment(value: string, what: string): string {
	if (!SAFE_SEGMENT.test(value) || value.includes('..')) throw new ToolError(`invalid ${what}`)
	return value
}

// --- REST dispatch ---------------------------------------------------------

/**
 * Runs a REST route handler in-process. The scope check uses the same
 * "METHOD /path" string the proxy would stamp for a direct REST call; the
 * handler then does its own requireUser / ownership checks as always.
 */
export async function rest<P>(
	ctx: ToolCtx,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	path: string,
	handler: (req: Request, c: { params: Promise<P> }) => Promise<Response | undefined>,
	params: P,
	opts: { body?: unknown; query?: Record<string, string> } = {},
): Promise<Record<string, unknown>> {
	if (ctx.user.viaToken && !tokenAllows(ctx.user.tokenScopes ?? null, `${method} ${path}`)) {
		throw new ToolError(
			`this token lacks the scope "${method} ${path}" (or a pattern covering it). Create a token with the needed scope on the api tokens page.`,
		)
	}
	const url = new URL(path, ctx.origin)
	for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)
	// the session-only registry holds here too (the proxy never sees this call).
	const so = ctx.user.viaToken ? sessionOnlyRule(method, url.pathname, url.searchParams) : null
	if (so) throw new ToolError(`${so.why} needs an admin browser session; API tokens cannot reach it (whatever their scopes)`)
	const headers = new Headers()
	for (const h of FORWARDED_HEADERS) {
		const v = ctx.headers.get(h)
		if (v) headers.set(h, v)
	}
	let body: string | undefined
	if (opts.body !== undefined) {
		headers.set('content-type', 'application/json')
		body = JSON.stringify(opts.body)
	}
	const res = await handler(new Request(url, { method, headers, body }), {
		params: Promise.resolve(params),
	})
	if (!res) throw new Error(`${method} ${path} returned no response`)
	const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
	if (!res.ok) {
		const msg = typeof data?.error === 'string' ? data.error : res.statusText || 'request failed'
		throw new ToolError(`powder answered ${res.status}: ${msg.slice(0, 300)}`)
	}
	return data ?? {}
}

interface AppRef {
	id: string
	serverId: string
	containerName: string
}

/** `app` may be the project id (rep_...) or a container name that is unique across servers. */
async function resolveApp(args: Args, user: CurrentUser): Promise<AppRef> {
	const ref = reqStr(args, 'app', 200)
	// the same set list_apps shows (never powder's own row to a token).
	const repos = await visibleRepos(user, 'admin-session')
	const byId = repos.find((r) => r.id === ref)
	if (byId) return byId
	const byName = repos.filter((r) => r.containerName === ref)
	const [only] = byName
	if (only && byName.length === 1) return only
	if (byName.length > 1) {
		throw new ToolError(
			`"${ref}" names apps on several servers; pass the project id from list_apps instead.`,
		)
	}
	throw new ToolError(`unknown app "${ref}". Call list_apps for ids.`)
}

// --- tools -----------------------------------------------------------------

const APP_ARG = {
	app: {
		type: 'string',
		description: 'Project id (rep_...) from list_apps, or the container name if it is unique.',
	},
}

const READ = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
}

function tailLines(
	text: string,
	n: number,
): { text: string; totalLines: number; truncated: boolean } {
	const lines = text.split('\n')
	const kept = lines.slice(-n)
	return { text: kept.join('\n'), totalLines: lines.length, truncated: kept.length < lines.length }
}

// Deploy text from the DB is masked at write (finishDeploy); masking again at
// read covers any stored row that was not masked. An MCP
// result field that carries log text is always SafeText.
function safeField(v: unknown): SafeText | null {
	return typeof v === 'string' && v ? redactSecrets(v) : null
}

const TOOLS: McpTool[] = [
	{
		name: 'list_apps',
		description:
			'List every app (project) powder manages: id, container name, server, primary domain, repo, branch, last deploy and uptime. Call this first to find an app id.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'List apps', ...READ },
		write: false,
		async run(_args, ctx) {
			const data = await rest(ctx, 'GET', '/api/projects', projectsGET, {})
			const projects = (data.projects as Record<string, unknown>[]) ?? []
			// deployDays is the 30-day strip for the dashboard; noise for an agent.
			return { apps: projects.map(({ deployDays: _d, ...p }) => p) }
		},
	},
	{
		name: 'get_app',
		description:
			"One app's state: server, container state and ports, hostnames, configured domains with status, the last deploys, and dashboard links. Reads the container over SSH, so it can take a few seconds.",
		inputSchema: {
			type: 'object',
			properties: APP_ARG,
			required: ['app'],
			additionalProperties: false,
		},
		annotations: { title: 'Get app', ...READ },
		write: false,
		async run(args, ctx) {
			const app = await resolveApp(args, ctx.user)
			const id = segment(app.id, 'app id')
			const context = await rest(ctx, 'GET', `/api/projects/${id}/context`, contextGET, { id })
			const domains = await rest(ctx, 'GET', `/api/projects/${id}/domains`, domainsGET, { id })
			const rows = (domains.domains as Record<string, unknown>[]) ?? []
			return {
				...context,
				domains: {
					autoAssigned: domains.autoAssigned ?? null,
					...(domains.note ? { note: domains.note } : {}),
					configured: rows.map((d) => ({ hostname: d.hostname, status: d.status })),
				},
			}
		},
	},
	{
		name: 'list_deploys',
		description:
			"An app's most recent deploys (newest first): id, status, kind, trigger, commit, timings and the failure summary. Use get_deploy_log for the log.",
		inputSchema: {
			type: 'object',
			properties: {
				...APP_ARG,
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: 20,
					description: 'How many (default 10, max 20).',
				},
			},
			required: ['app'],
			additionalProperties: false,
		},
		annotations: { title: 'List deploys', ...READ },
		write: false,
		async run(args, ctx) {
			const app = await resolveApp(args, ctx.user)
			const limit = int(args, 'limit', 10, 1, 20)
			const serverId = segment(app.serverId, 'server id')
			const name = segment(app.containerName, 'container name')
			const data = await rest(
				ctx,
				'GET',
				`/api/servers/${serverId}/containers/${name}/deploys`,
				containerDeploysGET,
				{
					id: serverId,
					name,
				},
			)
			const rows = (data.deploys as Record<string, unknown>[]) ?? []
			return {
				app: app.id,
				deploys: rows.slice(0, limit).map((d) => ({
					id: d.id,
					status: d.status,
					kind: d.kind,
					triggeredBy: d.triggeredBy,
					gitSha: d.gitSha,
					gitBranch: d.gitBranch,
					queuedAt: d.queuedAt,
					startedAt: d.startedAt,
					finishedAt: d.finishedAt,
					failedStep: safeField(d.failedStep),
					errorSummary: safeField(d.errorSummary),
					// a push held on the settle window: when it deploys, how to skip it
					...(typeof d.waiting === 'string' ? { waiting: d.waiting } : {}),
				})),
			}
		},
	},
	{
		name: 'get_deploy_log',
		description:
			'The log of one deploy (the last N lines), plus its status and failure summary. Secrets that look like tokens, keys, passwords or credentials in URLs are masked as [redacted].',
		inputSchema: {
			type: 'object',
			properties: {
				deploy_id: {
					type: 'string',
					description: 'Deploy id (dep_...) from list_deploys or deploy_app.',
				},
				tail: {
					type: 'integer',
					minimum: 1,
					maximum: 2000,
					description: 'Lines from the end (default 200, max 2000).',
				},
			},
			required: ['deploy_id'],
			additionalProperties: false,
		},
		annotations: { title: 'Get deploy log', ...READ },
		write: false,
		async run(args, ctx) {
			const deployId = segment(reqStr(args, 'deploy_id', 64), 'deploy id')
			const tail = int(args, 'tail', 200, 1, 2000)
			const data = await rest(ctx, 'GET', `/api/deploys/${deployId}`, deployGET, { deployId })
			const d = (data.deploy as Record<string, unknown>) ?? {}
			const log = tailLines(redactSecrets(typeof d.output === 'string' ? d.output : ''), tail)
			const error =
				typeof d.error === 'string' && d.error ? tailLines(redactSecrets(d.error), tail).text : null
			return {
				id: d.id,
				serverId: d.serverId,
				containerName: d.containerName,
				status: d.status,
				kind: d.kind,
				gitSha: d.gitSha,
				startedAt: d.startedAt,
				finishedAt: d.finishedAt,
				failedStep: safeField(d.failedStep),
				exitCode: d.exitCode,
				errorSummary: safeField(d.errorSummary),
				log: log.text,
				logTotalLines: log.totalLines,
				logTruncated: log.truncated,
				error,
			}
		},
	},
	{
		name: 'deploy_app',
		description:
			"Redeploy an app from the head of its configured branch, the same as the dashboard's redeploy button. Refused while a deploy of the app is already in flight. Returns the deploy id; poll get_deploy_log until status is success or failed.",
		inputSchema: {
			type: 'object',
			properties: APP_ARG,
			required: ['app'],
			additionalProperties: false,
		},
		annotations: {
			title: 'Deploy app',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		},
		write: true,
		async run(args, ctx) {
			const app = await resolveApp(args, ctx.user)
			const id = segment(app.id, 'app id')
			const data = await rest(ctx, 'POST', `/api/projects/${id}/redeploy`, redeployPOST, { id })
			return {
				app: app.id,
				deployId: data.deployId,
				next: 'call get_deploy_log with this deploy id to follow it',
			}
		},
	},
	{
		name: 'list_env_keys',
		description:
			"An app's env var names per scope with a length-only preview. Values are never returned.",
		inputSchema: {
			type: 'object',
			properties: APP_ARG,
			required: ['app'],
			additionalProperties: false,
		},
		annotations: { title: 'List env keys', ...READ },
		write: false,
		async run(args, ctx) {
			const app = await resolveApp(args, ctx.user)
			const id = segment(app.id, 'app id')
			const data = await rest(ctx, 'GET', `/api/projects/${id}/env`, envGET, { id })
			return { app: app.id, vars: data.vars ?? [] }
		},
	},
	{
		name: 'set_env_var',
		description:
			'Create or overwrite one env var (encrypted at rest, audited, previous value kept in history). It reaches the running app on the next deploy: call deploy_app after.',
		inputSchema: {
			type: 'object',
			properties: {
				...APP_ARG,
				key: { type: 'string', description: 'Name, [A-Za-z_][A-Za-z0-9_]*.' },
				value: { type: 'string', description: 'The value. Never echoed back.' },
				scope: { type: 'string', enum: [...ENV_SCOPES], description: 'Default production.' },
			},
			required: ['app', 'key', 'value'],
			additionalProperties: false,
		},
		annotations: {
			title: 'Set env var',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		write: true,
		async run(args, ctx) {
			const app = await resolveApp(args, ctx.user)
			const id = segment(app.id, 'app id')
			const key = reqStr(args, 'key', 200)
			const value = args.value
			if (typeof value !== 'string') throw new ToolError('argument value must be a string')
			const scope = envScope(args)
			const data = await rest(
				ctx,
				'PUT',
				`/api/projects/${id}/env`,
				envPUT,
				{ id },
				{ body: { key, value, scope } },
			)
			return {
				app: app.id,
				ok: true,
				var: data.var,
				next: 'call deploy_app so the app picks it up',
			}
		},
	},
	{
		name: 'delete_env_var',
		description:
			'Delete one env var from an app (audited). The running app keeps the old value until the next deploy.',
		inputSchema: {
			type: 'object',
			properties: {
				...APP_ARG,
				key: { type: 'string', description: 'Name of the var.' },
				scope: { type: 'string', enum: [...ENV_SCOPES], description: 'Default production.' },
			},
			required: ['app', 'key'],
			additionalProperties: false,
		},
		annotations: {
			title: 'Delete env var',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		write: true,
		async run(args, ctx) {
			const app = await resolveApp(args, ctx.user)
			const id = segment(app.id, 'app id')
			const key = segment(reqStr(args, 'key', 200), 'env var name')
			const scope = envScope(args)
			const data = await rest(
				ctx,
				'DELETE',
				`/api/projects/${id}/env/${key}`,
				envKeyDELETE,
				{ id, key },
				{ query: { scope } },
			)
			return { app: app.id, key, scope, ...data }
		},
	},
	{
		name: 'list_servers',
		description:
			'Servers powder deploys to: id, name, host, status, proxy (nginx or traefik), TLS mode and base domain.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'List servers', ...READ },
		write: false,
		async run(_args, ctx) {
			return rest(ctx, 'GET', '/api/servers/list', serversListGET, {})
		},
	},
]

export function listTools(): ToolDef[] {
	return TOOLS.map(({ name, description, inputSchema, annotations }) => ({
		name,
		description,
		inputSchema,
		annotations,
	}))
}

export function isWriteTool(name: string): boolean {
	return TOOLS.some((t) => t.name === name && t.write)
}

function text(value: unknown, isError = false): ToolResult {
	return {
		content: [
			{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
		],
		...(isError ? { isError } : {}),
	}
}

/** null = no such tool. Errors become isError results with a plain message. */
export async function callTool(name: string, args: Args, ctx: ToolCtx): Promise<ToolResult | null> {
	const tool = TOOLS.find((t) => t.name === name)
	if (!tool) return null
	try {
		return text(await tool.run(args, ctx))
	} catch (err) {
		if (err instanceof ToolError) return text(err.message, true)
		// Unexpected: log the detail server-side, give the agent nothing internal.
		console.error(`[mcp] tool ${name} failed:`, err instanceof Error ? err.message : err)
		return text(
			`${name} failed with an internal error. Check the powder logs or try the dashboard.`,
			true,
		)
	}
}
