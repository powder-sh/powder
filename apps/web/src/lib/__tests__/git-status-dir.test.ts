import { describe, expect, it, vi } from 'vitest'

// getGitStatus puts the working dir into GIT_SSH_COMMAND (run via sh -c), so a
// dir with shell characters or `..` is refused before any command is built.
const runCommand = vi.fn()
vi.mock('../ssh/connection', () => ({ runCommand: (...a: unknown[]) => runCommand(...a) }))

import { getGitStatus, gitStatusDirOk } from '../ssh/git'

describe('getGitStatus dir check', () => {
	it.each(['/opt/apps/shop', '/opt/apps/shop-api/src', '/srv/a_b.c'])('accepts %s', (d) => {
		expect(gitStatusDirOk(d)).toBe(true)
	})
	it.each([
		'opt/apps/shop',
		'/opt/apps/$(id)',
		'/opt/apps/a b',
		'/opt/apps/../etc',
		"/opt/apps/x';id;'",
		'/opt/apps/x\n',
	])('refuses %j without running anything', async (d) => {
		expect(gitStatusDirOk(d)).toBe(false)
		runCommand.mockClear()
		const r = await getGitStatus({} as never, d)
		expect(r).toEqual({
			isRepo: false,
			branch: null,
			currentSha: null,
			upstreamSha: null,
			dirty: false,
		})
		expect(runCommand).not.toHaveBeenCalled()
	})
})
