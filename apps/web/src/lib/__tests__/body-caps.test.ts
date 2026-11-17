import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '../../proxy'
import {
	BodyTooLargeError,
	MAX_BODY_BYTES,
	MAX_WEBHOOK_BYTES,
	readJsonCapped,
	readTextCapped,
} from '../http-limits'

const post = (path: string, headers: Record<string, string>) =>
	proxy(new NextRequest(`https://powder.sh${path}`, { method: 'POST', headers: { host: 'powder.sh', 'sec-fetch-site': 'same-origin', cookie: 'a=b', ...headers } }))

describe('body caps', () => {
	it('auth routes: Content-Length over 1 MB -> 413', () => {
		expect(post('/api/auth/sign-in/social', { 'content-length': String(1024 * 1024 + 1) }).status).toBe(413)
		expect(post('/api/auth/sign-in/social', { 'content-length': '2000' }).status).toBe(200)
	})
	it('other api routes: over 1 MB -> 413, under passes (same cap as the chunked-body buffer)', () => {
		expect(post('/api/tokens', { 'content-length': String(1024 * 1024 + 1) }).status).toBe(413)
		expect(post('/api/tokens', { 'content-length': String(512 * 1024) }).status).toBe(200)
	})
	it('chunked bodies are bounded too: next.config caps the proxy body buffer at the same value', async () => {
		const { default: cfg } = await import('../../../next.config')
		expect(cfg.experimental?.proxyClientMaxBodySize).toBe(MAX_BODY_BYTES)
		expect(MAX_BODY_BYTES).toBe(1024 * 1024)
		// The cap must cover the largest legitimate body (GitHub webhook reader).
		expect(MAX_BODY_BYTES).toBeGreaterThanOrEqual(MAX_WEBHOOK_BYTES)
	})
	it('readJsonCapped stops a chunked body without Content-Length', async () => {
		const chunk = new Uint8Array(64 * 1024).fill(32)
		let sent = 0
		const body = new ReadableStream({
			pull(c) {
				sent++
				c.enqueue(chunk)
				if (sent > 1000) c.close()
			},
		})
		const req = new Request('http://x', { method: 'POST', body, duplex: 'half' } as RequestInit)
		await expect(readJsonCapped(req, 256 * 1024)).rejects.toBeInstanceOf(BodyTooLargeError)
		expect(sent).toBeLessThan(20)
	})
	it('readTextCapped stops a chunked 1 MB+ webhook body; the webhook route never calls req.text()', async () => {
		const chunk = new Uint8Array(256 * 1024).fill(32)
		let sent = 0
		const body = new ReadableStream({
			pull(c) {
				sent++
				c.enqueue(chunk)
				if (sent > 1000) c.close()
			},
		})
		const req = new Request('http://x', { method: 'POST', body, duplex: 'half' } as RequestInit)
		await expect(readTextCapped(req, MAX_WEBHOOK_BYTES)).rejects.toBeInstanceOf(BodyTooLargeError)
		expect(sent).toBeLessThan(10)
		const route = readFileSync(join(__dirname, '../../app/api/webhooks/deploy/[token]/route.ts'), 'utf8')
		expect(route).not.toMatch(/\.text\(\)/)
		// app token, group token, unknown token
		expect(route.match(/readTextCapped\(req, MAX_WEBHOOK_BYTES\)/g)).toHaveLength(3)
	})
	it('readJsonCapped parses a normal body', async () => {
		const req = new Request('http://x', { method: 'POST', body: '{"a":1}' })
		expect(await readJsonCapped(req)).toEqual({ a: 1 })
	})
	it('compose caps memory and pids on powder and worker', () => {
		const yml = readFileSync(join(__dirname, '../../../../../docker-compose.yml'), 'utf8')
		expect(yml.match(/mem_limit: 1g/g)).toHaveLength(2)
		expect(yml.match(/pids_limit: 512/g)).toHaveLength(2)
	})
})
