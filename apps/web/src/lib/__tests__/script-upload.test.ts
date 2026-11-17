import { describe, expect, it, vi } from 'vitest'

vi.mock('../ssh/files', () => ({ writeFileViaSftp: async () => { throw new Error('connect ECONNREFUSED 1.2.3.4:22') } }))
vi.mock('../ssh/connection', () => ({ runCommand: async () => ({ code: 1, stdout: '', stderr: 'no route' }) }))

import { shouldRestoreEnv } from '../deploy-runner'
import { deployFailureFromError } from '../deploy-failure'
import { runDeployScript } from '../deploy/run'

describe('failures before the script starts carry step=script upload', () => {
	it('upload/connect failure -> known pre-swap step, so the rendered env is restored', async () => {
		const err = await runDeployScript({ id: 's', host: 'h' } as never, 'echo hi', 'dep_1').catch((e) => e)
		const f = deployFailureFromError(err)
		expect(f.failedStep).toBe('script upload')
		expect(f.exitCode).toBe(1)
		expect(shouldRestoreEnv(f.failedStep)).toBe(true)
	})
})
