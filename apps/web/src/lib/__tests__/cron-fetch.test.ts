import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({}))
vi.mock('../ssh', () => ({}))
import { readBodyCapped } from '../cron-scheduler'

describe('cron http fetch', () => {
	it('reads at most the cap from an endless body, then cancels the stream', async () => {
		let cancelled = false
		let pulls = 0
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				pulls++
				c.enqueue(new TextEncoder().encode('x'.repeat(1024)))
			},
			cancel() {
				cancelled = true
			},
		})
		const out = await readBodyCapped(new Response(body), 4096)
		expect(out.length).toBeLessThanOrEqual(4096)
		expect(out.length).toBeGreaterThan(0)
		expect(cancelled).toBe(true)
		expect(pulls).toBeLessThan(20)
	})
	it('returns a short body whole', async () => {
		expect(await readBodyCapped(new Response('hello'), 4096)).toBe('hello')
	})
	it('fireHttp does not follow redirects and treats 3xx as failure', () => {
		const src = readFileSync(join(__dirname, '../cron-scheduler.ts'), 'utf8')
		expect(src).toContain("redirect: 'manual'")
		expect(src).toContain('ok: res.ok && !isRedirect')
	})
})
