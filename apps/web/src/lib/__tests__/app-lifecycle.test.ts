// App stop / delete from the dashboard (lib/app-lifecycle.ts and the stop / delete
// routes): command construction, name validation, and who may call them. Invented
// names only.
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const h = vi.hoisted(() => ({
	access: null as Response | null,
	user: null as unknown,
	inFlight: false,
	repo: null as unknown,
	commands: [] as string[],
	runResult: { code: 0, stdout: '', stderr: '' },
	finished: [] as { id: string; status: string }[],
	deleted: [] as string[],
	torn: [] as string[],
	previews: [] as { id: string; containerName: string }[],
	order: [] as string[],
	inspectError: null as Error | null,
	others: ['zorbweb', 'quuxapi'] as string[],
	queued: [] as { id: string }[],
	txFail: false,
	redirects: [] as { hostname: string; appliedAt: Date | null }[],
	redirectCalls: [] as string[][],
	redirectFail: null as Error | null,
	progress: [] as string[],
}))
const sessionAdmin = { id: 'u1', email: 'op@zorb.example', name: 'op', isAdmin: true }
const tokenAdmin = { ...sessionAdmin, viaToken: true, tokenId: 't1', tokenScopes: null }
const server = { id: 'boxa', host: 'h', kind: 'compose' }

vi.mock('@/lib/access', () => ({
	requireContainerAccess: async () => h.access ?? { user: h.user, server },
}))
vi.mock('@/lib/deploys', () => ({
	cancelHeldDeploys: async () => [],
	tryStartDeploy: async (o: { kind: string }) =>
		h.inFlight ? Response.json({ error: 'deploy already in flight' }, { status: 409 }) : { id: `dep_${o.kind}` },
	finishDeploy: async (id: string, r: { status: string }) => {
		h.finished.push({ id, status: r.status })
	},
	inlineProgress: () => {
		const lines: string[] = []
		return {
			lines,
			step: async (l: string) => {
				lines.push(l)
				h.progress.push(l)
			},
			stop: () => {},
		}
	},
}))
vi.mock('@/lib/domain-redirects', () => ({
	removeAppRedirects: async (_s: unknown, _name: string, hosts: string[]) => {
		h.order.push('redirects')
		if (h.redirectFail) throw h.redirectFail
		h.redirectCalls.push(hosts)
		return 'redirects: removed /opt/infra/traefik/dynamic/redirects-zorbweb.yml'
	},
}))
vi.mock('@/lib/ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		h.commands.push(cmd)
		h.order.push('remove')
		return h.runResult
	},
	withConnection: vi.fn(),
}))
vi.mock('@/lib/ssh', () => ({
	inspectContainer: async () => {
		if (h.inspectError) throw h.inspectError
		return {
		compose: { project: 'zorbweb', workingDir: '/opt/apps/zorbweb', service: 'zorbweb', configFile: '/opt/apps/zorbweb/docker-compose.yml', configFiles: [] },
		}
	},
	deleteRemoteFile: async () => {
		h.order.push('deploy-key')
	},
}))
vi.mock('@/lib/repos', () => ({
	getRepoFor: async () => h.repo,
	appNamesOnServer: async () => h.others,
	deleteRepo: async (rid: string) => {
		h.deleted.push(`app_repos:${rid}`)
		h.order.push('repo-row')
	},
}))
vi.mock('@/lib/github-disconnect', () => ({
	removeGithubObjects: async () => {
		h.order.push('github')
		return { deployKey: 'removed', hook: 'removed' }
	},
}))
vi.mock('@/lib/deleted-env', () => ({
	archiveAppEnvFiles: async () => {
		h.order.push('env-archive')
		return { status: 'archived', dir: '/var/lib/powder/deleted-env/zorbweb-x', detail: 'env files moved' }
	},
}))
vi.mock('@/lib/preview-deploys', () => ({
	tearDownPreview: async (pid: string) => {
		h.torn.push(pid)
		h.order.push('preview')
		return { note: null }
	},
}))
vi.mock('@/lib/db', () => {
	const q = (rows: () => unknown[]) => {
		const c = Object.assign(Promise.resolve().then(rows), {}) as Promise<unknown> & Record<string, unknown>
		for (const k of ['from', 'where', 'innerJoin', 'limit']) c[k] = () => c
		return c
	}
	const del = (t: { name: string }) => ({
		where: async () => {
			if (h.txFail && t.name === 'app_repos') throw new Error('db down')
			h.deleted.push(t.name)
			h.order.push(t.name)
		},
	})
	return {
		and: () => 0,
		eq: () => 0,
		appDomains: { name: 'app_domains' },
		cronJobs: { name: 'cron_jobs' },
		appRepos: { name: 'app_repos' },
		deploys: { name: 'deploys' },
		domainRedirects: { name: 'domain_redirects' },
		appUptimeChecks: { name: 'app_uptime_checks' },
		appEnvVars: { name: 'app_env_vars' },
		appEnvVarVersions: { name: 'app_env_var_versions' },
		previewDeploys: { name: 'preview_deploys' },
		db: {
			// by table: this app's previews (then, with a join, every preview on the
			// server), the app's redirect rows
			select: (cols: Record<string, unknown>) => ({
				from: (t: { name: string }) =>
					q(() =>
						t.name === 'domain_redirects' ? h.redirects : 'n' in cols ? [{ n: 'pv-quuxapi-feat' }] : h.previews,
					),
			}),
			delete: del,
			// The row deletes and the queued-deploy cancel run in one transaction.
			transaction: async <T,>(f: (tx: unknown) => Promise<T>) => {
				const staged: string[] = []
				const tx = {
					delete: (t: { name: string }) => ({
						where: async () => {
							if (h.txFail && t.name === 'app_repos') throw new Error('db down')
							staged.push(t.name)
						},
					}),
					update: (t: { name: string }) => ({
						set: () => ({
							where: () => ({
								returning: async () => {
									staged.push(`${t.name}:cancel-queued`)
									return h.queued
								},
							}),
						}),
					}),
				}
				const out = await f(tx)
				h.deleted.push(...staged)
				h.order.push(...staged)
				return out
			},
		},
	}
})

import { proxy } from '../../proxy'
import { DELETE as deleteApp } from '../../app/api/servers/[id]/containers/[name]/route'
import { POST as stopApp } from '../../app/api/servers/[id]/containers/[name]/stop/route'
import {
	keptOnServer,
	parseRemoveOutput,
	projectIsAppsOwn,
	projectNameSharedWith,
	removeAppShell,
	removeScope,
	stopCommand,
} from '../app-lifecycle'

const params = (name = 'zorbweb') => ({ params: Promise.resolve({ id: 'boxa', name }) })
const del = (body: unknown) =>
	deleteApp(new Request('http://x', { method: 'DELETE', body: typeof body === 'string' ? body : JSON.stringify(body) }), params())

beforeEach(() => {
	h.access = null
	h.user = sessionAdmin
	h.inFlight = false
	h.repo = { id: 'rep_1', containerName: 'zorbweb', repoUrl: 'git@github.com:zorb/zorbweb.git', ownerUserId: 'u1' }
	h.commands = []
	h.runResult = { code: 0, stdout: 'removed zorbweb\nremoved zorbweb-db\n__POWDER_APP_REMOVED__\n', stderr: '' }
	h.finished = []
	h.deleted = []
	h.torn = []
	h.previews = []
	h.order = []
	h.inspectError = null
	h.others = ['zorbweb', 'quuxapi']
	h.queued = []
	h.txFail = false
	h.redirects = []
	h.redirectCalls = []
	h.redirectFail = null
	h.progress = []
})

describe('stop command', () => {
	it('is built from the validated name only', () => {
		expect(stopCommand('zorbweb')).toMatchSnapshot()
	})
	it('refuses a name that is not a plain container name', () => {
		for (const bad of ['-rf', 'a;b', 'x y', '$(id)', '']) expect(() => stopCommand(bad)).toThrow(/unsafe container name/)
	})
})

describe('remove command', () => {
	const plan = {
		app: 'zorbweb',
		project: 'zorbweb',
		workingDir: '/opt/apps/zorbweb',
		service: 'zorbweb',
		protectedNames: ['quuxapi', 'powder', 'bad name;x'],
	}
	it('own compose project: by name and project label, under the per-app lock', () => {
		expect(removeAppShell(plan)).toMatchSnapshot()
	})
	it('a shared project: the app container only, the project is kept', () => {
		const sh = removeAppShell({ ...plan, project: 'legacyshared' })
		expect(sh).not.toContain('label=com.docker.compose.project=')
		expect(sh).toContain('kept the compose project legacyshared')
		expect(projectIsAppsOwn('zorbweb', 'legacyshared')).toBe(false)
		expect(projectIsAppsOwn('zorbweb', null)).toBe(true)
		expect(projectIsAppsOwn('Zorb.Web', 'zorbweb')).toBe(true)
	})
	it('another app or preview with the same compose project name: no project sweep, the app container only', () => {
		for (const other of ['zorb.web', 'Zorbweb', '_zorbweb']) {
			const sh = removeAppShell({ ...plan, protectedNames: [...plan.protectedNames, other] })
			expect(sh).not.toContain('label=com.docker.compose.project=')
			expect(sh).not.toContain('docker network rm')
			expect(sh).toContain('uses the same project name, only zorbweb was removed')
		}
		expect(projectNameSharedWith('web.app', ['webapp', 'web-app', 'web.app'])).toEqual(['webapp'])
		expect(removeScope(plan)).toEqual({ sweep: true, note: null })
		expect(removeScope({ ...plan, protectedNames: ['web.app'], app: 'webapp', project: 'webapp' }).sweep).toBe(false)
	})
	it('a project name shared with another app: the app container by name only (snapshot)', () => {
		expect(removeAppShell({ ...plan, protectedNames: [...plan.protectedNames, 'zorb.web'] })).toMatchSnapshot()
	})
	it('the project sweep keeps containers of the project created from another working dir', () => {
		const sh = removeAppShell(plan)
		expect(sh).toContain('com.docker.compose.project.working_dir')
		expect(sh).toContain('from another working dir')
	})
	it('never removes volumes, directories or files, never runs compose down', () => {
		const sh = removeAppShell(plan)
		expect(sh).not.toMatch(/docker (compose|volume)|rm -rf|rm -f -v|rm -v|\s-v\s|--volumes|down/)
		expect(sh).toContain("case \"$N\" in '\\''quuxapi'\\''|'\\''powder'\\'')")
		expect(sh).not.toContain('bad name')
	})
	it('refuses an unsafe app name or working dir', () => {
		expect(() => removeAppShell({ ...plan, app: 'x;rm' })).toThrow(/unsafe container name/)
		expect(() => removeAppShell({ ...plan, workingDir: 'relative/dir' })).toThrow(/unsafe working dir/)
	})
	it('parses the output; a failure or a missing end marker throws', () => {
		expect(parseRemoveOutput('removed zorbweb\nkept quuxapi (another app or powder itself)\n__POWDER_APP_REMOVED__', 0)).toEqual({
			removed: ['zorbweb'],
			kept: ['quuxapi (another app or powder itself)'],
			output: 'removed zorbweb\nkept quuxapi (another app or powder itself)',
		})
		expect(() => parseRemoveOutput('could not list containers (docker ps failed), nothing removed', 2)).toThrow(/docker ps failed/)
		expect(() => parseRemoveOutput('removed zorbweb', 0)).toThrow()
	})
	it('says what stays on the server', () => {
		expect(keptOnServer('zorbweb', '/opt/apps/zorbweb').join(' ')).toMatch(/\/opt\/apps\/zorbweb.*volumes.*deleted-env\/zorbweb-/)
	})
})

describe('stop route (same access as restart)', () => {
	it('answers the access check refusal (401 / 404)', async () => {
		h.access = Response.json({ error: 'unauthorized' }, { status: 401 })
		expect((await stopApp(new Request('http://x', { method: 'POST' }), params())).status).toBe(401)
		h.access = Response.json({ error: 'unknown container' }, { status: 404 })
		expect((await stopApp(new Request('http://x', { method: 'POST' }), params())).status).toBe(404)
		expect(h.commands).toEqual([])
	})
	it('409 while a deploy is in flight, nothing runs', async () => {
		h.inFlight = true
		expect((await stopApp(new Request('http://x', { method: 'POST' }), params())).status).toBe(409)
		expect(h.commands).toEqual([])
	})
	it('runs the stop command and records the deploys row (a token may, as for restart)', async () => {
		h.user = tokenAdmin
		h.runResult = { code: 0, stdout: 'zorbweb\n', stderr: '' }
		const res = await stopApp(new Request('http://x', { method: 'POST' }), params())
		expect(res.status).toBe(200)
		expect(h.commands).toEqual([stopCommand('zorbweb')])
		expect(h.finished).toEqual([{ id: 'dep_stop', status: 'success' }])
	})
	it('a failed stop is a failed row and a 500', async () => {
		h.runResult = { code: 1, stdout: 'stop refused: no container named zorbweb on this server', stderr: '' }
		const res = await stopApp(new Request('http://x', { method: 'POST' }), params())
		expect(res.status).toBe(500)
		expect(h.finished).toEqual([{ id: 'dep_stop', status: 'failed' }])
	})
})

describe('delete route (admin browser session only)', () => {
	it('answers the access check refusal', async () => {
		h.access = Response.json({ error: 'unauthorized' }, { status: 401 })
		expect((await del({ confirm: 'zorbweb' })).status).toBe(401)
	})
	it('refuses an API token and a non-admin with 403, before anything runs', async () => {
		h.user = tokenAdmin
		const r = await del({ confirm: 'zorbweb' })
		expect(r.status).toBe(403)
		expect(((await r.json()) as { code: string }).code).toBe('session_only')
		h.user = { ...sessionAdmin, isAdmin: false }
		expect((await del({ confirm: 'zorbweb' })).status).toBe(403)
		expect(h.commands).toEqual([])
		expect(h.deleted).toEqual([])
	})
	it('the proxy refuses any bearer token on the delete path, not on stop', () => {
		const req = (method: string, path: string) =>
			new NextRequest(`http://dash.example${path}`, { method, headers: { authorization: 'Bearer pwd_x' } })
		expect(proxy(req('DELETE', '/api/servers/boxa/containers/zorbweb')).status).toBe(403)
		expect(proxy(req('DELETE', '/api/servers/boxa/containers/%7Aorbweb')).status).toBe(403)
		expect(proxy(req('POST', '/api/servers/boxa/containers/zorbweb/stop')).status).not.toBe(403)
	})
	it('needs the typed app name', async () => {
		expect((await del({})).status).toBe(400)
		expect((await del({ confirm: 'zorbwe' })).status).toBe(400)
		expect((await del('not json')).status).toBe(400)
		expect(h.commands).toEqual([])
	})
	it('404 for a container that is not an app', async () => {
		h.repo = null
		expect((await del({ confirm: 'zorbweb' })).status).toBe(404)
	})
	it('409 while a deploy is in flight', async () => {
		h.inFlight = true
		expect((await del({ confirm: 'zorbweb' })).status).toBe(409)
		expect(h.commands).toEqual([])
	})
	it('removes the containers first, then previews, then the rows in one transaction; other apps and previews are protected', async () => {
		h.previews = [{ id: 'pv_1', containerName: 'pv-zorbweb-feat' }]
		const res = await del({ confirm: 'zorbweb' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { removed: string[]; keptOnServer: string[] }
		expect(body.removed).toEqual(['zorbweb', 'zorbweb-db'])
		expect(body.keptOnServer.join(' ')).toContain('/opt/apps/zorbweb')
		expect(h.torn).toEqual(['pv_1'])
		expect(h.commands).toHaveLength(1)
		expect(h.commands[0]).toContain("'\\''quuxapi'\\''")
		expect(h.commands[0]).toContain("'\\''pv-quuxapi-feat'\\''")
		expect(h.order).toEqual([
			'remove',
			'preview',
			'redirects',
			'deploy-key',
			'github',
			'cron_jobs',
			'app_domains',
			'domain_redirects',
			'app_uptime_checks',
			'app_env_vars',
			'app_env_var_versions',
			'app_repos',
			'deploys:cancel-queued',
			'env-archive',
		])
		expect(h.finished).toEqual([{ id: 'dep_delete', status: 'success' }])
	})
	it('a failed removal keeps every row', async () => {
		h.runResult = { code: 2, stdout: 'could not list containers (docker ps failed), nothing removed', stderr: '' }
		const res = await del({ confirm: 'zorbweb' })
		expect(res.status).toBe(500)
		expect(h.deleted).toEqual([])
		expect(h.finished).toEqual([{ id: 'dep_delete', status: 'failed' }])
	})
	it('a failed removal keeps the previews too (nothing irreversible before it)', async () => {
		h.previews = [{ id: 'pv_1', containerName: 'pv-zorbweb-feat' }]
		h.runResult = { code: 1, stdout: 'docker stop / rm failed', stderr: '' }
		expect((await del({ confirm: 'zorbweb' })).status).toBe(500)
		expect(h.torn).toEqual([])
		expect(h.order).toEqual(['remove'])
	})
	it('an inspect failure other than "no such container" fails the delete before anything runs', async () => {
		h.previews = [{ id: 'pv_1', containerName: 'pv-zorbweb-feat' }]
		h.inspectError = new Error('ssh: connect to host h port 22: Connection timed out')
		const res = await del({ confirm: 'zorbweb' })
		expect(res.status).toBe(500)
		expect(((await res.json()) as { error: string }).error).toMatch(/could not inspect zorbweb, nothing removed/)
		expect(h.commands).toEqual([])
		expect(h.torn).toEqual([])
		expect(h.deleted).toEqual([])
		expect(h.finished).toEqual([{ id: 'dep_delete', status: 'failed' }])
	})
	it('a container that is already gone: the app is removed by its conventional dir', async () => {
		h.inspectError = new Error('Error: No such object: zorbweb')
		const res = await del({ confirm: 'zorbweb' })
		expect(res.status).toBe(200)
		expect(h.commands[0]).toContain('/opt/apps/zorbweb')
		expect(h.deleted).toContain('app_repos')
	})
	it('another app with the same compose project name: only the app container is removed, and the answer says so', async () => {
		h.others = ['zorbweb', 'zorb.web']
		const res = await del({ confirm: 'zorbweb' })
		expect(res.status).toBe(200)
		expect(h.commands[0]).not.toContain('label=com.docker.compose.project=')
		const body = (await res.json()) as { projectNote: string | null }
		expect(body.projectNote).toMatch(/zorb\.web uses the same project name, only zorbweb was removed/)
	})
	it('fails the queued deploys of the app in the same transaction as the rows', async () => {
		h.queued = [{ id: 'dep_q1' }]
		expect((await del({ confirm: 'zorbweb' })).status).toBe(200)
		expect(h.deleted).toEqual([
			'cron_jobs',
			'app_domains',
			'domain_redirects',
			'app_uptime_checks',
			'app_env_vars',
			'app_env_var_versions',
			'app_repos',
			'deploys:cancel-queued',
		])
	})
	it('removes the proxy redirects after the containers and before the rows; only applied hostnames', async () => {
		h.redirects = [
			{ hostname: 'zorb.example', appliedAt: new Date() },
			{ hostname: 'draft.zorb.example', appliedAt: null },
		]
		expect((await del({ confirm: 'zorbweb' })).status).toBe(200)
		expect(h.redirectCalls).toEqual([['zorb.example']])
		expect(h.order.indexOf('redirects')).toBeGreaterThan(h.order.indexOf('remove'))
		expect(h.order.indexOf('redirects')).toBeLessThan(h.order.indexOf('domain_redirects'))
		expect(h.progress).toContain('redirects: removed /opt/infra/traefik/dynamic/redirects-zorbweb.yml')
	})
	it('a failed redirect removal fails the delete and keeps every row, so it can be run again', async () => {
		h.redirectFail = new Error('traefik redirect cleanup failed (exit 1)')
		const res = await del({ confirm: 'zorbweb' })
		expect(res.status).toBe(500)
		expect(((await res.json()) as { error: string }).error).toContain('traefik redirect cleanup failed')
		expect(h.deleted).toEqual([])
		expect(h.finished).toEqual([{ id: 'dep_delete', status: 'failed' }])
		h.redirectFail = null
		expect((await del({ confirm: 'zorbweb' })).status).toBe(200)
		expect(h.deleted).toContain('domain_redirects')
	})
	it('writes progress at every stage, so the row is never silent while the delete runs', async () => {
		h.previews = [{ id: 'pv_1', containerName: 'pv-zorbweb-feat' }]
		expect((await del({ confirm: 'zorbweb' })).status).toBe(200)
		expect(h.progress[0]).toMatch(/inspecting the container/)
		expect(h.progress).toContain('preview pv-zorbweb-feat: torn down')
		expect(h.progress.some((l) => l.startsWith('env files:'))).toBe(true)
	})
	it('a failed transaction deletes no row and the delete can be run again', async () => {
		h.txFail = true
		expect((await del({ confirm: 'zorbweb' })).status).toBe(500)
		expect(h.deleted).toEqual([])
		h.txFail = false
		expect((await del({ confirm: 'zorbweb' })).status).toBe(200)
		expect(h.deleted).toContain('app_repos')
	})
})
