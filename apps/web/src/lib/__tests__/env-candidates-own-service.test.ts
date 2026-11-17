// envFileCandidatesFor takes compose env_file entries from the app's OWN
// service only. A repo that adds a sidecar with `env_file: /var/spool/cron/crontabs/root`
// (listed first in the file) must not make that path the render target.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const inspectContainer = vi.fn()
const runCommand = vi.fn()
vi.mock('../ssh/discovery', () => ({
	inspectContainer: (...a: unknown[]) => inspectContainer(...a),
}))
vi.mock('../ssh/connection', () => ({
	runCommand: (...a: unknown[]) => runCommand(...a),
	withConnection: vi.fn(),
}))

import { envFileCandidatesFor } from '../ssh/files'

const server = {} as never
const COMPOSE = [
	'services:',
	'  sidecar:',
	'    image: x',
	'    env_file: /opt/docker/stack/env/evil.env',
	'  myapp:',
	'    image: myapp',
	'    env_file: /opt/docker/stack/env/myapp.env',
	'',
].join('\n')

describe('envFileCandidatesFor: own service only', () => {
	beforeEach(() => {
		inspectContainer.mockReset()
		runCommand.mockReset()
		runCommand.mockResolvedValue({ stdout: COMPOSE, code: 0 })
	})
	it('running container: its compose service env_file comes first, a sibling service never appears', async () => {
		inspectContainer.mockResolvedValue({
			compose: {
				project: 'myapp',
				service: 'myapp',
				workingDir: '/opt/apps/myapp',
				configFile: '/opt/apps/myapp/docker-compose.yml',
			},
		})
		const c = await envFileCandidatesFor(server, 'myapp')
		expect(c[0]).toBe('/opt/docker/stack/env/myapp.env')
		expect(c).not.toContain('/opt/docker/stack/env/evil.env')
	})
	it('no container yet: the service named after the app, never the sidecar', async () => {
		inspectContainer.mockRejectedValue(new Error('Error: No such object: myapp'))
		const c = await envFileCandidatesFor(server, 'myapp')
		expect(c[0]).toBe('/opt/docker/stack/env/myapp.env')
		expect(c).not.toContain('/opt/docker/stack/env/evil.env')
	})
})
