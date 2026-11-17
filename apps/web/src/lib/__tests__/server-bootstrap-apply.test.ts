// runBootstrapApply runs only confirmed plan steps: an outdated helper is planned
// as replace-<bin>, so it is replaced only when that id is sent, never by an
// install id or a confirm of the other steps.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ commands: [] as string[], uploads: [] as string[] }))

vi.mock('../domain-ownership', () => ({}))
vi.mock('../server-helpers', () => ({
	shippedHelperShas: () => ({ migrate: 'a'.repeat(64), imagePrune: 'b'.repeat(64) }),
	shippedHelper: (key: string) =>
		key === 'migrate' ? { content: 'm', sha256: 'a'.repeat(64) } : { content: 'p', sha256: 'b'.repeat(64) },
}))
vi.mock('../ssh', () => ({
	runCommand: async (_server: unknown, command: string) => {
		if (command.includes('echo "uid=$(id -u)"')) {
			return {
				code: 0,
				stderr: '',
				stdout: [
					'uid=0',
					'docker=present',
					'compose=present',
					'net_web=present',
					'net_internal=present',
					'traefik=absent',
					'apps_dir=present',
					'dynamic_dir=present',
					'port_80=busy',
					'port_443=busy',
					'nginx=present',
					'nginx_bin=present',
					'nginx_unit=enabled',
					'helper_migrate=present',
					// an operator's locally patched copy
					`helper_migrate_sha=${'c'.repeat(64)}`,
					'helper_image_prune=absent',
					'helper_resource_guard=absent',
					'cmd_git=present',
					'cmd_flock=present',
					'prune_cron=absent',
					'===TRAEFIK_INSPECT===',
				].join('\n'),
			}
		}
		state.commands.push(command)
		return { code: 0, stdout: 'ok', stderr: '' }
	},
	writeFileViaSftp: async (_s: unknown, path: string) => {
		state.uploads.push(path)
	},
}))

import { confirmedStepIds } from '../server-bootstrap'
import { runBootstrapApply } from '../server-bootstrap-run'

const server = { id: 'server', proxy: 'nginx' } as never

beforeEach(() => {
	state.commands = []
	state.uploads = []
})

describe('runBootstrapApply: replacing a helper is opt-in', () => {
	it('plans the outdated helper as replace-powder-migrate', async () => {
		const { after } = await runBootstrapApply(server, [])
		const migrate = after.plan.steps.find((s) => s.helper === 'migrate')
		expect(migrate?.id).toBe('replace-powder-migrate')
		expect(migrate?.replaces).toBe(true)
	})
	it('confirming the adds (and even install-powder-migrate) never replaces it', async () => {
		const { steps } = await runBootstrapApply(server, [
			'install-powder-migrate',
			'install-powder-image-prune',
			'install-image-prune-cron',
		])
		expect(steps.map((s) => s.id)).toEqual(['install-powder-image-prune', 'install-image-prune-cron'])
		expect(state.uploads.some((p) => p.includes('powder-migrate'))).toBe(false)
	})
	it('replaces it only when replace-powder-migrate is sent', async () => {
		const { steps } = await runBootstrapApply(server, ['replace-powder-migrate'])
		expect(steps.map((s) => s.id)).toEqual(['replace-powder-migrate'])
		expect(state.uploads.some((p) => p.includes('/usr/local/bin/.powder-migrate.'))).toBe(true)
	})
})

describe('confirmedStepIds (what "run these" sends)', () => {
	const steps = [
		{ id: 'network-web', title: '', command: '' },
		{ id: 'replace-powder-migrate', title: '', command: '', replaces: true },
		{ id: 'install-powder-image-prune', title: '', command: '' },
	] as const
	it('sends every add and no replace when nothing is ticked', () => {
		expect(confirmedStepIds(steps, [])).toEqual(['network-web', 'install-powder-image-prune'])
	})
	it('sends a replace only when its checkbox is ticked', () => {
		expect(confirmedStepIds(steps, ['replace-powder-migrate'])).toEqual([
			'network-web',
			'replace-powder-migrate',
			'install-powder-image-prune',
		])
	})
})
