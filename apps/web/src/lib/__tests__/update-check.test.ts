import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	UPGRADE_DOCS_PATH,
	checkForUpdate,
	isNewer,
	type MetaStore,
	resetUpdateCheckCache,
	type UpdateRecord,
} from '../update-check'

function memStore(initial: UpdateRecord | null = null) {
	const s = { rec: initial, writes: 0 }
	const store: MetaStore = {
		read: async () => s.rec,
		write: async (r) => {
			s.rec = r
			s.writes++
		},
	}
	return { s, store }
}

const release = (tag: string) =>
	vi.fn(async () => new Response(JSON.stringify({ tag_name: tag, html_url: `https://github.com/powder-sh/powder/releases/tag/${tag}` })))

describe('update check', () => {
	beforeEach(() => {
		resetUpdateCheckCache()
		process.env.NEXT_PUBLIC_POWDER_VERSION = '0.9.0'
		delete process.env.POWDER_UPDATE_CHECK
	})
	afterEach(() => {
		delete process.env.POWDER_UPDATE_CHECK
	})

	it('compares semver', () => {
		expect(isNewer('0.10.0', '0.9.0')).toBe(true)
		expect(isNewer('1.0.0', '0.9.9')).toBe(true)
		expect(isNewer('0.9.0', '0.9.0')).toBe(false)
		expect(isNewer('0.8.9', '0.9.0')).toBe(false)
		expect(isNewer('garbage', '0.9.0')).toBe(false)
	})

	it('records a newer release with a User-Agent and a timeout signal', async () => {
		const { s, store } = memStore()
		const fetchFn = release('v0.10.0')
		const rec = await checkForUpdate({ fetchFn: fetchFn as unknown as typeof fetch, store })
		expect(rec?.latest).toBe('0.10.0')
		expect(s.rec?.latest).toBe('0.10.0')
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://api.github.com/repos/powder-sh/powder/releases/latest')
		expect((init.headers as Record<string, string>)['User-Agent']).toBe('powder/0.9.0')
		expect(init.signal).toBeDefined()
	})

	it('stores the same version when already current', async () => {
		const { store } = memStore()
		const rec = await checkForUpdate({ fetchFn: release('v0.9.0') as unknown as typeof fetch, store })
		expect(rec?.latest).toBe('0.9.0')
		expect(isNewer(rec?.latest ?? '', '0.9.0')).toBe(false)
	})

	it('does not refetch within 24 h', async () => {
		const { store } = memStore()
		const fetchFn = release('v0.10.0')
		await checkForUpdate({ fetchFn: fetchFn as unknown as typeof fetch, store })
		resetUpdateCheckCache()
		await checkForUpdate({ fetchFn: fetchFn as unknown as typeof fetch, store })
		expect(fetchFn).toHaveBeenCalledTimes(1)
		resetUpdateCheckCache()
		await checkForUpdate({ fetchFn: fetchFn as unknown as typeof fetch, store, now: Date.now() + 25 * 3600_000 })
		expect(fetchFn).toHaveBeenCalledTimes(2)
	})

	it('never throws on a network error and keeps the old value', async () => {
		const old: UpdateRecord = { latest: '0.9.5', checked_at: new Date(Date.now() - 48 * 3600_000).toISOString() }
		const { store } = memStore(old)
		const fetchFn = vi.fn(async () => {
			throw new Error('offline')
		})
		await expect(checkForUpdate({ fetchFn: fetchFn as unknown as typeof fetch, store })).resolves.toEqual(old)
	})

	it('does nothing when POWDER_UPDATE_CHECK=off', async () => {
		process.env.POWDER_UPDATE_CHECK = 'off'
		const { s, store } = memStore()
		const fetchFn = release('v9.9.9')
		expect(await checkForUpdate({ fetchFn: fetchFn as unknown as typeof fetch, store })).toBeNull()
		expect(fetchFn).not.toHaveBeenCalled()
		expect(s.writes).toBe(0)
	})

	it('returns the stale record at once while the refresh is still running', async () => {
		const old: UpdateRecord = { latest: '0.9.5', checked_at: new Date(Date.now() - 48 * 3600_000).toISOString() }
		const { store } = memStore(old)
		const fetchFn = vi.fn(() => new Promise<Response>(() => {})) // never settles
		const rec = await checkForUpdate({ fetchFn: fetchFn as unknown as typeof fetch, store })
		expect(rec).toEqual(old)
		expect(fetchFn).toHaveBeenCalledTimes(1)
		// a second render during the refresh neither blocks nor starts another fetch
		expect(await checkForUpdate({ fetchFn: fetchFn as unknown as typeof fetch, store })).toEqual(old)
		expect(fetchFn).toHaveBeenCalledTimes(1)
	})

	it('memoizes a failure: no new fetch within the backoff', async () => {
		const { store } = memStore()
		const fetchFn = vi.fn(async () => {
			throw new Error('offline')
		})
		expect(await checkForUpdate({ fetchFn: fetchFn as unknown as typeof fetch, store })).toBeNull()
		expect(await checkForUpdate({ fetchFn: fetchFn as unknown as typeof fetch, store })).toBeNull()
		expect(fetchFn).toHaveBeenCalledTimes(1)
	})

	it('the notice links to the upgrading page, which exists', async () => {
		const { existsSync } = await import('node:fs')
		expect(UPGRADE_DOCS_PATH).toBe('/docs/upgrading')
		expect(existsSync(new URL('../../../content/docs/upgrading.md', import.meta.url))).toBe(true)
	})

	it('the dashboard layout wraps UpdateBanner in Suspense with a null fallback', async () => {
		const { readFileSync } = await import('node:fs')
		const src = readFileSync(new URL('../../app/(dashboard)/layout.tsx', import.meta.url), 'utf8')
		expect(src).toMatch(/<Suspense fallback=\{null\}>\s*<UpdateBanner \/>\s*<\/Suspense>/)
	})
})
