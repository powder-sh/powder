// An app delete removes the proxy redirects powder wrote for the app (lib/domain-redirects.ts
// removeAppRedirects): left behind, Traefik keeps redirecting the old hostnames at
// priority 300, above a later app given the same host. Invented names only.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ commands: [] as string[], code: 0 }))
vi.mock('../ssh', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		h.commands.push(cmd)
		return { code: h.code, stdout: '/srv/nginx/conf.d', stderr: h.code ? 'rm: cannot remove: read-only file system' : '' }
	},
}))

import { removeAppRedirects } from '../domain-redirects'

const srv = (proxy: 'traefik' | 'nginx' | 'nginx-container' | null) =>
	({ id: 'boxa', host: 'h', user: 'root', proxy }) as never

beforeEach(() => {
	h.commands = []
	h.code = 0
})

describe('removeAppRedirects', () => {
	it('Traefik: removes the app file, even with no rows, and writes nothing', async () => {
		const note = await removeAppRedirects(srv('traefik'), 'zorbweb', [])
		expect(h.commands).toEqual(["rm -f '/opt/infra/traefik/dynamic/redirects-zorbweb.yml'"])
		expect(note).toBe('redirects: removed /opt/infra/traefik/dynamic/redirects-zorbweb.yml')
	})
	it('Traefik: a failed removal throws, so the delete cannot report success with the file live', async () => {
		h.code = 1
		await expect(removeAppRedirects(srv('traefik'), 'zorbweb', ['zorb.example'])).rejects.toThrow(/read-only/)
	})
	it('nginx: removes the managed file of each applied hostname and reloads', async () => {
		const note = await removeAppRedirects(srv('nginx'), 'zorbweb', ['zorb.example', 'old.zorb.example'])
		expect(h.commands).toHaveLength(2)
		expect(h.commands[0]).toContain("rm -f '/etc/nginx/sites-enabled/powder-redirects.zorb.example.conf'")
		expect(h.commands[1]).toContain('powder-redirects.old.zorb.example.conf')
		expect(note).toContain('zorb.example, old.zorb.example')
	})
	it('nginx on the host: a failed removal throws and stops at the first hostname', async () => {
		h.code = 1
		await expect(
			removeAppRedirects(srv('nginx'), 'zorbweb', ['zorb.example', 'old.zorb.example']),
		).rejects.toThrow(/read-only/)
		expect(h.commands).toHaveLength(1)
	})
	it('nginx in a container: removes the file in the bind-mounted dir', async () => {
		await removeAppRedirects(srv('nginx-container'), 'zorbweb', ['zorb.example'])
		expect(h.commands.at(-1)).toContain("rm -f '/srv/nginx/conf.d/powder-redirects.zorb.example.conf'")
	})
	it('nothing applied, or a proxy powder does not know: nothing runs', async () => {
		expect(await removeAppRedirects(srv('nginx'), 'zorbweb', [])).toBeNull()
		expect(await removeAppRedirects(srv(null), 'zorbweb', ['zorb.example'])).toBeNull()
		expect(h.commands).toEqual([])
	})
})
