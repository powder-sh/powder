// powder's override drops NET_RAW from every service of the app's compose.
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { OVERRIDE_CAP_DROP, parseOverrideLabels, renderOverride } from '../compose-override'
import { COMPOSE_RAW_AWK } from '../deploy/fragments'

describe('override cap_drop', () => {
	const ov = renderOverride({
		service: 'shop',
		labels: ['traefik.enable=true'],
		ports: {},
		services: ['shop', 'db', 'worker'],
	}) ?? ''
	it('covers every service, not only the app service', () => {
		expect(OVERRIDE_CAP_DROP).toEqual(['NET_RAW'])
		for (const s of ['shop', 'db', 'worker'])
			expect(ov).toContain(
				`  "${s}":\n${s === 'shop' ? '    labels:\n      - "traefik.enable=true"\n' : ''}    cap_drop:\n      - "NET_RAW"\n`,
			)
	})
	it('keeps the labels readable and is deterministic', () => {
		expect(parseOverrideLabels(ov, 'shop')).toEqual(['traefik.enable=true'])
		expect(
			renderOverride({
				service: 'shop',
				labels: ['traefik.enable=true'],
				ports: {},
				services: ['shop', 'db', 'worker'],
			}),
		).toBe(ov)
	})
	it('passes the raw compose guard as a generated file', () => {
		const r = spawnSync('awk', ['-v', 'gen=1', COMPOSE_RAW_AWK], { input: ov, encoding: 'utf8' })
		expect(r.stdout).toBe('')
		expect(r.status).toBe(0)
	})
	it('callers without a service list get no override', () => {
		expect(renderOverride({ service: 'shop', labels: null, ports: {} })).toBeNull()
	})
})
