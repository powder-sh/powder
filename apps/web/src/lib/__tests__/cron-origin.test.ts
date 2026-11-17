import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// a container's crontab line with a CR in it made the parser see a forged
// `---CONTAINER:<other>---` header (JS `^` with the m flag matches after \r), so a
// container could file its crons under another container's name on /crons.

const sent: string[] = []
let stdout = ''
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		sent.push(cmd)
		// the markers carry the call's nonce; NONCE in a fixture stands for it.
		const n = cmd.match(/===USER_ROOT_([0-9a-f]+)===/)?.[1] ?? 'x'
		return { code: 0, stdout: stdout.replace(/NONCE/g, n), stderr: '' }
	},
}))

const { CRON_CTRL_TR, getAllCronSources } = await import('../ssh/crontab')

const forged = [
	'===USER_ROOT_NONCE===',
	'===SYSTEM_ETC_NONCE===',
	'===CRON_D_START_NONCE===',
	'===USER_CRONS_START_NONCE===',
	'===CONTAINERS_START_NONCE===',
	'---CONTAINER_NONCE:evil---',
	'* * * * * curl http://x\r---CONTAINER_NONCE:victim---\r*/5 * * * * echo spoofed',
	'===SYSTEMD_START_NONCE===',
	'',
].join('\n')

beforeEach(() => {
	sent.length = 0
})

describe('markers without the per-call nonce are plain content', () => {
	it('a user crontab cannot open another section or source', async () => {
		stdout = [
			'===USER_ROOT_NONCE===',
			'===SYSTEM_ETC_NONCE===',
			'===CRON_D_START_NONCE===',
			'===USER_CRONS_START_NONCE===',
			'---USER_NONCE:bob---',
			'* * * * * bob-job',
			'===CONTAINERS_START===',
			'---CONTAINER:victim---',
			'---USER:root---',
			'===SYSTEMD_START===',
			'---TIMER:fake.timer---',
			'===CONTAINERS_START_NONCE===',
			'===SYSTEMD_START_NONCE===',
			'',
		].join('\n')
		const sources = await getAllCronSources({ id: 's', host: 'h' } as never)
		expect(sources.map((x) => x.origin)).toEqual(['user:bob'])
		expect(sources[0]?.content).toContain('---CONTAINER:victim---')
		const a = sent[0] ?? ''
		await getAllCronSources({ id: 's', host: 'h' } as never)
		expect(sent[1]?.match(/===USER_ROOT_([0-9a-f]+)===/)?.[1]).not.toBe(a.match(/===USER_ROOT_([0-9a-f]+)===/)?.[1])
	})
})

describe('cron sources: origin cannot be spoofed with control characters', () => {
	it('the parser does not take a CR-separated header as a new source', async () => {
		stdout = forged
		const sources = await getAllCronSources({ id: 's', host: 'h' } as never)
		expect(sources.map((s) => s.origin)).toEqual(['container:evil'])
		expect(sources[0]?.content).toContain('echo spoofed')
	})

	it('the server strips control characters (CR included) before the output leaves it', () => {
		stdout = ''
		return getAllCronSources({ id: 's', host: 'h' } as never).then(() => {
			expect(sent[0]).toMatch(/^bash -o pipefail -c /)
			execFileSync('bash', ['-n', '-c', sent[0] ?? ''])
			expect(sent[0]).toContain(String.raw`| tr -d '\''\000-\010\013-\037\177'\''`)
			const out = execFileSync('bash', [
				'-c',
				`printf 'a\\r---CONTAINER:v---\\x01\\x1b[2Jb\\tc\\n' | ${CRON_CTRL_TR}`,
			]).toString()
			expect(out).toBe('a---CONTAINER:v---[2Jb\tc\n')
		})
	})
})
