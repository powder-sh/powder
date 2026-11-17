// The helpers "fix missing pieces" installs: read from powder's own files only,
// shipped in the web image, and the upload refuses a plan whose sha is stale.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ cmds: [] as string[], uploads: [] as { path: string; mode: number; exclusive: boolean }[] }))
vi.mock('../ssh', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		h.cmds.push(cmd)
		return { stdout: 'ok', stderr: '', code: 0 }
	},
	writeFileViaSftp: async (_s: unknown, path: string, _c: string, mode: number, _t: number, _q: boolean, exclusive: boolean) => {
		h.uploads.push({ path, mode, exclusive })
	},
}))
vi.mock('../domain-redirects', () => ({ TRAEFIK_DYNAMIC_DIR: '/opt/infra/traefik/dynamic', checkFileProviderFromInspect: () => ({}), fileProviderFromYml: () => false }))

import { PER_SERVER_HELPERS } from '../server-bootstrap'
import { installHelper } from '../server-bootstrap-run'
import { shippedHelper, shippedHelperShas } from '../server-helpers'

const REPO = join(__dirname, '../../../../..')
const sha = (p: string) => createHash('sha256').update(readFileSync(join(REPO, p), 'utf8')).digest('hex')

describe('shipped helpers', () => {
	it('powder-migrate and powder-image-prune from infra/, never the resource guard', () => {
		const shas = shippedHelperShas()
		expect(shas).toEqual({ migrate: sha('infra/powder-migrate'), imagePrune: sha('infra/powder-image-prune.sh') })
		expect(shippedHelper('resourceGuard')).toBeNull()
	})
	it('the web image copies exactly the installed helpers to the fixed path', () => {
		const df = readFileSync(join(REPO, 'docker/web.Dockerfile'), 'utf8')
		const srcs = PER_SERVER_HELPERS.filter((x) => x.installed).map((x) => `infra/${x.src}`)
		expect(df).toContain(`COPY ${srcs.join(' ')} ./helpers/`)
		expect(df).not.toContain('powder-resource-guard')
	})
})

describe('installHelper', () => {
	it('uploads to an exclusive 0700 temp file next to the destination, then runs the step with T set', async () => {
		h.cmds = []
		h.uploads = []
		const s = shippedHelper('migrate')?.sha256
		const r = await installHelper({ id: 'x' } as never, 'migrate', `S=${s}\nrest`)
		expect(r.code).toBe(0)
		expect(h.uploads).toHaveLength(1)
		expect(h.uploads[0]?.path).toMatch(/^\/usr\/local\/bin\/\.powder-migrate\.[0-9a-f]{16}$/)
		expect(h.uploads[0]).toMatchObject({ mode: 0o700, exclusive: true })
		expect(h.cmds.at(-1)).toBe(`T='${h.uploads[0]?.path}'\nS=${s}\nrest`)
	})
	it('refuses a plan whose sha is not the shipped one, before any upload', async () => {
		h.uploads = []
		const r = await installHelper({ id: 'x' } as never, 'migrate', `S=${'0'.repeat(64)}\nrest`)
		expect(r.code).toBe(1)
		expect(r.stderr).toContain('changed since the check')
		expect(h.uploads).toEqual([])
		expect((await installHelper({ id: 'x' } as never, 'resourceGuard', 'S=x')).code).toBe(1)
	})
})
