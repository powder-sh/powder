import { spawnSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { kind: 'cmd' | 'secret' | 'sftp'; a: string; b?: string; mode?: number }[] = []

vi.mock('../ssh', async () => {
	const actual = await vi.importActual<typeof import('../ssh')>('../ssh')
	return {
		...actual,
		writeFileSecret: vi.fn(async (_s: unknown, path: string, contents: string) => {
			calls.push({ kind: 'secret', a: path, b: contents })
		}),
		writeFileViaSftp: vi.fn(async (_s: unknown, path: string, contents: string, mode?: number) => {
			calls.push({ kind: 'sftp', a: path, b: contents, mode })
		}),
		runCommand: vi.fn(async (_s: unknown, cmd: string) => {
			calls.push({ kind: 'cmd', a: cmd })
			return { code: cmd.includes('builder-fail-marker') || cmd.startsWith('timeout -k') ? 1 : 0, stdout: '', stderr: '' }
		}),
	}
})

import { runBuilderPhase } from '../builder'

// the builder script is uploaded over SFTP (0700) and run as `bash <path>` under
// `timeout -k <kill> <secs>`; its text is the SFTP payload, never part of an exec command.
function builderScript(): string {
	return calls.find((c) => c.kind === 'sftp')?.b ?? ''
}

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nSUPERSECRETKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----'

beforeEach(() => {
	calls.length = 0
})

async function run(repoUrl = 'git@github.com:o/r.git') {
	await runBuilderPhase(
		{ id: 's', name: 's', host: '1.2.3.4', port: 22 } as never,
		{ host: '5.6.7.8', repoUrl, deployKeyPriv: KEY },
		{ image: 'app:latest', context: '/opt/apps/app/src', dockerfile: 'Dockerfile', args: {}, hasSecrets: false, hasAdditionalContexts: false },
		'app',
		{ branch: 'main', sha: null, deployId: 'dep_1' },
	).catch(() => {})
}

describe('builder script is not in argv', () => {
	it('build args (secrets) travel in the 0700 SFTP script, never in an exec command line', async () => {
		await runBuilderPhase(
			{ id: 's', name: 's', host: '1.2.3.4', port: 22 } as never,
			{ host: '5.6.7.8', repoUrl: 'git@github.com:o/r.git', deployKeyPriv: KEY },
			{ image: 'app:latest', context: '/opt/apps/app/src', dockerfile: 'Dockerfile', args: { NPM_TOKEN: 'sup3rs3cret' }, hasSecrets: false, hasAdditionalContexts: false },
			'app',
			{ branch: 'main', sha: null, deployId: 'dep_1' },
		).catch(() => {})
		const sftp = calls.find((c) => c.kind === 'sftp')
		expect(sftp?.mode).toBe(0o700)
		expect(sftp?.b).toContain('sup3rs3cret')
		for (const c of calls.filter((x) => x.kind === 'cmd')) {
			expect(c.a).not.toContain('sup3rs3cret')
			expect(c.a).not.toContain('bash -c')
		}
	})
})

describe('builder deploy key and host keys', () => {
	it('delivers the key via SFTP and never inside any exec command line', async () => {
		await run()
		const secret = calls.find((c) => c.kind === 'secret')
		expect(secret?.b).toContain('SUPERSECRETKEYMATERIAL')
		for (const c of calls.filter((x) => x.kind === 'cmd')) {
			expect(c.a).not.toContain('SUPERSECRETKEYMATERIAL')
			expect(c.a).not.toContain('POWDER_KEY_EOF')
		}
	})
	it('runs the builder script under timeout -k bounded by the budget', async () => {
		await run()
		const wrapped = calls.find((c) => c.kind === 'cmd' && c.a.startsWith('timeout -k'))?.a ?? ''
		expect(wrapped).toMatch(/^timeout -k 30 3360 bash '\/tmp\/powder-builder\.tmp\.[0-9a-f]{16}\.sh'; rc=\$\?; rm -f /)
		expect(builderScript().startsWith('set -e; ')).toBe(true)
	})
	it('uses the pinned github known_hosts, not accept-new', async () => {
		await run()
		const script = builderScript()
		expect(script).toContain('StrictHostKeyChecking=yes')
		expect(script).toContain('UserKnownHostsFile=$PKH')
		expect(script).toContain('.powder_known_hosts')
		expect(script).not.toContain('accept-new')
	})
	it('removes the key afterwards even when the script fails', async () => {
		await run()
		const cmds = calls.filter((c) => c.kind === 'cmd').map((c) => c.a)
		const script = cmds.findIndex((c) => c.startsWith('timeout -k'))
		const rm = cmds.findIndex((c) => /^rm -f '.*\.k\./.test(c))
		expect(script).toBeGreaterThanOrEqual(0)
		expect(rm).toBeGreaterThan(script)
	})
	it('runs the build host cap prune after the phase, even when the script fails', async () => {
		await run()
		const last = calls[calls.length - 1]
		expect(last?.kind).toBe('cmd')
		expect(last?.a).toContain('POWDER_BUILDER_PRUNE')
		expect(last?.a).toContain('docker buildx du')
	})
	it('quotes repoUrl in echo lines so it cannot break out', async () => {
		await run('git@github.com:o/r.git";touch /tmp/pwned;"')
		const script = builderScript()
		expect(script).toContain(`echo '[builder] fresh clone of git@github.com:o/r.git";touch /tmp/pwned;"'`)
		expect(spawnSync('bash', ['-n', '-c', script]).status).toBe(0)
	})
})
