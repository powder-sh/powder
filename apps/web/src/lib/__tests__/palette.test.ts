import { describe, expect, it } from 'vitest'
import { createEnterPending, createPaletteSearch, firstPaletteValue, paletteAnswersQuery } from '../palette'

describe('command palette first result', () => {
	it('selects the first item in display order so Enter opens it', () => {
		expect(firstPaletteValue({ projects: [{ id: 'a' }], deploys: [{ id: 'd' }], actions: [] })).toBe('project:a')
		expect(firstPaletteValue({ projects: [], deploys: [{ id: 'd' }], actions: [{ id: 'x' }] })).toBe('deploy:d')
		expect(firstPaletteValue({ projects: [], deploys: [], actions: [{ id: 'x' }] })).toBe('action:x')
		expect(firstPaletteValue({ projects: [], deploys: [], actions: [] })).toBe('')
	})
})

describe('command palette search', () => {
	const deferred = <T,>() => {
		let resolve!: (v: T) => void
		const promise = new Promise<T>((r) => {
			resolve = r
		})
		return { promise, resolve }
	}

	it('an older answer that lands after a newer one is dropped, and its request aborted', async () => {
		const pending = new Map<string, { resolve: (v: string) => void; signal: AbortSignal }>()
		const search = createPaletteSearch<string>((q, signal) => {
			const d = deferred<string>()
			pending.set(q, { resolve: d.resolve, signal })
			return d.promise
		})
		const slow = search.run('zo')
		const fast = search.run('zorb')
		expect(pending.get('zo')?.signal.aborted).toBe(true)
		pending.get('zorb')?.resolve('zorb results')
		expect(await fast).toEqual({ q: 'zorb', data: 'zorb results' })
		pending.get('zo')?.resolve('zo results')
		expect(await slow).toBeNull()
	})

	it('cancel (the palette closing) drops the answer in flight', async () => {
		const d = deferred<string>()
		const search = createPaletteSearch<string>(() => d.promise)
		const r = search.run('zorb')
		search.cancel()
		d.resolve('late')
		expect(await r).toBeNull()
	})

	it('a failed fetch is dropped, not thrown', async () => {
		const search = createPaletteSearch<string>(async () => {
			throw new Error('offline')
		})
		expect(await search.run('zorb')).toBeNull()
	})

	it('Enter opens an item only when the list answers the query in the search field', () => {
		expect(paletteAnswersQuery('zorb', { q: 'zorb', data: {} })).toBe(true)
		// typed on while the previous list is still on screen
		expect(paletteAnswersQuery('zorbw', { q: 'zorb', data: {} })).toBe(false)
		// reopened: nothing answered yet
		expect(paletteAnswersQuery('', null)).toBe(false)
	})
})

describe('command palette Enter before the answer', () => {
	const ans = (q: string) => ({ q, data: {} })

	it('the answer to the query Enter was pressed for opens its first item, once', () => {
		const enter = createEnterPending()
		enter.press('zorb')
		expect(enter.take('zorb', ans('zo'))).toBe(false)
		expect(enter.take('zorb', ans('zorb'))).toBe(true)
		expect(enter.take('zorb', ans('zorb'))).toBe(false)
	})

	it('Enter, a failed search, then more typing: the next answer does not open anything', () => {
		const enter = createEnterPending()
		enter.press('zo')
		enter.failed('zo')
		enter.queryChanged('zor')
		enter.queryChanged('zorb')
		expect(enter.take('zorb', ans('zorb'))).toBe(false)
	})

	it('a failed search forgets the Enter even when the query stays the same', () => {
		const enter = createEnterPending()
		enter.press('zorb')
		enter.failed('zorb')
		expect(enter.take('zorb', ans('zorb'))).toBe(false)
	})

	it('typing after Enter forgets it, even back to the same query', () => {
		const enter = createEnterPending()
		enter.press('zorb')
		enter.queryChanged('zorbw')
		enter.queryChanged('zorb')
		expect(enter.take('zorb', ans('zorb'))).toBe(false)
	})

	it('an older query failing or being dropped leaves an Enter for the newer one alone', () => {
		const enter = createEnterPending()
		enter.queryChanged('zorb')
		enter.press('zorb')
		enter.failed('zo')
		expect(enter.take('zorb', ans('zorb'))).toBe(true)
	})
})
