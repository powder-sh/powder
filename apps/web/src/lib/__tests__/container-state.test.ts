import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_HEALTH, appHealth } from '../app-health'
import { DockerCommandError, containerReadError, isNoSuchContainer, readContainerState } from '../container-state'

const ok = async () => ({
	status: 'running',
	startedAt: '2020-01-01T00:00:00Z',
	image: 'acme-api:abc1234',
})
const fail = (msg: string) => async () => {
	throw new Error(msg)
}

describe('container state shape', () => {
	it('running container: reachable and exists', async () => {
		expect(await readContainerState(ok, isNoSuchContainer)).toEqual({
			reachable: true,
			exists: true,
			status: 'running',
			startedAt: '2020-01-01T00:00:00Z',
			image: 'acme-api:abc1234',
		})
	})

	it('docker says no such container: reachable, does not exist', async () => {
		const s = await readContainerState(
			fail('Error response from daemon: No such object: acme-api'),
			isNoSuchContainer,
		)
		expect(s).toEqual({ reachable: true, exists: false })
	})

	it('inspect ran but exited non-zero without stderr: a docker error, not missing', async () => {
		const s = await readContainerState(async () => {
			throw new DockerCommandError('docker inspect failed for acme-api')
		}, isNoSuchContainer)
		expect(s).toEqual({ reachable: true, exists: false, dockerError: 'docker inspect failed for acme-api' })
		expect(isNoSuchContainer(new DockerCommandError('docker inspect failed for acme-api'))).toBe(false)
	})

	it.each([
		'Error: No such object: acme-api',
		'Error response from daemon: No such container: acme-api',
		'container not found',
	])('only docker saying the container is missing counts as missing: "%s"', (msg) => {
		expect(isNoSuchContainer(new DockerCommandError(msg))).toBe(true)
	})

	it('the container read answers 502 remote_failed for a docker failure, 404 only for a missing container', async () => {
		const failed = containerReadError(new DockerCommandError('docker inspect failed for acme-api'))
		expect(failed.status).toBe(502)
		expect(((await failed.json()) as { code: string }).code).toBe('remote_failed')
		const missing = containerReadError(new DockerCommandError('Error: No such object: acme-api'))
		expect(missing.status).toBe(404)
	})

	it.each([
		'Timed out while waiting for handshake',
		'connect ECONNREFUSED 192.0.2.10:22',
		'All configured authentication methods failed',
		'getaddrinfo ENOTFOUND prod-1.example.com',
	])('SSH failure "%s": not reachable, never "no container"', async (msg) => {
		const s = await readContainerState(fail(msg), isNoSuchContainer)
		expect(s.reachable).toBe(false)
		expect(s.exists).toBe(false)
		expect(s).toHaveProperty('error', msg)
	})

	it.each([
		'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
		'bash: line 1: docker: command not found',
		'permission denied while trying to connect to the Docker daemon socket',
	])('SSH worked, docker failed "%s": reachable, unknown, never "no container"', async (msg) => {
		const s = await readContainerState(async () => {
			throw new DockerCommandError(msg)
		}, isNoSuchContainer)
		expect(s).toEqual({ reachable: true, exists: false, dockerError: msg })
	})

	it('a docker "No such object" still means missing, not a docker failure', async () => {
		const s = await readContainerState(async () => {
			throw new DockerCommandError('Error response from daemon: No such object: acme-api')
		}, isNoSuchContainer)
		expect(s).toEqual({ reachable: true, exists: false })
	})

	it('server error text is redacted and bounded before it leaves the shape', async () => {
		const token = `ghp_${'a1B2'.repeat(9)}`
		const ssh = await readContainerState(fail(`auth failed for ${token} ${'x'.repeat(2000)}`), isNoSuchContainer)
		const docker = await readContainerState(async () => {
			throw new DockerCommandError(`docker login ${token} failed`)
		}, isNoSuchContainer)
		const sshError = 'error' in ssh ? ssh.error : ''
		const dockerError = 'dockerError' in docker ? docker.dockerError : ''
		for (const text of [sshError, dockerError]) {
			expect(text).not.toContain(token)
			expect(text.length).toBeGreaterThan(0)
			expect(text.length).toBeLessThanOrEqual(300)
		}
	})

	it('the project route answers with this shape, not its own', () => {
		const route = readFileSync(
			join(__dirname, '..', '..', 'app', 'api', 'projects', '[id]', 'route.ts'),
			'utf8',
		)
		expect(route).toContain('readContainerState(')
		expect(route).not.toMatch(/container\s*=\s*\{\s*exists:\s*false\s*\}/)
	})
})

describe('app health with docker failing', () => {
	it('is unknown with its own label, not unreachable and not down', () => {
		const h = appHealth({ lastDeploy: { status: 'success' }, uptime: null, dockerFailed: true })
		expect(h).toBe('docker_error')
		expect(APP_HEALTH[h].state).toBe('unknown')
		expect(APP_HEALTH[h].label).not.toContain('unreachable')
	})
})
