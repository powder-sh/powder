// Remote MCP endpoint for coding agents (Streamable HTTP, stateless, JSON
// responses only). Bearer API tokens only: a session cookie is never accepted
// here, so there is no ambient credential for a cross-site request to ride.
// Dashboard host only: the host split (lib/hosts.ts) 404s it on the site host.
// Tools and their scopes: lib/mcp/tools.ts. Docs: apps/web/content/docs/mcp.md.

import { createHash } from 'node:crypto'
import { requireUser } from '@/lib/access'
import { dashboardTrustedOrigins, dashboardUrl } from '@/lib/hosts'
import { BodyTooLargeError, readTextCapped } from '@/lib/http-limits'
import { type JsonRpcResponse, RPC, handleMcpMessage, rpcError } from '@/lib/mcp/protocol'
import { callTool, listTools } from '@/lib/mcp/tools'
import { checkRateLimit } from '@/lib/rate-limit'
import { webhookClientIp } from '@/lib/webhook-gate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_MCP_BODY_BYTES = 256 * 1024
// Per client IP before auth (bad-token guessing), per token after.
const IP_LIMIT = 300
const TOKEN_LIMIT = 120
const WINDOW_MS = 60_000

const INSTRUCTIONS =
	'powder deploys apps from GitHub to your own servers. Start with list_apps. deploy_app returns a deploy id; follow it with get_deploy_log. Env var values are write-only: list_env_keys shows names, set_env_var takes effect on the next deploy.'

function json(
	body: JsonRpcResponse | Record<string, unknown>,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

function limited(retryAfterMs: number): Response {
	return json(rpcError(null, RPC.INVALID_REQUEST, 'rate limited, slow down'), 429, {
		'retry-after': Math.max(1, Math.ceil(retryAfterMs / 1000)).toString(),
	})
}

function unauthorized(message: string): Response {
	return json(rpcError(null, -32001, message), 401, { 'www-authenticate': 'Bearer realm="powder"' })
}

// DNS-rebinding guard from the Streamable HTTP spec. Agents (CLIs) send no
// Origin; a browser page must be the dashboard itself.
function originAllowed(origin: string | null): boolean {
	if (!origin) return true
	return dashboardTrustedOrigins().includes(origin.replace(/\/+$/, ''))
}

export async function POST(req: Request) {
	if (!originAllowed(req.headers.get('origin'))) {
		return json({ error: 'origin not allowed' }, 403)
	}
	// with no trusted client IP, bucket per credential, not one shared
	// 'unknown' bucket every agent would fall into.
	const ip = webhookClientIp(req.headers)
	const ipKey =
		ip === 'unknown'
			? `mcp:cred:${createHash('sha256')
					.update(req.headers.get('authorization') ?? '')
					.digest('hex')
					.slice(0, 32)}`
			: `mcp:ip:${ip}`
	const ipCheck = checkRateLimit(ipKey, IP_LIMIT, WINDOW_MS)
	if (!ipCheck.ok) return limited(ipCheck.retryAfterMs)

	const authHeader = req.headers.get('authorization') ?? ''
	if (!authHeader.startsWith('Bearer ') || !authHeader.slice(7).trim()) {
		return unauthorized(
			'send Authorization: Bearer <powder API token>. Session cookies are not accepted here.',
		)
	}
	const user = await requireUser()
	if (user instanceof Response) {
		if (user.status === 401)
			return unauthorized(
				'invalid, revoked or expired token, or the token lacks the scope POST /api/mcp',
			)
		return json(
			rpcError(null, -32001, 'this account may not use powder (not an admin)'),
			user.status,
		)
	}
	if (!user.viaToken) return unauthorized('bearer token required')

	const tokenCheck = checkRateLimit(`mcp:token:${user.tokenId ?? user.id}`, TOKEN_LIMIT, WINDOW_MS)
	if (!tokenCheck.ok) return limited(tokenCheck.retryAfterMs)

	let raw: string
	try {
		raw = await readTextCapped(req, MAX_MCP_BODY_BYTES)
	} catch (err) {
		if (err instanceof BodyTooLargeError)
			return json(rpcError(null, RPC.INVALID_REQUEST, 'request body too large'), 413)
		return json(rpcError(null, RPC.PARSE_ERROR, 'could not read the request body'), 400)
	}
	let msg: unknown
	try {
		msg = JSON.parse(raw)
	} catch {
		return json(rpcError(null, RPC.PARSE_ERROR, 'parse error: body is not JSON'), 400)
	}

	const ctx = { user, headers: req.headers, origin: dashboardUrl() }
	let response: JsonRpcResponse | null
	try {
		response = await handleMcpMessage(msg, {
			serverInfo: { name: 'powder', version: process.env.NEXT_PUBLIC_POWDER_VERSION ?? '0.0.0' },
			instructions: INSTRUCTIONS,
			listTools,
			callTool: (name, args) => callTool(name, args, ctx),
		})
	} catch (err) {
		console.error('[mcp] request failed:', err instanceof Error ? err.message : err)
		response = rpcError(null, RPC.INTERNAL_ERROR, 'internal error')
	}
	if (!response)
		return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } })
	// Invalid requests are still HTTP 200 per JSON-RPC over HTTP, except a body
	// that is not a JSON-RPC message at all.
	const status = response.error?.code === RPC.INVALID_REQUEST && response.id === null ? 400 : 200
	return json(response, status)
}

// Stateless server: no SSE stream to open and no session to delete.
function notAllowed(): Response {
	return new Response(
		'Method Not Allowed: this MCP endpoint only takes POST (stateless, no SSE).',
		{
			status: 405,
			headers: { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' },
		},
	)
}

export async function GET() {
	return notAllowed()
}

export async function DELETE() {
	return notAllowed()
}
