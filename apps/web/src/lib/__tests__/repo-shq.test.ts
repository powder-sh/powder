import { describe, expect, it, vi } from 'vitest'
import { appCheckoutProbeShell } from '../app-checkout'

const cmds: string[] = []
let workingDir = ''
vi.mock('@/lib/access', () => ({ requireContainerAccess: async () => ({ server: { id: 's' }, user: { id: 'u' } }) }))
vi.mock('@/lib/keygen', () => ({ generateDeployKey: vi.fn() }))
vi.mock('@/lib/repos', () => ({
	createRepo: vi.fn(),
	decryptWebhookSecret: () => 'x',
	deleteRepo: vi.fn(),
	getRepoFor: async () => ({ repoUrl: 'r', branch: 'main', deployKeyPub: 'k', webhookToken: 't' }),
}))
vi.mock('@/lib/ssh', () => ({
	deleteRemoteFile: vi.fn(),
	writeFileSecret: vi.fn(),
	inspectContainer: async () => ({ compose: { workingDir } }),
}))
// the checkout probe (lib/app-checkout.ts via lib/ssh/git.ts) runs through this
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		cmds.push(cmd)
		return { code: 0, stdout: '::app-checkout:: 0 0 0 0\n', stderr: '' }
	},
}))

import { GET } from '../../app/api/servers/[id]/containers/[name]/repo/route'

describe('repo route quoting', () => {
	const get = async () => {
		cmds.length = 0
		const req = Object.assign(new Request('http://x/api'), { nextUrl: new URL('http://x/api') }) as never
		return (await GET(req, { params: Promise.resolve({ id: 's', name: 'x' }) })).json()
	}
	it('a working dir with shell characters runs no command and reads as unknown', async () => {
		workingDir = '/opt/apps/x$(touch /tmp/pwn)`id`"y'
		const body = await get()
		expect(cmds).toEqual([])
		expect(body).toMatchObject({ isCheckout: false, checkout: { kind: 'unknown' } })
		expect(body.cloneAllowed).toBe(false)
		expect(body.checkoutNote).toBe("powder could not read the app's layout on the server (/opt/apps/x$(touch /tmp/pwn)`id`\"y).")
	})
	it('a plain working dir is probed with the single-quoted authority probe', async () => {
		workingDir = '/opt/apps/x'
		const body = await get()
		expect(cmds).toEqual([appCheckoutProbeShell('/opt/apps/x')])
		expect(cmds[0]).toContain("cd '/opt/apps/x'")
		expect(body).toMatchObject({ isCheckout: false, checkout: { kind: 'none', srcExists: false }, cloneAllowed: true })
	})
})
