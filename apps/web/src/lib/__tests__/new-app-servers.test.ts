import { describe, expect, it } from 'vitest'
import { newAppServerChoice } from '../new-app-servers'

const s = (id: string, kind = 'compose', traefik = false) => ({ id, kind, traefik })

describe('/new server choice', () => {
	it('two Traefik servers: shows the picker and preselects nothing', () => {
		const c = newAppServerChoice([s('a', 'compose', true), s('b', 'compose', true)])
		expect(c.showPicker).toBe(true)
		expect(c.selectedId).toBe('')
	})

	it('one eligible server: no picker, that server is picked', () => {
		const c = newAppServerChoice([s('a'), s('r', 'raw-docker')])
		expect(c.showPicker).toBe(false)
		expect(c.selectedId).toBe('a')
		expect(c.ineligible.map((x) => x.id)).toEqual(['r'])
	})

	it('keeps a valid current pick, drops one that is no longer eligible', () => {
		expect(newAppServerChoice([s('a'), s('b')], 'b').selectedId).toBe('b')
		expect(newAppServerChoice([s('a'), s('b')], 'gone').selectedId).toBe('')
	})

	it('only raw-docker servers: nothing eligible, no picker', () => {
		const c = newAppServerChoice([s('r1', 'raw-docker'), s('r2', 'raw-docker')])
		expect(c.eligible).toEqual([])
		expect(c.ineligible).toHaveLength(2)
		expect(c.showPicker).toBe(false)
		expect(c.selectedId).toBe('')
	})
})
