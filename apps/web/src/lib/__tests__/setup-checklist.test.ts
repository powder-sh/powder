import { describe, expect, it } from 'vitest'
import {
	BACKUP_ENV_KEYS,
	type ChecklistInput,
	type ChecklistServer,
	buildChecklist,
	checklistComplete,
	envSet,
} from '../setup-checklist'

const srv = (over: Partial<ChecklistServer> = {}): ChecklistServer => ({
	id: 'server',
	name: 'server',
	status: 'connected',
	proxy: 'traefik',
	baseDomain: 'apps.example.com',
	checkGreen: true,
	dnsState: 'ok',
	...over,
})

const allGood: ChecklistInput = {
	githubOAuth: true,
	servers: [srv()],
	backups: true,
	notifyWebhook: true,
	adminPersisted: true,
}

const state = (input: ChecklistInput, id: string) =>
	buildChecklist(input).find((i) => i.id === id)?.state

describe('first-run checklist', () => {
	it('all green is complete', () => {
		expect(checklistComplete(buildChecklist(allGood))).toBe(true)
	})
	it('no servers: the server row and base domain are missing', () => {
		const input = { ...allGood, servers: [] }
		for (const id of ['server', 'base-domain']) {
			expect(state(input, id), id).toBe('missing')
		}
	})
	it('unchecked results are unknown, not done', () => {
		const input = {
			...allGood,
			servers: [srv({ checkGreen: null, dnsState: null, status: 'pending' })],
		}
		expect(state(input, 'server')).toBe('unknown')
		expect(state(input, 'base-domain')).toBe('unknown')
		expect(checklistComplete(buildChecklist(input))).toBe(false)
	})
	it('failures link to the server page', () => {
		const items = buildChecklist({
			...allGood,
			servers: [srv(), srv({ id: 'b2', name: 'b2', checkGreen: false, baseDomain: null })],
		})
		expect(items.find((i) => i.id === 'server')).toMatchObject({
			state: 'missing',
			href: '/servers/b2',
			action: 'open b2',
		})
		expect(items.find((i) => i.id === 'base-domain')).toMatchObject({
			state: 'missing',
			href: '/servers/b2',
		})
	})
	it('one server row: its state is the worst of added, reachable and checked', () => {
		const unreachable = srv({ id: 'u', name: 'u', status: 'unreachable', checkGreen: false })
		const row = buildChecklist({ ...allGood, servers: [srv(), unreachable] }).find(
			(i) => i.id === 'server',
		)
		expect(row).toMatchObject({ state: 'missing', action: 'open u', href: '/servers/u' })
		expect(row?.detail).toContain("can't reach u")
		const ids = buildChecklist(allGood).map((i) => i.id)
		expect(ids.filter((id) => id === 'ssh' || id === 'server-check')).toEqual([])
		expect(ids.slice(0, 2)).toEqual(['server', 'github-oauth'])
	})
	it('base domain only matters on traefik servers', () => {
		const input = {
			...allGood,
			servers: [srv(), srv({ id: 'n', proxy: 'nginx', baseDomain: null, dnsState: null })],
		}
		expect(state(input, 'base-domain')).toBe('done')
	})
	it('no base domain is fine when every app on the server has its own domain', () => {
		const own = srv({
			id: 'm',
			name: 'm',
			baseDomain: null,
			dnsState: null,
			needsDefaultHost: false,
		})
		const alone = buildChecklist({ ...allGood, servers: [own] }).find((i) => i.id === 'base-domain')
		expect(alone).toMatchObject({ state: 'done' })
		expect(alone?.detail).toContain('not needed')
		expect(state({ ...allGood, servers: [srv(), own] }, 'base-domain')).toBe('done')
		const needs = srv({ id: 'p', name: 'p', baseDomain: null, needsDefaultHost: true })
		const row = buildChecklist({ ...allGood, servers: [own, needs] }).find(
			(i) => i.id === 'base-domain',
		)
		expect(row).toMatchObject({ state: 'missing', href: '/servers/p' })
		expect(row?.detail).toBe('no base domain on p')
	})
	it('env items', () => {
		expect(state({ ...allGood, backups: false }, 'backups')).toBe('missing')
		expect(state({ ...allGood, notifyWebhook: false }, 'notify-webhook')).toBe('missing')
		expect(state({ ...allGood, adminPersisted: false }, 'admin-persisted')).toBe('missing')
		const admin = buildChecklist({ ...allGood, adminPersisted: false }).find(
			(i) => i.id === 'admin-persisted',
		)
		expect(admin?.detail).toContain('sudo bin/install.sh --set-admin <your user id>')
		expect(state({ ...allGood, githubOAuth: false }, 'github-oauth')).toBe('missing')
	})
	it('envSet needs every key non-empty', () => {
		const env = Object.fromEntries(BACKUP_ENV_KEYS.map((k) => [k, 'x']))
		expect(envSet(env, BACKUP_ENV_KEYS)).toBe(true)
		expect(envSet({ ...env, POWDER_BACKUP_KEY: ' ' }, BACKUP_ENV_KEYS)).toBe(false)
	})
})
