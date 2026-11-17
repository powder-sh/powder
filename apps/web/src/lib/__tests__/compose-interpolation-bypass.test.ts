// The stored structural hash must see interpolated values. A tracked
// `.env` change (DATA_DIR=./data -> DATA_DIR=/) feeding `${DATA_DIR}:/data` leaves the
// --no-interpolate config identical, so a hash of that would let the second push through
// in warn mode on the workdir layout (no src/ reset). The hash comes from the RESOLVED
// config without powder's override file: the .env change is a change, a domain label
// powder writes into its override is not.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
	probes: [] as string[],
	scriptRuns: [] as Array<{ code: number; stdout: string }>,
	scripts: [] as string[],
	cmds: [] as string[],
}
vi.mock('../ssh/connection', () => ({
	runCommand: async (_s: unknown, cmd: string) => {
		state.cmds.push(cmd)
		if (/__POWDER_CG_SEP_[0-9a-f]+__/.test(cmd))
			return { stdout: (state.probes.shift() ?? '').split('__POWDER_CG_SEP__').join(cmd.match(/__POWDER_CG_SEP_[0-9a-f]+__/)?.[0] ?? ''), stderr: '', code: 0 }
		if (cmd.startsWith('timeout -k')) {
			// the script prints the marker tagged with its nonce; take it from the script
			const run = state.scriptRuns.shift() ?? { code: 0, stdout: '' }
			const m = state.scripts[state.scripts.length - 1]?.match(
				/__POWDER_COMPOSE_CHANGED_[A-Za-z0-9]+__/,
			)?.[0]
			const raw = (run as { raw?: boolean }).raw === true
			return {
				...run,
				stdout: m && !raw ? run.stdout.split('__POWDER_COMPOSE_CHANGED__').join(m) : run.stdout,
				stderr: '',
			}
		}
		// workdir layout: no src/.git, nothing is reset
		if (cmd.includes('__POWDER_RESET_WORKDIR__'))
			return { stdout: '__POWDER_RESET_WORKDIR__\n', stderr: '', code: 0 }
		return { stdout: '', stderr: '', code: 0 }
	},
}))
vi.mock('../ssh/files', () => ({
	writeFileViaSftp: async (_s: unknown, _p: string, script: string) => {
		state.scripts.push(script)
	},
}))

import { checkComposeForDeploy, structuralComposeHash } from '../deploy/compose-check'
import { rebuildDeploy } from '../deploy/run'

const server = { id: 's1', name: 's1', host: 'h', user: 'root', port: 22, kind: 'compose' as const }
const svc = (extra: Record<string, unknown> = {}) => ({
	image: 'myapp:latest',
	container_name: 'myapp',
	...extra,
})
const resolved = (dataDir: string, labels?: Record<string, string>) => ({
	name: 'myapp',
	services: {
		myapp: svc({
			volumes: [{ type: 'bind', source: dataDir, target: '/data' }],
			...(labels ? { labels } : {}),
		}),
	},
})
const raw = (labels?: Record<string, string>) => ({
	name: 'myapp',
	services: {
		myapp: svc({
			volumes: [{ type: 'bind', source: '${DATA_DIR}', target: '/data' }],
			...(labels ? { labels } : {}),
		}),
	},
})
/** probe: [pinned hash, resolved WITH override, raw, ps, resolved WITHOUT override] */
const probe = (hash: string, withOverride: unknown, rawDoc: unknown, user: unknown) =>
	[
		hash.repeat(64),
		JSON.stringify(withOverride),
		JSON.stringify(rawDoc),
		'',
		JSON.stringify(user),
	].join('\n__POWDER_CG_SEP__\n')
const SAFE = '/opt/apps/myapp/data'
const BASELINE = structuralComposeHash(resolved(SAFE), raw())
const run = () =>
	rebuildDeploy(
		server as never,
		'/opt/apps/myapp',
		'/opt/apps/myapp/docker-compose.yml',
		'myapp',
		'dep_1',
		undefined,
		{
			deadlineAt: Date.now() + 3_600_000,
			baseSha: '1'.repeat(40),
			approvedComposeHash: BASELINE,
		},
	)

beforeEach(() => {
	state.scripts = []
	state.cmds = []
	process.env.POWDER_COMPOSE_GUARD = 'warn'
})

describe('workdir layout, .env-only change', () => {
	it('push 1 is refused by the re-check, push 2 (a no-op on the tree push 1 left) is refused too', async () => {
		// push 1: the git sync rewrites the tracked .env, the hash moves, the re-check sees "/"
		state.probes = [
			probe('a', resolved(SAFE), raw(), resolved(SAFE)),
			probe('c', resolved('/'), raw(), resolved('/')),
		]
		state.scriptRuns = [{ code: 1, stdout: '__POWDER_COMPOSE_CHANGED__\n' }]
		await expect(run()).rejects.toThrow(/high-severity[\s\S]*bind/)
		expect(state.cmds.join('\n')).toContain('__POWDER_RESET_WORKDIR__')
		// push 2: nothing moves during its sync; the tree on disk still resolves to "/"
		state.probes = [probe('c', resolved('/'), raw(), resolved('/'))]
		state.scriptRuns = [{ code: 0, stdout: '' }]
		state.scripts = []
		await expect(run()).rejects.toThrow(/differs from the last successful deploy[\s\S]*bind/)
		expect(state.scripts).toHaveLength(0)
	})
	it('the hash differs although the --no-interpolate config is identical', () => {
		expect(structuralComposeHash(resolved('/'), raw())).not.toBe(BASELINE)
	})
})

describe("powder's own override does not count", () => {
	it('a domain label powder wrote into its override file does not trigger the high-severity check', async () => {
		const label = { 'traefik.http.routers.myapp.rule': 'Host(`new.example.com`)' }
		// network_mode: host is a high-severity finding: only a WARN when the structure is unchanged
		const user = { name: 'myapp', services: { myapp: svc({ network_mode: 'host' }) } }
		const approvedHash = structuralComposeHash(user, user)
		const withOverride = {
			name: 'myapp',
			services: { myapp: svc({ network_mode: 'host', labels: label }) },
		}
		state.probes = [probe('d', withOverride, withOverride, user)]
		const r = await checkComposeForDeploy(
			server,
			'-f c.yml -f docker-compose.powder.yml',
			{
				appName: 'myapp',
				workingDir: '/opt/apps/myapp',
				composeFiles: ['/opt/apps/myapp/docker-compose.yml'],
				routeHosts: null,
				userCf: '-f c.yml',
				approvedHash,
			},
			{ POWDER_COMPOSE_GUARD: 'warn' },
		)
		expect(r.log).toContain('[compose-guard] WARN myapp network_mode')
		expect(r.structuralHash).toBe(approvedHash)
		expect(state.cmds.at(-1)).toContain("docker compose -f c.yml --profile '*' config --format json")
	})
})
