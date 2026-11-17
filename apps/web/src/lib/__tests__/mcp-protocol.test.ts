import { describe, expect, it, vi } from 'vitest'
import { LATEST_PROTOCOL_VERSION, type McpHandlers, RPC, handleMcpMessage } from '../mcp/protocol'

const handlers = (over: Partial<McpHandlers> = {}): McpHandlers => ({
	serverInfo: { name: 'powder', version: '1.2.3' },
	instructions: 'hi',
	listTools: () => [
		{
			name: 't',
			description: 'd',
			inputSchema: { type: 'object', properties: {} },
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
	],
	callTool: async (name) => (name === 't' ? { content: [{ type: 'text', text: 'ok' }] } : null),
	...over,
})

describe('MCP JSON-RPC shape', () => {
	it('initialize negotiates the version and declares tools', async () => {
		const r = await handleMcpMessage(
			{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
			handlers(),
		)
		expect(r).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: {
				protocolVersion: '2025-03-26',
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'powder', version: '1.2.3' },
				instructions: 'hi',
			},
		})
		const unknown = await handleMcpMessage(
			{ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '1999-01-01' } },
			handlers(),
		)
		expect((unknown?.result as { protocolVersion: string }).protocolVersion).toBe(
			LATEST_PROTOCOL_VERSION,
		)
	})
	it('ping and tools/list', async () => {
		expect(await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }, handlers())).toEqual({
			jsonrpc: '2.0',
			id: 2,
			result: {},
		})
		const l = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, handlers())
		expect((l?.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['t'])
	})
	it('tools/call passes arguments and returns the result', async () => {
		const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
		const r = await handleMcpMessage(
			{ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 't', arguments: { a: 1 } } },
			handlers({ callTool }),
		)
		expect(callTool).toHaveBeenCalledWith('t', { a: 1 })
		expect(r?.result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
	})
	it('unknown tool, bad arguments and unknown method are JSON-RPC errors', async () => {
		const u = await handleMcpMessage(
			{ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } },
			handlers(),
		)
		expect(u?.error?.code).toBe(RPC.INVALID_PARAMS)
		const a = await handleMcpMessage(
			{ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 't', arguments: [1] } },
			handlers(),
		)
		expect(a?.error?.code).toBe(RPC.INVALID_PARAMS)
		const m = await handleMcpMessage(
			{ jsonrpc: '2.0', id: 7, method: 'resources/list' },
			handlers(),
		)
		expect(m).toMatchObject({ id: 7, error: { code: RPC.METHOD_NOT_FOUND } })
	})
	it('notifications and client responses get no response', async () => {
		expect(
			await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, handlers()),
		).toBeNull()
		expect(await handleMcpMessage({ jsonrpc: '2.0', id: 9, result: {} }, handlers())).toBeNull()
	})
	it('rejects batches, non-2.0 and malformed ids', async () => {
		expect(
			(await handleMcpMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }], handlers()))?.error
				?.code,
		).toBe(RPC.INVALID_REQUEST)
		expect((await handleMcpMessage({ id: 1, method: 'ping' }, handlers()))?.error?.code).toBe(
			RPC.INVALID_REQUEST,
		)
		expect(
			(await handleMcpMessage({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, handlers()))?.error
				?.code,
		).toBe(RPC.INVALID_REQUEST)
		expect((await handleMcpMessage('ping', handlers()))?.error?.code).toBe(RPC.INVALID_REQUEST)
	})
})
