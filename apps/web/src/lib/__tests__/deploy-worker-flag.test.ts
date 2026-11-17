import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../ssh', () => ({}))
vi.mock('../deploy-queue', () => ({}))

import { deployWorkerEnabled } from '../deploys'

const env = (v?: string) => (v === undefined ? {} : { POWDER_DEPLOY_WORKER: v }) as unknown as NodeJS.ProcessEnv

describe('deployWorkerEnabled', () => {
	it('accepts true, 1, yes and on in any case', () => {
		for (const v of ['1', 'true', 'TRUE', 'yes', 'Yes', ' on ']) expect(deployWorkerEnabled(env(v))).toBe(true)
	})
	it('is off when unset or anything else', () => {
		for (const v of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) expect(deployWorkerEnabled(env(v))).toBe(false)
	})
})
