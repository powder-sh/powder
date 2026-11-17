// A custom POWDER_ENV_FILE can sit on an app's own path; powder's secrets are never
// a render target, whatever app claims the path.
import { describe, expect, it } from 'vitest'
import { envTargetHardRefusal } from '../env-target'

describe("powder's own env file is refused before the app's own-path allowance", () => {
	it('a custom POWDER_ENV_FILE equal to the app conventional path', () => {
		const c = { appName: 'zorbweb', pinned: null, powderEnvFile: '/opt/apps/zorbweb.env' }
		expect(envTargetHardRefusal('/opt/apps/zorbweb.env', c)).toMatch(/powder's own env file/)
	})
	it('a custom POWDER_ENV_FILE inside the app dir', () => {
		const c = { appName: 'zorbweb', pinned: null, powderEnvFile: '/opt/apps/zorbweb/powder.env' }
		expect(envTargetHardRefusal('/opt/apps/zorbweb/powder.env', c)).toMatch(/powder's own env file/)
	})
	it('the app own path stays allowed when POWDER_ENV_FILE is elsewhere', () => {
		const c = { appName: 'zorbweb', pinned: null, powderEnvFile: '/srv/powder/powder.env' }
		expect(envTargetHardRefusal('/opt/apps/zorbweb.env', c)).toBeNull()
		expect(envTargetHardRefusal('/opt/apps/zorbweb/.env', c)).toBeNull()
	})
})
