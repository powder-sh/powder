import { beforeEach, describe, expect, it, vi } from 'vitest'

// the crons log view masks secrets, never reads powder's own or an unmanaged
// container, and reads /var/log/syslog only without journald, cron-daemon lines only.
const runCommand = vi.fn()
const managed = vi.fn()
vi.mock('@/lib/access', () => ({
	requireUser: async () => ({ id: 'u1', isAdmin: true }),
	requireServerForUser: async () => ({ ok: true }),
	isManagedContainer: async (_s: string, c: string) => managed(c),
}))
vi.mock('@/lib/servers', () => ({ getServer: async () => ({ id: 's1', host: 'h' }) }))
vi.mock('@/lib/ssh', () => ({ runCommand: (...a: unknown[]) => runCommand(...a) }))
vi.mock('@/lib/managed-containers', () => ({
	managedContainerNames: async () => ['shop', 'powder'],
}))

const post = async (origin: string, command: string | null = null) => {
	const { POST } = await import('@/app/api/crons/logs/route')
	return POST(
		new Request('http://x/api/crons/logs', {
			method: 'POST',
			body: JSON.stringify({ serverId: 's1', origin, command }),
		}),
	)
}

describe('crons logs', () => {
	beforeEach(() => {
		runCommand.mockReset()
		managed.mockReset()
	})

	it('masks secrets in the output', async () => {
		managed.mockReturnValue(true)
		runCommand.mockResolvedValue({
			code: 0,
			stdout: 'job ran DATABASE_URL=postgres://app:hunter2secret@db/app\n',
			stderr: '',
		})
		const j = (await (await post('container:shop')).json()) as { logs: string }
		expect(j.logs).not.toContain('hunter2secret')
	})

	it("refuses powder's own containers", async () => {
		managed.mockReturnValue(true)
		expect((await post('container:powder')).status).toBe(404)
		expect(runCommand).not.toHaveBeenCalled()
	})

	it('refuses a container outside every managed app project', async () => {
		managed.mockReturnValue(false)
		runCommand.mockResolvedValue({ code: 0, stdout: 'someoneelse\n', stderr: '' })
		expect((await post('container:stranger')).status).toBe(404)
	})

	it("allows a managed app's cron sidecar (same compose project)", async () => {
		managed.mockReturnValue(false)
		runCommand.mockImplementation(async (_s: unknown, cmd: string) =>
			cmd.includes('com.docker.compose.project')
				? { code: 0, stdout: 'shop\n', stderr: '' }
				: { code: 0, stdout: 'ok', stderr: '' },
		)
		expect((await post('container:shop-cron-1')).status).toBe(200)
	})

	it('host crons read syslog only when the journal has nothing, and only cron daemon lines', async () => {
		runCommand.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
		await post('user-root', 'backup.sh --all')
		const cmd = String(runCommand.mock.calls[0]?.[1])
		expect(cmd).toContain('if [ -z "$CJ" ]; then')
		expect(cmd).toContain("grep -E ' CRON\\[[0-9]+\\]: ' /var/log/syslog")
		expect(cmd).not.toContain('grep -F CRON /var/log/syslog')
	})
})

describe('crons logs syslog fallback (shell)', () => {
	it('falls back to syslog when journalctl exists but has nothing for the job', async () => {
		const { spawnSync } = await import('node:child_process')
		const { mkdtempSync, writeFileSync } = await import('node:fs')
		const { join } = await import('node:path')
		const { tmpdir } = await import('node:os')
		runCommand.mockReset()
		runCommand.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
		await post('user-root', null)
		const cmd = String(runCommand.mock.calls[0]?.[1])
		const d = mkdtempSync(join(tmpdir(), 'cron-'))
		writeFileSync(join(d, 'journalctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
		const r = spawnSync('bash', ['-c', cmd.replaceAll('/var/log/syslog', join(d, 'syslog'))], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${d}:${process.env.PATH}` },
		})
		expect(r.stdout).toContain('nothing in the journal')
		writeFileSync(join(d, 'journalctl'), '#!/bin/sh\necho "host CRON[12]: (root) CMD (job)"\n', {
			mode: 0o755,
		})
		const r2 = spawnSync('bash', ['-c', cmd], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${d}:${process.env.PATH}` },
		})
		expect(r2.stdout).toContain('CRON[12]')
		expect(r2.stdout).not.toContain('nothing in the journal')
	})
})
