import { describe, expect, it } from 'vitest'
import {
	SUPERSEDED_MARKER,
	hasMarkerLine,
	supersedeCheckShell,
	supersededMarkerFor,
	swapGateShell,
} from '../deploy-supersede'
import {
	COMPOSE_CHANGED_MARKER,
	composeChangedMarkerFor,
	composeHashGuardShell,
} from '../deploy/compose-hash'

// `RUN echo __POWDER_SUPERSEDED__` in a build printed the marker powder
// searched the output for. The script's markers now carry the run's nonce.

const N = 'a1b2c3d4e5f6a1b2c3d4e5f6'

describe('nonce-tagged deploy markers', () => {
	it('the script fragments print the nonce-tagged markers', () => {
		expect(supersedeCheckShell('/s', 5, N)).toContain(`__POWDER_SUPERSEDED_${N}__ a newer deploy`)
		expect(swapGateShell('/s', 5, 'app', N)).toContain(`__POWDER_SUPERSEDED_${N}__`)
		const g = composeHashGuardShell('', 'b'.repeat(64), 'x', true, 'app', false, N)
		expect(g).toContain(`__POWDER_COMPOSE_CHANGED_${N}__`)
		expect(g).not.toContain(COMPOSE_CHANGED_MARKER)
	})
	it('no nonce keeps the plain markers', () => {
		expect(supersededMarkerFor('')).toBe(SUPERSEDED_MARKER)
		expect(composeChangedMarkerFor('')).toBe(COMPOSE_CHANGED_MARKER)
	})
	it('only a whole-line marker counts', () => {
		const m = supersededMarkerFor(N)
		expect(hasMarkerLine(`x\n${m} a newer deploy\n`, m)).toBe(true)
		expect(hasMarkerLine(`${m}\n`, m)).toBe(true)
		expect(hasMarkerLine(`${SUPERSEDED_MARKER} fake\n`, m)).toBe(false)
		expect(hasMarkerLine(`#5 echo ${m}\n`, m)).toBe(false)
	})
})
