import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deployFailureFromError, DeployStepError, parseDeployFailure } from '../deploy-failure'
import { overridePathFor } from '../compose-override'
import { shouldRollbackAfterFailure } from '../deploy-runner'
import { parseHealthUrl, rollbackSummary } from '../deploys'
import { pathsMatch } from '../paths-match'
import { decideHostKey, hostKeyFingerprint, hostKeyType } from '../ssh-host-keys'
import {
	bridgeShellFunctions,
	buildDeployScript,
	composeFileArgs,
	gitResolveTarget,
	infraCountShell,
	infraServicesFromConfig,
} from '../ssh'
import { writeFakeDocker } from './fixtures/fake-docker'

const bashSyntaxOk = (script: string) => {
	const dir = mkdtempSync(join(tmpdir(), 'powder-deploy-'))
	const f = join(dir, 'deploy.sh')
	writeFileSync(f, script)
	execFileSync('bash', ['-n', f]) // throws on a syntax error
}

const baseScript = {
	workingDir: '/opt/apps/demo',
	configFile: '/opt/apps/demo/docker-compose.yml',
	service: 'app',
	cf: composeFileArgs('/opt/apps/demo/docker-compose.yml'),
	declaredMode: 'build',
	prebuilt: false,
	migrateApp: 'demo',
	infra: ['db'],
	wantBranch: 'main',
	wantSha: null,
	shaIsStrict: false,
}

describe('pathsMatch (monorepo fan-out)', () => {
	it('deploys everything when there is no filter or no change list', () => {
		expect(pathsMatch(null, ['a/b.ts'])).toBe(true)
		expect(pathsMatch([], ['a/b.ts'])).toBe(true)
		expect(pathsMatch(['api/**'], [])).toBe(true)
	})
	it('matches dir/**, dir/, dir and exact paths', () => {
		expect(pathsMatch(['api/**'], ['api/src/x.ts'])).toBe(true)
		expect(pathsMatch(['api/'], ['api/src/x.ts'])).toBe(true)
		expect(pathsMatch(['api'], ['api/src/x.ts'])).toBe(true)
		expect(pathsMatch(['package.json'], ['package.json'])).toBe(true)
	})
	it('does not match a sibling prefix', () => {
		expect(pathsMatch(['api/**'], ['api-v2/x.ts', 'web/y.ts'])).toBe(false)
	})
})

describe('parseDeployFailure / deployFailureFromError', () => {
	it('takes step + code from the last __POWDER_FAIL__ marker', () => {
		const log = '── docker compose build (local build) ──\nboom\n__POWDER_FAIL__ step=docker compose build (local build) code=2\n'
		const f = parseDeployFailure(log)
		expect(f.failedStep).toBe('docker compose build (local build)')
		expect(f.exitCode).toBe(2)
	})
	it('summarizes from the failing step only, not earlier noise', () => {
		const log =
			'── docker compose build (local build) ──\nECONNREFUSED 127.0.0.1:5432 (harmless at build)\n' +
			'── db migrate ──\nrelation "users" already exists\n__POWDER_FAIL__ step=db migrate code=1\n'
		expect(parseDeployFailure(log).errorSummary).toMatch(/migration collision: users already exists/)
	})
	it('names a lockfile the image package manager rejects (npm and pnpm)', () => {
		const npm = '#11 1.425 npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.\n__POWDER_FAIL__ step=docker compose build (local build) code=1'
		expect(parseDeployFailure(npm).errorSummary).toMatch(/lockfile rejected/)
		const pnpm = ' ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation.\n__POWDER_FAIL__ step=docker compose build (local build) code=1'
		expect(parseDeployFailure(pnpm).errorSummary).toMatch(/lockfile rejected/)
	})
	it('names the pages/app test-file preflight', () => {
		const log = 'preflight: test file inside pages/app tree: pages/api/x.test.ts — Next…\n__POWDER_FAIL__ step=preflight pages-test-files code=1'
		expect(parseDeployFailure(log).errorSummary).toMatch(/pages\/api\/x\.test\.ts/)
	})
	it('keeps DeployStepError fields and pattern-matches plain errors', () => {
		const e = new DeployStepError('x\n__POWDER_FAIL__ step=docker compose up code=1\ncontainer name "/api-worker" is already in use')
		expect(deployFailureFromError(e).failedStep).toBe('docker compose up')
		const plain = deployFailureFromError(new Error('SSH timeout to 1.2.3.4'))
		expect(plain.failedStep).toBeNull()
		expect(plain.errorSummary).toMatch(/SSH timed out to 1\.2\.3\.4/)
	})
	it('reads the env-render marker the runner emits', () => {
		expect(deployFailureFromError(new Error('env render failed: x\n__POWDER_FAIL__ step=env render code=1')).failedStep).toBe('env render')
	})
})

describe('parseHealthUrl (resolveHealthProbe)', () => {
	it('absolute URL → path + its own host', () => {
		expect(parseHealthUrl('https://x.com/api/health?deep=1')).toEqual({ path: '/api/health?deep=1', host: 'x.com' })
	})
	it('bare path → path + the primary live hostname', () => {
		expect(parseHealthUrl('/api/health', 'app.com')).toEqual({ path: '/api/health', host: 'app.com' })
		expect(parseHealthUrl('api/health')).toEqual({ path: '/api/health', host: undefined })
	})
	it('empty → null (the lenient gate)', () => {
		expect(parseHealthUrl('   ')).toBeNull()
	})
})

describe('shouldRollbackAfterFailure', () => {
	it('always rolls back a failure at/after the swap', () => {
		expect(shouldRollbackAfterFailure('docker compose up', true)).toBe(true)
		expect(shouldRollbackAfterFailure('docker compose up', null)).toBe(true)
		expect(shouldRollbackAfterFailure('resolve image', true)).toBe(true)
	})
	it('never rolls back a pre-swap failure (old container untouched)', () => {
		expect(shouldRollbackAfterFailure('docker compose build (local build)', false)).toBe(false)
		expect(shouldRollbackAfterFailure('test gate', false)).toBe(false)
		expect(shouldRollbackAfterFailure('env render', false)).toBe(false)
	})
	it('unknown step: rolls back only when the app is not running', () => {
		expect(shouldRollbackAfterFailure(null, false)).toBe(true)
		expect(shouldRollbackAfterFailure(null, true)).toBe(false)
		expect(shouldRollbackAfterFailure(null, null)).toBe(false)
	})
})

describe('rollbackSummary', () => {
	it('is honest about an unhealthy rollback', () => {
		expect(rollbackSummary('health check failed', { rolledBackTo: 'a:deploy-1', rollbackError: null, rollbackHealthy: false })).toMatch(
			/ALSO unhealthy/,
		)
		expect(rollbackSummary('health check failed', { rolledBackTo: 'a:deploy-1', rollbackError: null, rollbackHealthy: true })).toBe(
			'health check failed; auto-rolled back to a:deploy-1',
		)
		expect(rollbackSummary('x', { rolledBackTo: null, rollbackError: 'boom', rollbackHealthy: null })).toMatch(/rollback also failed: boom/)
	})
})

describe('infraServicesFromConfig', () => {
	const cfg = {
		services: {
			app: { build: { context: '/opt/apps/x/src' }, image: 'x:latest' },
			database: { image: 'postgres:17-alpine' },
			cache: { image: 'bitnami/redis:7' },
			vec: { image: 'pgvector/pgvector:pg16' },
			store: { image: 'custom/thing:1', volumes: [{ type: 'volume', source: 'd', target: '/var/lib/mysql' }] },
			worker: { image: 'ghcr.io/me/worker:latest', volumes: [{ type: 'volume', source: 'u', target: '/app/uploads' }] },
			db: { build: { context: '.' } },
		},
	}
	it('detects infra by image and data volume, not only by service name', () => {
		expect(infraServicesFromConfig(cfg, 'app').sort()).toEqual(['cache', 'database', 'store', 'vec'])
	})
	it('never counts the app itself or anything we build', () => {
		expect(infraServicesFromConfig(cfg, 'database')).not.toContain('database')
		expect(infraServicesFromConfig(cfg, 'app')).not.toContain('db')
	})
	it('also detects infra by service name', () => {
		expect(infraServicesFromConfig({ services: { app: {}, redis: { image: 'x' } } }, 'app')).toEqual(['redis'])
	})
	it('tolerates garbage', () => {
		expect(infraServicesFromConfig(null, 'app')).toEqual([])
		expect(infraServicesFromConfig({ services: 7 }, 'app')).toEqual([])
	})
})

describe('compose/git script fragments', () => {
	it('passes every compose file', () => {
		const user = (a: string[]) => composeFileArgs('/a/c.yml', a, { override: false })
		expect(user(['/a/c.yml', '/a/c.override.yml'])).toBe("-f '/a/c.yml' -f '/a/c.override.yml'")
		expect(user([])).toBe("-f '/a/c.yml'")
		// powder's own override is the LAST -f, only when it exists on the server
		const all = composeFileArgs('/a/c.yml', ['/a/c.yml', '/a/c.override.yml'])
		const abs = overridePathFor('/a/c.yml', ['/a/c.yml', '/a/c.override.yml'])
		expect(abs.startsWith('/var/lib/powder/compose/')).toBe(true)
		expect(all).toBe(`-f '/a/c.yml' -f '/a/c.override.yml' $([ -f '${abs}' ] && printf '%s %s' -f '${abs}')`)
		// a stale copy in the container's config_files label is dropped and re-added last
		const stale = composeFileArgs('/a/c.yml', ['/a/c.yml', abs, '/a/docker-compose.powder.yml', '/a/c.override.yml'])
		expect(stale).toBe(all)
	})
	it('infra count falls back to the name heuristic when the config was unreadable', () => {
		expect(infraCountShell(null)).toMatch(/grep -cE/)
		expect(infraCountShell(['db', 'cache'])).toMatch(/^HAS_INFRA=2 /)
	})
	it('pins the sha; strict pin refuses a different commit', () => {
		const loose = gitResolveTarget("'*'", 'main', 'a'.repeat(40), false)
		expect(loose).toMatch(/TARGET="\$SHA"/)
		expect(loose).toMatch(/building origin\/\$BR instead/)
		expect(gitResolveTarget("'*'", 'main', 'a'.repeat(40), true)).toMatch(/refusing to sync a different commit/)
		expect(gitResolveTarget("'*'", null, null, false)).not.toMatch(/SHA=/)
	})
})

describe('buildDeployScript', () => {
	it('is valid bash in every mode', () => {
		for (const v of [
			baseScript,
			{ ...baseScript, prebuilt: true, wantSha: 'b'.repeat(40), shaIsStrict: true },
			{ ...baseScript, declaredMode: 'registry', infra: null, wantBranch: null },
			{ ...baseScript, declaredMode: 'auto', cf: composeFileArgs('/x/c.yml', ['/x/c.yml', '/x/o.yml']) },
		]) {
			bashSyntaxOk(buildDeployScript(v))
		}
	})
	it('carries the deadline, strict GitHub host keys, no pre-gate tagging', () => {
		const s = buildDeployScript(baseScript)
		expect(s).toMatch(/DEADLINE=\$\(\( \$\(date \+%s\) \+ 3300 \)\)/)
		expect(s).toMatch(/StrictHostKeyChecking=yes -o UserKnownHostsFile=\$PKH/)
		expect(s).not.toMatch(/StrictHostKeyChecking=no/)
		expect(s).not.toMatch(/docker tag /)
		expect(s).toMatch(/flock -w "\$\(left 300\)"/)
		expect(s).toMatch(/HAS_INFRA=1 /)
	})
	it('matches the snapshot', () => {
		expect(buildDeployScript({ ...baseScript, wantSha: 'c'.repeat(40) })).toMatchSnapshot()
	})
	it('matches the snapshot (ordinal / supersede script)', () => {
		expect(
			buildDeployScript({ ...baseScript, wantSha: 'c'.repeat(40), swapOrdinal: 1_700_000_000_000, stageId: 'dep_snap' }),
		).toMatchSnapshot()
		expect(
			buildDeployScript({ ...baseScript, prebuilt: true, swapOrdinal: 1_700_000_000_000, stageId: 'dep_snap', stageImage: 'demo:build-snap' }),
		).toMatchSnapshot()
	})
})

describe('release phase (opt-in pre-swap)', () => {
	const script = buildDeployScript(baseScript)
	const staged = buildDeployScript({ ...baseScript, swapOrdinal: 1700000000000, stageId: 'dep_abc' })
	it('is skipped with a log line when the image has no powder.release.cmd label', () => {
		expect(script).toContain('[release] no powder.release.cmd label - skipped')
		// the only compose run lives inside the label-gated branch
		expect(script.match(/compose -f '[^']+'(?: \$\(\[ -f '[^']+' \] && printf '%s %s' -f '[^']+'\))? \$DFR_F \$LB_F run /g)?.length).toBe(1)
		expect(script.indexOf('if [ -z "$REL_CMD" ]; then echo "[release] no powder.release.cmd')).toBeLessThan(script.indexOf(' run --rm --no-deps'))
	})
	it('runs after the swap gate, bridge start and db migrate, before compose up', () => {
		for (const s of [script, staged]) {
			const rel = s.indexOf('step "release"')
			expect(rel).toBeGreaterThan(s.indexOf('{ bridge_start || true; }'))
			expect(rel).toBeGreaterThan(s.indexOf('step "db migrate"'))
			expect(rel).toBeLessThan(s.indexOf('step "docker compose up"'))
		}
		expect(staged.indexOf('step "release"')).toBeGreaterThan(staged.indexOf('step "swap gate"'))
	})
	it('runs a non-routed one-off container with the entrypoint overridden and a timeout', () => {
		expect(script).toContain('timeout "$(cap 600 120)" docker compose')
		expect(script).toContain('run --rm --no-deps -T --label traefik.enable=false --label \'powder.release=/opt/apps/demo|app\'')
		expect(script).toContain('--name "$REL_CN-powder-release" --entrypoint sh')
	})
	it('fails the deploy before compose up when the command fails', () => {
		expect(script).toContain('[release] FAILED (rc=$REL_RC) - not swapping; old container keeps serving"; exit 1; }')
		expect(script).toContain('[release] cannot inspect service image')
		expect(script).toContain('[release] not enough deploy budget left - not starting')
		expect(staged.indexOf('REL_PREV=$(')).toBeLessThan(staged.indexOf('step "swap gate"'))
		expect(script).toContain('docker image tag "$REL_PREV"')
	})
	it('cleans stale release containers by label, including in the EXIT trap', () => {
		expect(script).toContain("docker ps -aq --filter 'label=powder.release=/opt/apps/demo|app'")
		expect(script).toMatch(/trap 'rc=\$\?; bridge_stop; release_stop; /)
		bashSyntaxOk(script)
		bashSyntaxOk(staged)
	})
	it('behaves end to end with a stubbed docker', () => {
		const cfgDefault = 'services:\\n  db:\\n    image: postgres:16\\n  app:\\n    image: demo:latest\\n    container_name: demo\\n'
		const run = (o: { label?: string; runRc?: number; left?: number; cfg?: string; inspectFail?: boolean }) => {
			const dir = mkdtempSync(join(tmpdir(), 'release-'))
			const labelFor = (img: string) => (img === 'demo:latest' || img === 'proj-app' ? (o.label ?? '') : 'POSTGRES-LABEL')
			writeFakeDocker(dir, `#!/bin/bash\ncase "$*" in\n *" run "*) echo "RUN $*" >> ${dir}/log; exit ${o.runRc ?? 0};;\n *"image tag"*) echo "TAG $*" >> ${dir}/log;;\n *"image inspect"*) ${o.inspectFail ? 'exit 1' : `case "$*" in *demo:latest) echo '${labelFor('demo:latest')}';; *proj-app) echo '${labelFor('proj-app')}';; *) echo '${labelFor('postgres')}';; esac`};;\n *"config --no-interpolate --format json"*) echo '{}';;\n *" config"*) printf '${o.cfg ?? cfgDefault}';;\nesac\n`)
			const m = script.slice(script.indexOf('step "release"'), script.indexOf('step "docker compose up"'))
			const fn = script.slice(script.indexOf('release_restore() {'), script.indexOf('STAGE_IMG='))
			const body = `PATH=${dir}:$PATH; step() { echo "-- $1"; }; el_guard() { :; }; cap() { echo 5; }; left() { echo ${o.left ?? 1000}; }; timeout() { shift; "$@"; }; CP_PROJ=proj; REL_PREV=sha256:old; IMGREF=demo:latest; ${fn} ${m} echo reached-up`
			const f = join(dir, 't.sh')
			writeFileSync(f, body)
			let out = ''
			let rc = 0
			try {
				out = execFileSync('bash', ['-ec', `. ${f}`], { encoding: 'utf8' })
			} catch (e) {
				const err = e as { stdout?: string; status?: number }
				out = err.stdout ?? ''
				rc = err.status ?? 1
			}
			let log = ''
			try {
				log = readFileSync(join(dir, 'log'), 'utf8')
			} catch {}
			return { out, rc, log }
		}
		// depends_on image listed first: the service's own image is still chosen
		const absent = run({ label: '' })
		expect(absent.out).toContain('no powder.release.cmd label - skipped')
		expect(absent.out).toContain('reached-up')
		expect(absent.log).not.toContain('RUN')
		const ok = run({ label: 'echo hi' })
		expect(ok.out).toContain('[release] ok')
		expect(ok.out).toContain('from demo:latest')
		expect(ok.out).not.toContain('echo hi')
		expect(ok.out).toContain('reached-up')
		expect(ok.log).toContain('--name demo-powder-release --entrypoint sh app -c echo hi')
		expect(ok.log).not.toContain('TAG')
		const bad = run({ label: 'echo hi', runRc: 3 })
		expect(bad.rc).toBe(1)
		expect(bad.out).toContain('[release] FAILED (rc=3) - not swapping')
		expect(bad.out).not.toContain('reached-up')
		expect(bad.log).toContain('TAG image tag sha256:old demo:latest')
		const broke = run({ label: 'echo hi', left: 100 })
		expect(broke.rc).toBe(1)
		expect(broke.out).toContain('not enough deploy budget left')
		expect(broke.log).toContain('TAG image tag sha256:old demo:latest')
		expect(broke.log).not.toContain('RUN')
		// build-only service (no image: key) falls back to <project>-<service>
		const buildOnly = run({ label: 'echo hi', cfg: 'services:\\n  app:\\n    build: ./src\\n' })
		expect(buildOnly.out).toContain('from proj-app')
		// explicit image that cannot be inspected aborts; an implicit one just skips
		expect(run({ inspectFail: true }).out).toContain('cannot inspect service image demo:latest')
		const implicit = run({ inspectFail: true, cfg: 'services:\\n  app:\\n    build: ./src\\n' })
		expect(implicit.rc).toBe(0)
		expect(implicit.out).toContain('skipped')
	})
})

describe('zero-downtime bridge', () => {
	const script = buildDeployScript(baseScript)
	it('starts a bridge before the recreate and hands off after it', () => {
		const start = script.indexOf('{ bridge_start || true; }')
		expect(start).toBeLessThan(script.indexOf('step "db migrate"'))
		const recreate = script.indexOf('up -d --force-recreate ${TARGETS:+--no-deps} $TARGETS')
		const handoff = script.indexOf('{ bridge_handoff || true; }')
		const normalize = script.indexOf('step "normalize')
		expect(start).toBeGreaterThan(-1)
		expect(start).toBeLessThan(recreate)
		expect(handoff).toBeGreaterThan(recreate)
		expect(handoff).toBeLessThan(normalize)
		// force-recreate itself is unchanged
		expect(script).toMatch(/\(docker compose -f '[^']+'(?: \$\(\[ -f '[^']+' \] && printf '%s %s' -f '[^']+'\))? \$DFR_F \$LB_F up -d --force-recreate \$\{TARGETS:\+--no-deps\} \$TARGETS 2>&1 \|\|/)
	})
	it('removes the bridge on every exit path via the EXIT trap and never fails the deploy', () => {
		expect(script).toMatch(/trap 'rc=\$\?; bridge_stop; /)
		expect(script.indexOf('bridge_stop; release_stop; if [ "$rc" -ne 0 ] && [ "$SWAPPED" != 1 ]; then release_restore; fi; if [ -n "$STAGE_IMG" ]')).toBeGreaterThan(-1)
		expect(script.indexOf('{ bridge_start || true; }')).toBeLessThan(script.indexOf('step "db migrate"'))
		expect(script).toMatch(/bridge_stop\(\) \{ if \[ -n "\$BRIDGE" \]; then if \[ "\$\(docker inspect -f '\{\{index \.Config\.Labels "powder\.bridge"\}\}' "\$BRIDGE" 2>\/dev\/null\)" = '\/opt\/apps\/demo\|app' \]; then docker rm -f "\$BRIDGE"/)
		expect(script).toMatch(/\{ bridge_start \|\| true; \}/)
		expect(script).toMatch(/\{ bridge_handoff \|\| true; \}/)
		// stale bridges are removed at start
		expect(script).toMatch(/docker ps -aq --filter 'label=powder\.bridge=\/opt\/apps\/demo\|app'/)
	})
	it('clones config without compose labels, ports, and with the server mem cap', () => {
		const f = bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')
		expect(f).toContain("grep -v '^com\\.docker\\.compose\\.'")
		expect(f).toContain('--memory "$__cap" --memory-swap "$__cap"')
		expect(f).toContain('/opt/apps/.mem-cap')
		expect(f).toContain('-powder-bridge')
		expect(f).toContain('--restart=no')
		// the only publish is the opt-in host-port mode, loopback only
		expect(f).not.toContain('--publish')
		expect(f.match(/ -p /g)).toHaveLength(1)
		expect(f).toContain('if [ -n "$B_HP" ]; then set -- "$@" -p "127.0.0.1:$B_HP:$B_PORT"; fi;')
	})
	it('gates on health, time-based waits, safe binds, drain', () => {
		const f = bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')
		expect(f).toContain('.State.Health.Status')
		expect(f).toContain('--health-start-interval 1s')
		expect(f).toContain('__end=$(( $(date +%s) + $(cap "$1" 600) ))')
		expect(f).toContain('[234][0-9][0-9]')
		expect(f).toContain('--max-time 5')
		expect(f).toContain('while IFS= read -r __b')
		expect(f).toContain('docker stop -t 10 "$BRIDGE"')
		expect(f).toContain('rm -f "$B_EF"')
		expect(f).not.toContain('docker rm -f "$__name"')
		for (const why of ['extra_hosts/tmpfs', 'multi-line env value', 'router without an explicit rule']) expect(f).toContain(why)
	})
	it('is opt-in, has its own readiness gate, drains, and checks label drift', () => {
		const f = bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')
		expect(f).toContain('powder.bridge.enabled')
		expect(f).toContain("--health-cmd 'test -f /tmp/.powder-ready'")
		expect(f).toContain('--health-start-period 60s')
		expect(f).toContain('touch /tmp/.powder-ready')
		expect(f).toContain('rm -f /tmp/.powder-ready')
		expect(f).toContain('traefik labels differ')
		expect(f).toContain('ExposedPorts')
		expect(script).toMatch(/cleaning stale state and retrying up" && el_guard && bridge_stop &&/)
	})
	it('skips when the app has not opted in', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
		writeFakeDocker(dir, '#!/bin/bash\ncase "$*" in\n *"ps -q"*) echo oldid;; *State.Running*) echo true;;\nesac\n')
		writeFileSync(join(dir, 'curl'), '#!/bin/bash\necho 200\n', { mode: 0o755 })
		const body = `cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')} bridge_start; echo rc=$?`
		const out = execFileSync('bash', ['-c', body], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }).toString()
		expect(out).toMatch(/skipped: not enabled/)
	})
	it('guards boot-time schema pushes, requires a healthcheck, survives the retry subshell', () => {
		const f = bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')
		expect(f).toContain('powder.bridge.boot-push-ok')
		expect(f).toContain('push[ ",]+--force|db[ ",]+push|accept-data-loss')
		expect(f).toContain('boot-time schema push')
		expect(f).toContain('no healthcheck')
		expect(f).toContain('already removed (stale-state retry)')
		expect(f).toContain('no new container found after recreate')
		expect(f).toContain("docker ps -aq --filter 'label=powder.bridge=/opt/apps/demo|app'")
	})
	it('skips a boot-push app unless boot-push-ok is set', () => {
		const run = (okLabel: string) => {
			const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
			writeFakeDocker(dir, `#!/bin/bash\ncase "$*" in\n *"ps -q"*) echo oldid;;\n *powder.bridge.enabled*) echo true;;\n *boot-push-ok*) echo ${okLabel};;\n *State.Running*) echo true;;\n *PortBindings*) echo 0;;\n *NetworkMode*) echo web;;\n *"len .Mounts"*|*"len .HostConfig.Binds"*) echo 0;;\n *ExtraHosts*) echo '0|0|0|0|<nil>|67108864';;\n *"json .Config.Env"*) echo '[]';;\n *Healthcheck*) echo y;;\n *"json .Config.Cmd"*) echo '["sh","-c","drizzle-kit push --force && node server.js"]null';;\n *"{{.Image}}"*) echo sha256:abc;;\nesac\n`)
			writeFileSync(join(dir, 'curl'), '#!/bin/bash\necho 200\n', { mode: 0o755 })
			const body = `cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')} bridge_start; echo rc=$?`
			return execFileSync('bash', ['-c', body], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }).toString()
		}
		expect(run('false')).toMatch(/skipped: boot-time schema push/)
		expect(run('true')).not.toMatch(/boot-time schema push/)
	})
	it('documents every skip condition', () => {
		const f = bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')
		for (const why of ['publishes host ports', 'no explicit traefik router+service labels', 'non-bridge network mode', 'mounts not expressible', 'command/entrypoint overridden', 'not answering HTTP / not healthy', 'not enabled', 'network connect failed', 'no running container']) {
			expect(f).toContain(why)
		}
	})
	it('skips without creating anything when the app publishes host ports', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
		const log = join(dir, 'calls.log')
		writeFakeDocker(dir, `#!/bin/bash\necho "$*" >> ${log}\ncase "$*" in\n  *"compose"*"ps -q"*) echo oldid;;\n  *powder.bridge.enabled*) echo true;;\n  *State.Running*) echo true;;\n  *PortBindings*) echo 1;;\n  *) :;;\nesac\n`)
		writeFileSync(join(dir, 'curl'), '#!/bin/bash\necho 200\n', { mode: 0o755 })
		const body = `cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')} bridge_start; bridge_handoff; echo done`
		const out = execFileSync('bash', ['-c', body], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }).toString()
		expect(out).toMatch(/\[bridge\] skipped: app publishes host ports/)
		expect(out).toMatch(/done/)
		expect(execFileSync('cat', [log]).toString()).not.toMatch(/docker create|^create /m)
	})
	it('skips when there is no running container (first deploy)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
		writeFakeDocker(dir, '#!/bin/bash\nexit 0\n')
		writeFileSync(join(dir, 'curl'), '#!/bin/bash\necho 200\n', { mode: 0o755 })
		const body = `cap() { echo "$1"; }; ${bridgeShellFunctions("-f 'c.yml'", 'app', '/opt/apps/demo')} bridge_start; echo rc=$?`
		const out = execFileSync('bash', ['-c', body], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }).toString()
		expect(out).toMatch(/skipped: no running container/)
		expect(out).toMatch(/rc=0/)
	})
})

describe('ssh host-key pinning', () => {
	const key = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 3, 1, 2, 3])])
	it('parses the key type and an OpenSSH-style fingerprint', () => {
		expect(hostKeyType(key)).toBe('ssh-ed25519')
		expect(hostKeyFingerprint(key)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
		expect(hostKeyType(Buffer.from([1]))).toBe('unknown')
	})
	it('pins on first use, accepts the same key, refuses a different one', () => {
		const seen = { keyType: 'ssh-ed25519', sha256: 'SHA256:aaa' }
		expect(decideHostKey('1.2.3.4', null, seen)).toEqual({ ok: true, firstUse: true })
		expect(decideHostKey('1.2.3.4', seen, seen)).toEqual({ ok: true, firstUse: false })
		const d = decideHostKey('1.2.3.4', seen, { keyType: 'ssh-rsa', sha256: 'SHA256:bbb' })
		expect(d.ok).toBe(false)
		if (!d.ok) expect(d.reason).toMatch(/DELETE FROM ssh_host_keys WHERE host = '1\.2\.3\.4'/)
	})
})

describe('has-infra recreate never touches dependencies (bundled db survives a deploy)', () => {
	const script = buildDeployScript(baseScript)
	it('every force-recreate with a service list carries --no-deps', () => {
		const hits = script.match(/up -d [^&|;]*\$TARGETS/g) ?? []
		expect(hits.length).toBeGreaterThanOrEqual(3)
		for (const h of hits) expect(h).toContain('${TARGETS:+--no-deps}')
	})
	it('starts missing infra without recreating running infra, before the app recreate', () => {
		const infraUp = script.indexOf('up -d --wait --wait-timeout 60 --no-recreate $INFRA_SVCS')
		expect(infraUp).toBeGreaterThan(-1)
		expect(infraUp).toBeLessThan(script.indexOf('up -d --force-recreate'))
		expect(script).toContain('grep -vxF --')
		expect(script).not.toMatch(/--force-recreate[^&|;]*\$INFRA_SVCS/)
		bashSyntaxOk(script)
	})
})
