import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

let envVars: NodeJS.ProcessEnv = process.env
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', env: envVars })
		return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
	},
	withConnection: () => ({ end() {} }),
}))
vi.mock('../ssh/discovery', () => ({ inspectContainer: async () => ({}) }))
vi.mock('../ssh-host-keys', () => ({ explainSshError: (_h: string, e: Error) => e }))

import { backupEnvBeforeRender, recordEnvRender, restoreEnvBeforeRender } from '../ssh/files'

function setup() {
	const root = mkdtempSync(join(tmpdir(), 'f8-'))
	envVars = { ...process.env, POWDER_ENV_STATE: join(root, 'state') }
	const env = join(root, 'app.env')
	writeFileSync(env, 'OLD=1\n')
	return { env }
}

describe('restore only while the file still has the hash this deploy rendered', () => {
	it('restores when nothing touched the file after the render', async () => {
		const { env } = setup()
		await backupEnvBeforeRender({} as never, env, 'dep_a')
		writeFileSync(env, 'NEW_A=1\n')
		await recordEnvRender({} as never, env, 'dep_a')
		const r = await restoreEnvBeforeRender({} as never, env, 'dep_a')
		expect(r.restored).toBe(true)
		expect(readFileSync(env, 'utf8')).toBe('OLD=1\n')
	})
	it('does NOT overwrite a newer deploy\'s render', async () => {
		const { env } = setup()
		await backupEnvBeforeRender({} as never, env, 'dep_a')
		writeFileSync(env, 'NEW_A=1\n')
		await recordEnvRender({} as never, env, 'dep_a')
		// a newer deploy renders after dep_a was reaped
		writeFileSync(env, 'NEW_B=1\n')
		const r = await restoreEnvBeforeRender({} as never, env, 'dep_a')
		expect(r.restored).toBe(false)
		expect(r.output).toContain('not restoring')
		expect(readFileSync(env, 'utf8')).toBe('NEW_B=1\n')
		mkdirSync(join(tmpdir()), { recursive: true })
	})
})
