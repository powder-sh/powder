// env write = code exec. A bearer token (or a non-admin session)
// must not set runtime-loader keys on any env write path; an admin browser
// session can. NODE_OPTIONS keeps a safe value pattern for tokens. powder's own
// containers are refused on every write/delete route.
import { beforeEach, describe, expect, it, vi } from 'vitest'

process.env.POWDER_ENCRYPTION_KEY = 'ab'.repeat(32)

let user: Record<string, unknown> = {}
let repoRow: Record<string, unknown> = { id: 'repo_1', serverId: 's', containerName: 'app' }
let diskFile = ''
const writeEnvFile = vi.fn()

vi.mock('@/lib/access', () => ({
	// the one project access check, run on the mocked db and the real powderSelfDenied
	requireProjectAccess: async (id: string) => {
		const { db, appRepos, eq } = (await import('@/lib/db')) as unknown as { db: { select: () => { from: (t: unknown) => { where: (w: unknown) => { limit: (n: number) => Promise<Array<{ containerName?: string }>> } } } }; appRepos: { id: unknown }; eq: (a: unknown, b: unknown) => unknown }
		const [repo] = await db.select().from(appRepos).where(eq(appRepos.id, id)).limit(1)
		if (!repo) return Response.json({ error: 'not found' }, { status: 404 })
		const { powderSelfDenied } = await vi.importActual<typeof import('../secret-mask')>('../secret-mask')
		return powderSelfDenied(repo.containerName ?? '') ?? { user: user, repo }
	},
	requireUser: async () => user,
	requireContainerAccess: async () => ({ user, server: { id: 's', kind: 'compose' } }),
}))
vi.mock('@/lib/ssh', () => ({
	findEnvFile: async () => ({ path: '/opt/apps/app.env', exists: true, contents: diskFile }),
	readEnvFile: async () => ({ exists: true, contents: diskFile }),
	envFileCandidatesFor: async () => ['/opt/apps/app.env'],
	readEnvRestoreMarker: async () => null,
	inspectContainer: async () => ({ env: [] }),
	writeEnvFile: (...a: unknown[]) => writeEnvFile(...a),
}))
vi.mock('@/lib/servers', () => ({ getServer: async () => ({ id: 's' }) }))
vi.mock('@/lib/db', async () => {
	const chain = () => {
		const c: Record<string, unknown> = {}
		for (const m of ['select', 'from', 'where', 'for']) c[m] = () => c
		c.limit = async () => [repoRow]
		return c
	}
	return {
		and: () => 0,
		eq: () => 0,
		desc: () => 0,
		sql: Object.assign(() => 0, { join: () => 0 }),
		createId: () => 'id',
		prefixes: { envVar: 'env' },
		appRepos: {},
		appEnvVars: {},
		appEnvVarAudit: {},
		appEnvVarVersions: {},
		powderMeta: {},
		db: {
			select: () => chain(),
			// the env render target pin (powder_meta)
			insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
			// Reaching the transaction means the write was allowed.
			transaction: async () => {
				throw new Error('WRITE_REACHED')
			},
		},
	}
})

import { DELETE } from '../../app/api/projects/[id]/env/[key]/route'
import { PUT, POST as importPOST } from '../../app/api/projects/[id]/env/route'
import { PUT as envFilePUT } from '../../app/api/servers/[id]/containers/[name]/env-file/route'
import { envKeyWriteDenied, isLoaderEnvKey } from '../env-key-policy'
import { mcpWriteScopesForApps, tokenAllows } from '../token-scopes'

const ctx = { params: Promise.resolve({ id: 'repo_1' }) }
const token = { id: 'u', isAdmin: true, viaToken: true, tokenScopes: null }
const admin = { id: 'u', isAdmin: true }
const put = async (key: string, value: string): Promise<Response> =>
	(await PUT(
		new Request('http://x/api/projects/repo_1/env', {
			method: 'PUT',
			body: JSON.stringify({ key, value }),
		}),
		ctx,
	)) as Response

describe('loader-key policy', () => {
	it('names every listed key and prefix', () => {
		for (const k of [
			'NODE_OPTIONS',
			'NODE_PATH',
			'LD_PRELOAD',
			'LD_LIBRARY_PATH',
			'LD_AUDIT',
			'BASH_ENV',
			'ENV',
			'PROMPT_COMMAND',
			'PYTHONSTARTUP',
			'PYTHONPATH',
			'PYTHONHOME',
			'PERL5OPT',
			'PERL5LIB',
			'RUBYOPT',
			'RUBYLIB',
			'JAVA_TOOL_OPTIONS',
			'_JAVA_OPTIONS',
			'JDK_JAVA_OPTIONS',
			'DOTNET_STARTUP_HOOKS',
			'COMPOSE_FILE',
			'DOCKER_HOST',
			'GIT_SSH_COMMAND',
			'SSH_AUTH_SOCK',
			'HOME',
			'PATH',
			'SHELL',
			'ld_preload',
		]) {
			expect(isLoaderEnvKey(k), k).toBe(true)
		}
		for (const k of ['DATABASE_URL', 'NODE_ENV', 'PORT', 'ENVIRONMENT', 'MAIL_API_KEY']) {
			expect(isLoaderEnvKey(k), k).toBe(false)
		}
	})
	it('NODE_OPTIONS safe values pass for tokens only with NODE_OPTIONS in POWDER_TOKEN_ENV_ALLOW, anything else does not', () => {
		expect(envKeyWriteDenied('NODE_OPTIONS', '--max-old-space-size=2048', false)).not.toBeNull()
		vi.stubEnv('POWDER_TOKEN_ENV_ALLOW', 'NODE_OPTIONS')
		try {
		for (const v of [
			'--max-old-space-size=2048',
			'--enable-source-maps',
			'--max-old-space-size=4096 --dns-result-order=ipv4first',
		]) {
			expect(envKeyWriteDenied('NODE_OPTIONS', v, false), v).toBeNull()
		}
		for (const v of [
			'--require /tmp/x.js',
			'--max-old-space-size=1 --import=data:x',
			'-r ./x',
			'',
		]) {
			expect(envKeyWriteDenied('NODE_OPTIONS', v, false), v).not.toBeNull()
		}
		} finally {
			vi.unstubAllEnvs()
		}
		expect(envKeyWriteDenied('LD_PRELOAD', '/x.so', true)).toBeNull()
	})
})

describe('env write routes', () => {
	beforeEach(() => {
		repoRow = { id: 'repo_1', serverId: 's', containerName: 'app' }
		writeEnvFile.mockClear()
	})

	it('PUT: a token cannot set NODE_OPTIONS=--require or LD_PRELOAD', async () => {
		user = token
		const r1 = await put('NODE_OPTIONS', '--require /tmp/evil.js')
		expect(r1.status).toBe(403)
		const r2 = await put('LD_PRELOAD', '/tmp/evil.so')
		expect(r2.status).toBe(403)
	})
	it('PUT: a non-admin session is refused too', async () => {
		user = { id: 'u', isAdmin: false }
		expect((await put('BASH_ENV', '/tmp/x')).status).toBe(403)
	})
	it('PUT: a token may set credential keys (NODE_OPTIONS and other keys are refused)', async () => {
		user = token
		const r = await put('NODE_OPTIONS', '--max-old-space-size=2048')
		expect(r.status).toBe(403)
		// a destination key (API_URL) is admin-only; so is a non-credential key
		const r2 = await put('FEATURE_FLAG_X', 'on')
		expect(r2.status).toBe(403)
		const r3 = await put('PAYMENTS_WEBHOOK_SECRET', 'whsec-1')
		expect((await r3.json()).error).toBe('WRITE_REACHED')
	})
	it('PUT: an admin browser session may set any key', async () => {
		user = admin
		const r = await put('LD_PRELOAD', '/usr/lib/libjemalloc.so')
		expect((await r.json()).error).toBe('WRITE_REACHED')
	})
	it('bulk import: a token import skips and names loader keys', async () => {
		user = token
		const res = (await importPOST(
			new Request('http://x/api/projects/repo_1/env', {
				method: 'POST',
				body: JSON.stringify({ text: 'PYTHONSTARTUP=/tmp/x.py\nGIT_SSH_COMMAND=sh\n' }),
			}),
			ctx,
		)) as Response
		const body = await res.json()
		expect(body.deniedKeys).toEqual(['PYTHONSTARTUP', 'GIT_SSH_COMMAND'])
		expect(body.imported).toBe(0)
	})
	it('env-file PUT: a token cannot add a loader key, nor save one unchanged (no guess oracle)', async () => {
		user = token
		diskFile = 'NODE_OPTIONS=--require ./trace.js\nA_SECRET=1\n'
		const mk = (entries: { key: string; value: string }[]) =>
			envFilePUT(
				new Request('http://x/api/servers/s/containers/app/env-file', {
					method: 'PUT',
					body: JSON.stringify({ entries }),
				}),
				{ params: Promise.resolve({ id: 's', name: 'app' }) },
			)
		const bad = await mk([
			{ key: 'NODE_OPTIONS', value: '--require ./trace.js' },
			{ key: 'LD_PRELOAD', value: '/tmp/x.so' },
		])
		expect(bad.status).toBe(403)
		expect(writeEnvFile).not.toHaveBeenCalled()
		const ok = await mk([
			{ key: 'NODE_OPTIONS', value: '--require ./trace.js' },
			{ key: 'A_SECRET', value: '2' },
		])
		// passing the unchanged value would tell a token its guess was right
		expect(ok.status).toBe(403)
		expect(((await ok.json()) as { code: string }).code).toBe('token_env_file')
		expect(writeEnvFile).not.toHaveBeenCalled()
	})
	it('DELETE by a token follows the same rule; an admin session deletes any key', async () => {
		repoRow = { id: 'repo_1', serverId: 's', containerName: 'app' }
		const del = async (key: string) => {
			try {
				return ((await DELETE(new Request(`http://x/api/projects/repo_1/env/${key}`, { method: 'DELETE' }), {
					params: Promise.resolve({ id: 'repo_1', key }),
				})) as Response).status
			} catch {
				return 'REACHED_DB'
			}
		}
		user = token
		for (const k of ['NODE_ENV', 'CORS_ORIGIN', 'DATABASE_URL', 'NEXT_PUBLIC_ANALYTICS_SRC']) expect(await del(k), k).toBe(403)
		expect(await del('WEBHOOK_SECRET_DEMOAPP')).not.toBe(403)
		user = admin
		expect(await del('NODE_ENV')).not.toBe(403)
	})
	it('a right and a wrong guess of a value get the same answer', async () => {
		user = token
		repoRow = { id: 'repo_1', serverId: 's', containerName: 'app' }
		diskFile = 'DATABASE_URL=postgres://zorb:hunter2@db/zorb\nA_SECRET=1\n'
		const put = async (guess: string) => {
			const r = (await envFilePUT(
				new Request('http://x/api/servers/s/containers/app/env-file', {
					method: 'PUT',
					body: JSON.stringify({ entries: [{ key: 'DATABASE_URL', value: guess }, { key: 'A_SECRET', value: '2' }] }),
				}),
				{ params: Promise.resolve({ id: 's', name: 'app' }) },
			)) as Response
			return `${r.status} ${await r.text()}`
		}
		const right = await put('postgres://zorb:hunter2@db/zorb')
		const wrong = await put('postgres://zorb:guess@db/zorb')
		expect(right).toBe(wrong)
		expect(right.startsWith('403 ')).toBe(true)
		expect(writeEnvFile).not.toHaveBeenCalled()
	})
	it('an env-file PUT by a token that drops a non-credential key is refused', async () => {
		user = token
		repoRow = { id: 'repo_1', serverId: 's', containerName: 'app' }
		diskFile = 'NODE_ENV=production\nA_SECRET=1\n'
		const r = (await envFilePUT(
			new Request('http://x/api/servers/s/containers/app/env-file', {
				method: 'PUT',
				body: JSON.stringify({ entries: [{ key: 'A_SECRET', value: '1' }] }),
			}),
			{ params: Promise.resolve({ id: 's', name: 'app' }) },
		)) as Response
		expect(r.status).toBe(403)
		expect((await r.json()).code).toBe('token_env_file')
	})
	it("write and delete routes refuse powder's own containers", async () => {
		user = admin
		repoRow = { id: 'repo_1', serverId: 's', containerName: 'powder-worker' }
		expect((await put('A', 'b')).status).toBe(404)
		const del = (await DELETE(
			new Request('http://x/api/projects/repo_1/env/A', { method: 'DELETE' }),
			{
				params: Promise.resolve({ id: 'repo_1', key: 'A' }),
			},
		)) as Response
		expect(del.status).toBe(404)
	})
})

describe('per-app MCP write scopes', () => {
	it('covers only the chosen apps for env PUT and redeploy', () => {
		const s = mcpWriteScopesForApps(['repo_a', 'repo_a', 'bad/../id'])
		expect(tokenAllows(s, 'PUT /api/projects/repo_a/env')).toBe(true)
		expect(tokenAllows(s, 'POST /api/projects/repo_a/redeploy')).toBe(true)
		expect(tokenAllows(s, 'PUT /api/projects/repo_b/env')).toBe(false)
		expect(tokenAllows(s, 'POST /api/projects/repo_b/redeploy')).toBe(false)
		expect(tokenAllows(s, 'GET /api/projects/repo_b/env')).toBe(true)
		expect(s.filter((x) => x.includes('repo_a'))).toHaveLength(2)
	})
})
