// MCP over Streamable HTTP, stateless JSON-only subset: one JSON-RPC 2.0
// message per POST, answered with one JSON body (no SSE, no sessions).
// Pure: no DB, no Next imports, so it is unit-tested on its own.
// Spec: https://modelcontextprotocol.io/specification/2025-06-18

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

export type JsonRpcId = string | number | null

export const RPC = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
} as const

interface ToolAnnotations {
	title?: string
	readOnlyHint: boolean
	destructiveHint: boolean
	idempotentHint: boolean
	openWorldHint: boolean
}

export interface ToolDef {
	name: string
	description: string
	inputSchema: {
		type: 'object'
		properties: Record<string, unknown>
		required?: string[]
		additionalProperties?: boolean
	}
	annotations: ToolAnnotations
}

export interface ToolResult {
	content: { type: 'text'; text: string }[]
	isError?: boolean
}

export interface McpHandlers {
	serverInfo: { name: string; version: string }
	instructions?: string
	listTools(): ToolDef[]
	/** null = unknown tool (JSON-RPC error). Tool failures come back as isError results. */
	callTool(name: string, args: Record<string, unknown>): Promise<ToolResult | null>
}

export interface JsonRpcResponse {
	jsonrpc: '2.0'
	id: JsonRpcId
	result?: unknown
	error?: { code: number; message: string }
}

export function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: '2.0', id, error: { code, message } }
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id, result }
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validId(v: unknown): v is string | number {
	return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
}

function negotiateVersion(requested: unknown): string {
	return typeof requested === 'string' &&
		(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
		? requested
		: LATEST_PROTOCOL_VERSION
}

/**
 * Handles one parsed JSON-RPC message. Returns the response to send, or null
 * when the message needs no response (a notification, or a client response),
 * which the transport answers with 202 Accepted.
 */
export async function handleMcpMessage(
	msg: unknown,
	h: McpHandlers,
): Promise<JsonRpcResponse | null> {
	// Batches were removed from MCP in 2025-06-18; stateless servers refuse them.
	if (Array.isArray(msg))
		return rpcError(null, RPC.INVALID_REQUEST, 'batch requests are not supported')
	if (!isObject(msg) || msg.jsonrpc !== '2.0') {
		return rpcError(null, RPC.INVALID_REQUEST, 'invalid request: expected a JSON-RPC 2.0 object')
	}
	// A response from the client (we never send requests to it): accept, ignore.
	if (!('method' in msg) && ('result' in msg || 'error' in msg)) return null
	if (typeof msg.method !== 'string')
		return rpcError(null, RPC.INVALID_REQUEST, 'invalid request: method must be a string')
	const isNotification = !('id' in msg)
	if (isNotification) return null
	if (!validId(msg.id))
		return rpcError(null, RPC.INVALID_REQUEST, 'invalid request: id must be a string or number')
	const id = msg.id
	const params = isObject(msg.params) ? msg.params : {}

	switch (msg.method) {
		case 'initialize':
			return rpcResult(id, {
				protocolVersion: negotiateVersion(params.protocolVersion),
				capabilities: { tools: { listChanged: false } },
				serverInfo: h.serverInfo,
				...(h.instructions ? { instructions: h.instructions } : {}),
			})
		case 'ping':
			return rpcResult(id, {})
		case 'tools/list':
			return rpcResult(id, { tools: h.listTools() })
		case 'tools/call': {
			if (typeof params.name !== 'string')
				return rpcError(id, RPC.INVALID_PARAMS, 'tools/call needs params.name')
			if (params.arguments !== undefined && !isObject(params.arguments)) {
				return rpcError(id, RPC.INVALID_PARAMS, 'params.arguments must be an object')
			}
			const result = await h.callTool(
				params.name,
				(params.arguments as Record<string, unknown>) ?? {},
			)
			if (!result)
				return rpcError(id, RPC.INVALID_PARAMS, `unknown tool: ${params.name.slice(0, 64)}`)
			return rpcResult(id, result)
		}
		default:
			return rpcError(id, RPC.METHOD_NOT_FOUND, `method not found: ${msg.method.slice(0, 64)}`)
	}
}
