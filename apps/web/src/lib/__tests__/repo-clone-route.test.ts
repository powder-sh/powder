// The clone action and the container page's git status, against a stubbed command
// runner: the exact commands each app layout gets. The clone never moves or
// replaces the working dir; it clones into <working dir>/src only when the app has
// no checkout and no src, and refuses (nothing written) otherwise. Invented names.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appCheckoutProbeShell } from '../app-checkout'
import { appLockPath } from '../deploy-supersede'
import { shq } from '../shell'
import { remoteState } from '../git-remote-state'

const WD = '/opt/apps/shop'
const URL_ = 'git@github.com:acme/shop.git'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
// a token-shaped value, built at runtime
const TOKEN = `${'gh'}p_${'a'.repeat(36)}`

// probe answer: srcLink srcExists srcGit workdirGit
let facts = '0 0 0 0'
const calls: string[] = []
const runCommand = vi.fn(async (_s: unknown, cmd: string, _t?: number, _c?: unknown, opts?: { stdin?: string }) => {
	calls.push(cmd)
	if (cmd.includes('::app-checkout::')) return { stdout: `::app-checkout:: ${facts}\n`, stderr: '', code: 0 }
	if (cmd.includes('::repo::')) return { stdout: `::repo::\nmain\n${SHA_A}\n${SHA_B}\n\n`, stderr: '', code: 0 }
	// the clone script: its status line alone on stdout (the nonce comes on stdin)
	const nonce = opts?.stdin?.trim()
	if (cmd.includes(' clone ') && nonce)
		return { stdout: `__PC_${nonce}__ rc=0 placed=1 kept=- reason=ok\n`, stderr: `cloned to ${WD}/src\n`, code: 0 }
	return { stdout: '', stderr: '', code: 0 }
})
vi.mock('../ssh/connection', () => ({ runCommand: (...a: [unknown, string, number?, unknown?, { stdin?: string }?]) => runCommand(...a) }))

const writeFileSecret = vi.fn(async () => {})
vi.mock('@/lib/ssh', async (orig) => ({
	...(await orig<typeof import('../ssh')>()),
	inspectContainer: async () => ({ compose: { workingDir: WD, project: 'shop', configFile: `${WD}/docker-compose.yml`, service: 'shop' } }),
	writeFileSecret: (...a: unknown[]) => writeFileSecret(...(a as [])),
}))
vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => ({ user: { id: 'u', isAdmin: true }, server: { id: 's', kind: 'compose' } }),
}))
vi.mock('@/lib/repos', async (orig) => ({
	...(await orig<typeof import('../repos')>()),
	getRepoFor: async () => ({ id: 'r', repoUrl: URL_, branch: 'main', webhookToken: 't', deployKeyPub: 'pub', createdAt: new Date(0) }),
	decryptDeployKey: () => 'PRIVATE KEY',
}))

import { POST as clonePOST } from '../../app/api/servers/[id]/containers/[name]/repo/clone/route'
import { GET as gitStatusGET } from '../../app/api/servers/[id]/containers/[name]/git-status/route'

const ctx = { params: Promise.resolve({ id: 's', name: 'shop' }) }
const clone = () => clonePOST(new Request('http://x/api', { method: 'POST' }), ctx)

beforeEach(() => {
	calls.length = 0
	runCommand.mockClear()
	writeFileSecret.mockClear()
})

describe('repo clone route', () => {
	it('no checkout: clones into <working dir>/src, nothing else moves', async () => {
		facts = '0 0 0 0'
		const res = await clone()
		expect(res.status).toBe(200)
		// probe, clone, then the temp key's removal
		expect(calls).toHaveLength(3)
		expect(calls[0]).toBe(appCheckoutProbeShell(WD))
		// the clone reads a temp key outside the app's directory; <wd>/.deploy-key is
		// re-planted only after the clone is in place
		const tmpKey = String((writeFileSecret.mock.calls[0] as unknown[] | undefined)?.[1])
		expect(tmpKey).toMatch(/^\/tmp\/powder-clone-key\.tmp\.[0-9a-f]{16}$/)
		expect((writeFileSecret.mock.calls as unknown[][]).map((c) => c[1])).toEqual([tmpKey, `${WD}/.deploy-key`])
		expect(calls[2]).toBe(`rm -f ${shq(tmpKey)}`)
		const c = calls[1] ?? ''
		const tmp = c.match(/'(\/opt\/apps\/shop\/\.powder-clone-src\.\d+)'/)?.[1] ?? ''
		expect(tmp).toBeTruthy()
		expect(c).toContain(`cd ${shq(WD)} 2>/dev/null || __pc_refuse nowd`)
		expect(c).toContain(`powder_git_norepo clone --branch 'main' --depth 1 -- ${shq(URL_)} ${shq(`${tmp}/repo`)} 2>&1`)
		expect(c).toContain(`mv -T -- ${shq(`${tmp}/repo`)} ${shq(`${WD}/src`)}`)
		// every refusal check comes before the first change (the temp dir)
		const firstChange = c.indexOf(`mkdir -- ${shq(tmp)}`)
		expect(firstChange).toBeGreaterThan(0)
		expect(c.lastIndexOf('__pc_refuse ')).toBeLessThan(firstChange)
		// the working dir is never the source of a move, and nothing is set aside
		expect(c).not.toContain('before-powder')
		expect(c).not.toMatch(/\bmv\b[^;]*'\/opt\/apps\/shop' /)
		expect(c.match(/\bmv -T\b/g)).toHaveLength(1)
		expect(c).toContain(`-i ${shq(tmpKey)}`)
		// the app's deploy lock, and the temp dir trap
		expect(c).toContain(`exec 9>${shq(appLockPath(WD, 'shop'))}`)
		expect(c).toContain('flock -w 20 9 ||')
		expect(c).toContain('trap __pc_end EXIT; trap ')
	})

	it.each([
		['checkout in src', '0 1 1 0', /already has a git checkout in \/opt\/apps\/shop\/src/],
		['stale .git in the working dir plus a checkout in src', '0 1 1 1', /already has a git checkout in \/opt\/apps\/shop\/src/],
		['src exists without .git', '0 1 0 0', /\/opt\/apps\/shop\/src exists but is not a git checkout/],
		['the working dir is the checkout', '0 0 0 1', /\/opt\/apps\/shop is already a git checkout/],
		['src is a symlink', '1 1 1 0', /is a symlink/],
	])('%s: refused with only reads run, nothing written', async (_n, f, msg) => {
		facts = f
		const res = await clone()
		expect(res.status).toBe(409)
		expect((await res.json()).error).toMatch(msg)
		expect(calls[0]).toBe(appCheckoutProbeShell(WD))
		// with a checkout in src/, one more read: is only the deploy key missing?
		if (f.split(' ')[2] === '1' && f[0] === '0') {
			expect(calls).toHaveLength(2)
			expect(calls[1]).toContain('remote get-url origin')
		} else expect(calls).toHaveLength(1)
		expect(writeFileSecret).not.toHaveBeenCalled()
	})

	it('a clone in place whose deploy key is missing: the action writes only the key', async () => {
		facts = '0 1 1 0'
		runCommand.mockImplementationOnce(async (_s: unknown, cmd: string) => {
			calls.push(cmd)
			return { stdout: `::app-checkout:: ${facts}\n`, stderr: '', code: 0 }
		})
		runCommand.mockImplementationOnce(async (_s: unknown, cmd: string) => {
			calls.push(cmd)
			return { stdout: `missing ${URL_}\n`, stderr: '', code: 0 }
		})
		const res = await clone()
		expect(res.status).toBe(200)
		expect((await res.json()).output).toBe(`the clone was already in place at ${WD}/src; wrote the missing deploy key to ${WD}/.deploy-key`)
		expect((writeFileSecret.mock.calls as unknown[][]).map((c) => c[1])).toEqual([`${WD}/.deploy-key`])
		expect(calls).toHaveLength(2)
	})

	it('a checkout of another repo with no key is refused as before (nothing written)', async () => {
		facts = '0 1 1 0'
		runCommand.mockImplementationOnce(async (_s: unknown, cmd: string) => {
			calls.push(cmd)
			return { stdout: `::app-checkout:: ${facts}\n`, stderr: '', code: 0 }
		})
		runCommand.mockImplementationOnce(async (_s: unknown, cmd: string) => {
			calls.push(cmd)
			return { stdout: 'missing git@github.com:other/repo.git\n', stderr: '', code: 0 }
		})
		const res = await clone()
		expect(res.status).toBe(409)
		expect(writeFileSecret).not.toHaveBeenCalled()
	})

	it('a clone placed but whose key write fails says so, and what to do', async () => {
		facts = '0 0 0 0'
		writeFileSecret.mockImplementation(async (...a: unknown[]) => {
			if (String(a[1]).endsWith('/.deploy-key')) throw new Error('Permission denied')
		})
		try {
			const res = await clone()
			expect(res.status).toBe(500)
			expect((await res.json()).error).toBe(
				`the clone is in place at ${WD}/src, but the deploy key could not be written to ${WD}/.deploy-key (Permission denied). Deploys need it: press clone again now, or after a reload press "write key" on the repo card; either writes only the key.`,
			)
		} finally {
			writeFileSecret.mockImplementation(async () => {})
		}
	})

	it("a clone the script refuses writes nothing into the app's directory (only the temp key, removed after)", async () => {
		facts = '0 0 0 0'
		runCommand.mockImplementationOnce(async (_s: unknown, cmd: string) => {
			calls.push(cmd)
			return { stdout: `::app-checkout:: ${facts}\n`, stderr: '', code: 0 }
		})
		runCommand.mockImplementationOnce(async (_s: unknown, cmd: string, _t?: number, _c?: unknown, opts?: { stdin?: string }) => {
			calls.push(cmd)
			const n = opts?.stdin?.trim()
			return { stdout: `__PC_${n}__ rc=1 placed=0 kept=- reason=checkout\n`, stderr: 'clone refused: x\n', code: 1 }
		})
		const res = await clone()
		expect(res.status).toBe(500)
		expect((await res.json()).error).toMatch(/already holds a git checkout .*nothing in the app's directory was changed/)
		const written = (writeFileSecret.mock.calls as unknown[][]).map((c) => String(c[1]))
		expect(written).toHaveLength(1)
		expect(written[0]).toMatch(/^\/tmp\/powder-clone-key\.tmp\./)
		expect(calls[2]).toBe(`rm -f ${shq(written[0] ?? '')}`)
	})

	it('a clone the SSH call gave up on is reported as possibly still running, not as failed', async () => {
		facts = '0 0 0 0'
		runCommand.mockImplementationOnce(async (_s: unknown, cmd: string) => {
			calls.push(cmd)
			return { stdout: `::app-checkout:: ${facts}\n`, stderr: '', code: 0 }
		})
		runCommand.mockRejectedValueOnce(new Error('SSH timeout to h'))
		const res = await clone()
		expect(res.status).toBe(504)
		expect((await res.json()).error).toBe(
			`the clone did not answer in time and may still be running on the server; reload in a minute to see whether ${WD}/src appeared`,
		)
	})

	it('a probe that cannot tell (no marker, or the server not answering) is refused', async () => {
		facts = 'garbage'
		let res = await clone()
		expect(res.status).toBe(409)
		expect((await res.json()).error).toMatch(/could not read the app's layout on the server \(\/opt\/apps\/shop\), so the clone did not run; nothing was changed/)
		runCommand.mockRejectedValueOnce(new Error('Timed out while waiting for handshake'))
		res = await clone()
		expect(res.status).toBe(409)
		expect(writeFileSecret).not.toHaveBeenCalled()
	})
})


describe('git status: the remote is ahead, current, or could not be checked', () => {
	const statusWith = async (upstreamLine: string) => {
		facts = '0 1 1 0'
		runCommand.mockImplementationOnce(async (_s: unknown, cmd: string) => {
			calls.push(cmd)
			return { stdout: `::app-checkout:: ${facts}\n`, stderr: '', code: 0 }
		})
		runCommand.mockImplementationOnce(async (_s: unknown, cmd: string) => {
			calls.push(cmd)
			return { stdout: `::repo::\nmain\n${SHA_A}\n${upstreamLine}\n\n`, stderr: '', code: 0 }
		})
		return (await gitStatusGET(new Request('http://x/api'), ctx)).json()
	}
	it('ahead', async () => {
		const b = await statusWith(SHA_B)
		expect(b).toMatchObject({ upstreamSha: SHA_B, upstreamError: null })
		expect(remoteState(b)).toEqual({ kind: 'ahead' })
	})
	it('up to date', async () => {
		const b = await statusWith(SHA_A)
		expect(b).toMatchObject({ upstreamSha: SHA_A, upstreamError: null })
		expect(remoteState(b)).toEqual({ kind: 'current' })
	})
	it.each([
		['::lsremote-error:: git@github.com: Permission denied (publickey).', /^the remote could not be read: git@github.com: Permission denied \(publickey\)\.$/],
		[`::lsremote-error:: fatal: unable to access https://u:${TOKEN}@github.com/a/b/`, /^the remote could not be read: /],
		['::lsremote-nobranch::', /^the branch is not on the remote$/],
		['NONE', /^the checkout has no upstream branch$/],
	])('could not check: %s', async (line, why) => {
		const b = await statusWith(line)
		expect(b.upstreamSha).toBeNull()
		expect(b.upstreamError).toMatch(why)
		expect(b.upstreamError).not.toContain(TOKEN)
		expect(remoteState(b)).toEqual({ kind: 'unchecked', reason: b.upstreamError })
	})
	it('the script prints a distinct line when ls-remote fails', async () => {
		await statusWith(SHA_B)
		const c = calls[1] ?? ''
		expect(c).toContain('if LO=$(')
		expect(c).toContain('else L="::lsremote-error:: ')
		expect(c).toContain("L='::lsremote-nobranch::'")
	})
})

describe('git status reads the real checkout, without a fetch', () => {
	it('stale .git in the working dir plus src: reads src, flags the stale dir', async () => {
		facts = '0 1 1 1'
		const res = await gitStatusGET(new Request('http://x/api'), ctx)
		const body = await res.json()
		expect(body).toMatchObject({
			supported: true,
			workingDir: WD,
			isRepo: true,
			branch: 'main',
			currentSha: SHA_A,
			upstreamSha: SHA_B,
			checkout: 'src',
			checkoutDir: `${WD}/src`,
			staleWorkdirGit: true,
		})
		expect(calls[0]).toBe(appCheckoutProbeShell(WD))
		const c = calls[1] ?? ''
		expect(c).toContain(`-C ${shq(`${WD}/src`)}`)
		expect(c).not.toContain(`-C ${shq(WD)} `)
		expect(c).toContain(`if [ -d ${shq(`${WD}/src`)}/.git ]`)
		expect(c).toContain(`KEY=${shq(WD)}/.deploy-key`)
		expect(c).toContain('ls-remote -- "$R" "refs/heads/$B"')
		expect(c).toContain('GIT_OPTIONAL_LOCKS=0')
		expect(c).not.toMatch(/safe\.directory=\S+ fetch\b/)
	})

	it('the older layout reads the working dir; no checkout runs nothing after the probe', async () => {
		facts = '0 0 0 1'
		let body = await (await gitStatusGET(new Request('http://x/api'), ctx)).json()
		expect(body).toMatchObject({ isRepo: true, checkout: 'workdir', checkoutDir: WD, staleWorkdirGit: false })
		expect(calls[1]).toContain(`-C ${shq(WD)} `)
		calls.length = 0
		facts = '0 0 0 0'
		body = await (await gitStatusGET(new Request('http://x/api'), ctx)).json()
		expect(body).toMatchObject({ isRepo: false, checkout: 'none', checkoutDir: null })
		expect(calls).toEqual([appCheckoutProbeShell(WD)])
	})
})
