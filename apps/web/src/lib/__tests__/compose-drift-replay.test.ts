import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ComposeDriftStore, type ComposeRange, composeDriftVerdict } from '../deploy/compose-drift-inventory'
import { reportDeployWarningsToHq } from '../hq'

// Replay guard: 14 days of real deploy history (1952 successful git deploys of 80 apps
// on one powder install, app names replaced by app-NN) run through the compose-drift
// rule and the card reporting. One letter per deploy, in time order per app (legend
// in the fixture). The range letters come from comparing each deploy's commit with the
// previous successful deploy's commit on GitHub.
//
// The old rule raised the card on every deploy whose repo compose differed: 1392
// raises on 54 apps. The new rule raises only for a compose change in the deploy's
// range (7) or with no base to compare (1): 8 raises on 5 apps, and a standing
// difference never raises.

type Fixture = { apps: Record<string, string> }
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/compose-drift-history.json'), 'utf8')) as Fixture

const INPUT: Record<string, { differs: boolean; range: ComposeRange }> = {
	o: { differs: false, range: 'unchanged' },
	u: { differs: true, range: 'unchanged' },
	s: { differs: true, range: 'unchanged' }, // same commit again: an empty range
	c: { differs: true, range: 'changed' },
	n: { differs: true, range: 'none' },
}

function memStore(): ComposeDriftStore {
	const rows = new Map<string, 'drift' | 'standing'>()
	return {
		get: async (r) => rows.get(r) ?? null,
		set: async (r, v) => void rows.set(r, v),
		del: async (r) => void rows.delete(r),
		list: async () => [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ref, value]) => ({ ref, value })),
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
	delete process.env.POWDER_STABILITY_CARDS
	delete process.env.POWDER_HQ_INGEST_TOKEN
	delete process.env.POWDER_HQ_GENERIC_URL
})

describe('compose-drift replay of real deploy history', () => {
	const deploys = Object.entries(fixture.apps).flatMap(([app, s]) => [...s].map((c) => ({ app, ...INPUT[c as keyof typeof INPUT] })))

	it('the fixture is the recorded history', () => {
		expect(Object.keys(fixture.apps)).toHaveLength(80)
		expect(deploys).toHaveLength(1952)
		expect(Object.values(fixture.apps).join('')).toMatch(/^[ousnc]+$/)
	})

	it('old rule: 1392 raises on 54 apps; new rule: 8 drift markers on 5 apps, none for a standing difference', () => {
		const oldRaises = deploys.filter((d) => d.differs)
		expect(oldRaises).toHaveLength(1392)
		expect(new Set(oldRaises.map((d) => d.app)).size).toBe(54)
		const drift = deploys.filter((d) => composeDriftVerdict(d.differs, d.range) === 'drift')
		expect(drift).toHaveLength(8)
		expect(drift.filter((d) => d.range === 'changed')).toHaveLength(7)
		expect(new Set(drift.map((d) => d.app)).size).toBe(5)
		expect(deploys.filter((d) => d.differs && d.range === 'unchanged').every((d) => composeDriftVerdict(d.differs, d.range) === 'standing')).toBe(true)
	})

	it('posted cards: every real change raises, nothing else does; each old card is retired at most once', async () => {
		process.env.POWDER_STABILITY_CARDS = 'on'
		process.env.POWDER_HQ_INGEST_TOKEN = 't'
		process.env.POWDER_HQ_GENERIC_URL = 'http://hq/generic'
		const bodies: Record<string, unknown>[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_u: string, i: { body: string }) => {
				bodies.push(JSON.parse(i.body))
				return new Response('ok')
			}),
		)
		const store = memStore()
		const raisedBy: string[] = []
		for (const d of deploys) {
			const before = bodies.length
			await reportDeployWarningsToHq({ app: d.app, server: 'fleet', envRefusedKeys: null, builderFallback: null, composeDrift: composeDriftVerdict(d.differs, d.range) }, store)
			if (bodies.slice(before).some((b) => String(b.source_ref).startsWith('compose-drift:') && !b.resolve)) raisedBy.push(`${d.range}`)
		}
		// raised only by a change in range or the no-base fallback: 8 times, 0 for 1384 standing deploys
		expect(raisedBy).toHaveLength(8)
		expect(raisedBy.filter((r) => r === 'unchanged')).toEqual([])
		const raisedApps = new Set(bodies.filter((b) => String(b.source_ref).startsWith('compose-drift:') && !b.resolve).map((b) => b.source_ref))
		expect(raisedApps.size).toBe(5)
		// the one-time retirement: at most one resolve per app from a standing deploy
		const retires = bodies.filter((b) => String(b.source_ref).startsWith('compose-drift:') && b.resolve && String(b.body).startsWith('standing drift'))
		// (53 of the 54 differing apps; the 54th started with a no-base drift, so its card stays)
		expect(retires).toHaveLength(53)
		expect(new Set(retires.map((b) => b.source_ref)).size).toBe(53)
		// the inventory reopens only when an app joins the standing set: 53 joins, then
		// 1384 standing deploys and 560 matching ones that leave a closed inventory closed
		const inv = bodies.filter((b) => b.source_ref === 'compose-drift-standing:fleet' && !b.resolve)
		expect(inv.filter((b) => b.reopen === true)).toHaveLength(53)
		expect(inv.filter((b) => b.reopen === false).length).toBeGreaterThan(1800)
	})
})
