import { describe, expect, it } from 'vitest'
import { singleFlight } from '../single-flight'

function gate() {
	let open!: () => void
	const p = new Promise<void>((r) => {
		open = r
	})
	return { p, open }
}

describe('singleFlight', () => {
	it('a request during a read gets one follow-up read after it', async () => {
		const gates = [gate(), gate()]
		let calls = 0
		const run = singleFlight(() => gates[calls++]?.p ?? Promise.resolve())
		const first = run(true)
		const a = run(true)
		const b = run(true)
		expect(a).toBe(b)
		await Promise.resolve()
		expect(calls).toBe(1)
		gates[0]?.open()
		await first
		await new Promise((r) => setTimeout(r, 0))
		expect(calls).toBe(2)
		gates[1]?.open()
		await a
		expect(calls).toBe(2)
	})
	it('a poll during a read joins it instead of queueing', async () => {
		const g = gate()
		let calls = 0
		const run = singleFlight(() => {
			calls++
			return g.p
		})
		const first = run(false)
		expect(run(false)).toBe(first)
		g.open()
		await first
		expect(calls).toBe(1)
	})
	it('a failed read does not block the next one', async () => {
		let calls = 0
		const run = singleFlight(async () => {
			calls++
			if (calls === 1) throw new Error('down')
		})
		await run(true)
		await run(true)
		expect(calls).toBe(2)
	})
})
