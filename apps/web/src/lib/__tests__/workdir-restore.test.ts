// after a compose-guard refusal in the workdir layout, the tracked extra
// compose files go back to the last successful commit (the runtime docker-compose.yml
// is server-local and stays).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })
		return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 1 }
	},
}))

const { resetCheckoutAfterRefusal } = await import('../deploy/run')

const root = mkdtempSync(join(tmpdir(), 'workdir-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (args: string) => {
	const r = spawnSync('bash', ['-c', `cd ${root} && git -c user.email=t@example.invalid -c user.name=t ${args}`], { encoding: 'utf8' })
	if (r.status !== 0) throw new Error(r.stderr)
	return r.stdout.trim()
}

describe('workdir layout: refused compose files are restored', () => {
	it('writes the tracked docker-compose.prod.yml back to the last good commit, leaves the runtime file', async () => {
		git('init -q -b main .')
		writeFileSync(join(root, 'docker-compose.yml'), 'services: {}\n')
		writeFileSync(join(root, 'docker-compose.prod.yml'), 'services:\n  formsx:\n    image: formsx\n')
		git('add -A && git -c user.email=t@example.invalid -c user.name=t commit -qm good')
		const good = git('rev-parse HEAD')
		writeFileSync(join(root, 'docker-compose.prod.yml'), 'services:\n  formsx:\n    image: formsx\n    privileged: true\n')
		git('add -A && git -c user.email=t@example.invalid -c user.name=t commit -qm bad')
		writeFileSync(join(root, 'docker-compose.yml'), 'services: {}\n# server-local edit\n')
		const log = await resetCheckoutAfterRefusal({ id: 'b', host: 'h', user: 'root' } as never, root, good, [
			join(root, 'docker-compose.yml'),
			join(root, 'docker-compose.prod.yml'),
		])
		expect(log).toContain('restored the tracked compose file(s) docker-compose.prod.yml')
		expect(readFileSync(join(root, 'docker-compose.prod.yml'), 'utf8')).not.toContain('privileged')
		expect(readFileSync(join(root, 'docker-compose.yml'), 'utf8')).toContain('server-local edit')
	})

	it('no known good commit: says the tree stays and every recreate re-checks it', async () => {
		const log = await resetCheckoutAfterRefusal({ id: 'b', host: 'h', user: 'root' } as never, root, null, [])
		expect(log).toContain('every recreate')
	})
})
