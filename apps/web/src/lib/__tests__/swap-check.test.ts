import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDeployFailure } from '../deploy-failure'
import { buildDeployScript, composeFileArgs, resolveSwapCheckPlan, swapCheckShellFunctions } from '../ssh'
import type { SwapCheckPlan } from '../ssh'

const WD = '/opt/apps/demo'
const CF = composeFileArgs(`${WD}/docker-compose.yml`)

const script = (swapCheck?: SwapCheckPlan) =>
	buildDeployScript({
		workingDir: WD,
		configFile: `${WD}/docker-compose.yml`,
		service: 'app',
		cf: CF,
		declaredMode: 'auto',
		prebuilt: false,
		migrateApp: 'demo',
		infra: [],
		wantBranch: null,
		wantSha: null,
		shaIsStrict: false,
		swapOrdinal: 1700000000000,
		stageId: 'dep_x',
		swapCheck,
	})

const active = { path: '/api/health', strict: true, host: 'demo.example.com' }
const bashN = (s: string) => spawnSync('bash', ['-n'], { input: s, encoding: 'utf8' })

describe('swap-check in buildDeployScript', () => {
	it('normal app: candidate runs after release and before the recreate, cleans up after', () => {
		const s = script(active)
		expect(bashN(s).status).toBe(0)
		const iRelease = s.indexOf('step "release"')
		const iCheck = s.indexOf('step "swap-check" && swap_check')
		const iUp = s.indexOf('step "docker compose up"')
		const iRecreate = s.indexOf('up -d --force-recreate $TARGETS')
		expect(iRelease).toBeGreaterThan(0)
		expect(iCheck).toBeGreaterThan(iRelease)
		expect(iUp).toBeGreaterThan(iCheck)
		expect(s.indexOf('{ swap_stop || true; }')).toBeGreaterThan(iRecreate)
		// candidate shape: own name, same env file, no traefik labels, no published ports
		expect(s).toContain("SC_NAME='demo-next'")
		expect(s).toContain('--label powder.candidate=1')
		expect(s).toContain('--label traefik.enable=false')
		expect(s).toMatch(/docker compose [^;]*run -d --no-deps --name "\$SC_NAME"/)
		expect(s).not.toContain('--service-ports')
		expect(swapCheckShellFunctions(CF, 'app', WD, 'demo', active)).not.toMatch(/--env-file|docker create/)
		expect(s).toContain("-H 'Host: demo.example.com'")
		expect(s).toContain("'/api/health'")
		expect(s).toContain('2[0-9][0-9])')
		// stale -next removed at the start, and from the EXIT trap
		expect(s.indexOf('{ SC_ON=1; swap_stop; }')).toBeLessThan(s.indexOf('step "preflight"'))
		expect(s).toMatch(/trap 'rc=\$\?; bridge_stop; swap_stop;/)
		for (const line of ['swap-check: candidate started', 'swap-check: healthy in', 'swap-check: FAILED (']) expect(s).toContain(line)
	})

	it('no health_url: loose 1xx-4xx acceptance on /', () => {
		const s = script({ path: '/', strict: false })
		expect(s).toContain('[1-4][0-9][0-9])')
		expect(s).not.toContain('-H \'Host:')
	})

	it('app with published ports: the candidate never publishes ports (probed by container IP)', () => {
		const fns = swapCheckShellFunctions(CF, 'app', WD, 'demo', active)
		expect(fns).toContain('{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}\' "$SC_NAME"')
		expect(fns).not.toMatch(/--publish|--service-ports|-p [0-9]/)
		expect(fns).not.toContain('-P ')
	})

	it('host-network app: the shell skips with one logged line', () => {
		expect(script(active)).toContain('echo "swap-check: skipped (host-network app)"')
	})

	it('swap_check=false: one skip line, no candidate machinery', () => {
		const plan = resolveSwapCheckPlan({ appFlag: false, env: {}, probe: null })
		expect(plan).toEqual({ skip: 'disabled for this app (swap_check=false)' })
		const s = script(plan)
		expect(bashN(s).status).toBe(0)
		expect(s).toContain('echo "swap-check: skipped (disabled for this app swap_check=false)"')
		expect(s).not.toContain('swap_check()')
		expect(s).not.toContain('swap_stop')
		expect(s).not.toContain('powder.candidate')
	})

	it('POWDER_SWAP_CHECK=off: skipped globally, even for apps that opted in', () => {
		const plan = resolveSwapCheckPlan({ appFlag: true, env: { POWDER_SWAP_CHECK: 'off' }, probe: null })
		expect('skip' in plan).toBe(true)
		const s = script(plan)
		expect(s).toContain('swap-check: skipped (disabled by POWDER_SWAP_CHECK=off)')
		expect(s).not.toContain('powder.candidate')
	})

	it('unset swapCheck leaves the script untouched (no swap-check text at all)', () => {
		expect(script(undefined)).not.toMatch(/swap-check|swap_stop|swap_check|powder\.candidate/)
	})

	it('resolveSwapCheckPlan defaults on and carries the probe', () => {
		expect(resolveSwapCheckPlan({ appFlag: true, env: {}, probe: { path: '/h', host: 'a.b' } })).toEqual({
			path: '/h',
			strict: true,
			host: 'a.b',
			auth: true,
		})
		expect(resolveSwapCheckPlan({ appFlag: undefined, env: { POWDER_SWAP_CHECK: 'on' }, probe: null })).toMatchObject({ path: '/', strict: false })
	})
})

// Runs swap_check under bash with stub docker/curl/sleep. The stub's `compose run`
// records its args; the candidate's `.Config.Env` is what compose would resolve
// (CAND_ENV: the env file said HOSTNAME=127.0.0.1, compose `environment:` wins).
function runFns(o: { netmode?: string; code?: string; running?: string; candEnv?: string; pb?: string; label?: string; expose?: string; plan?: { path: string; strict: boolean; host?: string; auth?: boolean }; runFail?: boolean; acode?: string; body?: string; pkg?: string; lock?: string }) {
	const d = mkdtempSync(join(tmpdir(), 'powder-swap-'))
	const bin = join(d, 'bin')
	mkdirSync(bin)
	const calls = join(d, 'calls')
	writeFileSync(calls, '')
	const stubs: Record<string, string> = {
		docker: `#!/bin/bash
echo "$*" >> "$CALLS"
case "$*" in
  *"ps -q"*) echo oldid;;
  *"compose"*" run "*) [ -n "$RUNFAIL" ] && exit 1; touch "$D/created";;
  "inspect -f {{.HostConfig.NetworkMode}} oldid") echo "\${NM:-default}";;
  *"range .Config.Env"*) printf '%b' "$CAND_ENV";;
  *"HostConfig.PortBindings"*) echo "$PB";;
  *'powder.candidate.app'*) [ -f "$D/created" ] && echo "$D/app|app";;
  *"Config.Labels"*) [ -n "$LABELPORT" ] && echo "traefik.http.services.s.loadbalancer.server.port=$LABELPORT";;
  *"Config.ExposedPorts"*) echo "$EXPOSE";;
  *"NetworkSettings.Networks"*) echo 10.0.0.9;;
  *"State.Running"*) echo "\${RUNNING:-true}";;
  *"State.ExitCode"*) echo 1;;
  *"HostConfig.Memory"*) echo 0;;
  "inspect "*) [ -f "$D/created" ] && exit 0 || exit 1;;
  logs*) echo "boot error line";;
  rm*) rm -f "$D/created";;
esac
exit 0
`,
		curl: `#!/bin/bash
echo "curl $*" >> "$CALLS"
OUT=""; PREV=""; for a in "$@"; do [ "$PREV" = "-o" ] && OUT="$a"; PREV="$a"; done
case "$*" in
  */api/auth/*|*AUTHPATH*) printf '%s' "\${BODY:-}" > "$OUT"; printf '%s' "\${ACODE:-200}";;
  *) printf '%s' "\${CODE:-200}";;
esac
`,
		sleep: '#!/bin/bash\nexit 0\n',
	}
	for (const [n, b] of Object.entries(stubs)) {
		writeFileSync(join(bin, n), b)
		chmodSync(join(bin, n), 0o755)
	}
	const wd = join(d, 'app')
	mkdirSync(join(wd, 'src'), { recursive: true })
	if (o.pkg !== undefined) writeFileSync(join(wd, 'src', 'package.json'), o.pkg)
	if (o.lock !== undefined) writeFileSync(join(wd, 'src', 'pnpm-lock.yaml'), o.lock)
	const fns = swapCheckShellFunctions(CF, 'app', wd, 'demo', o.plan ?? active)
	const r = spawnSync('bash', ['-c', `${fns} swap_check; echo "RC=$?"; swap_stop`], {
		env: {
			...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, D: d, NM: o.netmode ?? '', CODE: o.code ?? '', RUNNING: o.running ?? '',
			CAND_ENV: o.candEnv ?? 'HOSTNAME=0.0.0.0\nPORT=3000\n', PB: o.pb ?? '', LABELPORT: o.label ?? '', EXPOSE: o.expose ?? '', RUNFAIL: o.runFail ? '1' : '', ACODE: o.acode ?? '', BODY: o.body ?? '',
		},
		encoding: 'utf8',
	})
	return { out: r.stdout + r.stderr, rc: r.status, calls: readFileSync(calls, 'utf8') }
}
const probed = (r: { calls: string }) => r.calls.split('\n').find((l) => l.startsWith('curl')) ?? ''

describe('swap_check under bash with stub docker/curl', () => {
	it('healthy candidate: started via compose run (no ports, not routed), probed by IP with Host', () => {
		const r = runFns({})
		expect(r.out).toContain('swap-check: candidate started')
		expect(r.out).toMatch(/swap-check: healthy in \d+s \(HTTP 200\)/)
		expect(r.out).toContain('RC=0')
		const run = r.calls.split('\n').find((l) => l.includes(' run ')) ?? ''
		expect(run).toContain('--no-deps')
		expect(run).toContain('--name demo-next')
		expect(run).toContain('--label traefik.enable=false')
		expect(run).toContain('--label powder.candidate=1')
		expect(run).not.toContain('--service-ports')
		expect(run).not.toContain('--env-file')
		expect(probed(r)).toContain('http://10.0.0.9:3000/api/health')
		expect(probed(r)).toContain('Host: demo.example.com')
	})

	it('uses the compose-resolved env, not the env file: HOSTNAME=127.0.0.1 in the file, 0.0.0.0 + PORT from compose environment:', () => {
		// The script never reads the env file; the candidate's effective env (what
		// compose resolved, compose `environment:` over `env_file`) drives the port.
		const r = runFns({ candEnv: 'HOSTNAME=0.0.0.0\nPORT=3016\n' })
		expect(r.calls).toContain('range .Config.Env')
		expect(probed(r)).toContain(':3016/')
		expect(r.calls).not.toContain('127.0.0.1')
	})

	it('port order: candidate PORT beats EXPOSE (myapp: PORT 3016, EXPOSE 3000)', () => {
		expect(probed(runFns({ candEnv: 'PORT=3016\n', expose: '3000/tcp' }))).toContain(':3016/')
	})
	it('port order: social-api (PORT 3910, EXPOSE 3901) probes 3910', () => {
		expect(probed(runFns({ candEnv: 'PORT=3910\n', expose: '3901/tcp' }))).toContain(':3910/')
	})
	it('port order: no PORT -> live container PortBindings -> traefik label -> EXPOSE -> 3000', () => {
		expect(probed(runFns({ candEnv: 'A=b\n', pb: '4100/tcp', label: '4200', expose: '4300/tcp' }))).toContain(':4100/')
		expect(probed(runFns({ candEnv: 'A=b\n', label: '4200', expose: '4300/tcp' }))).toContain(':4200/')
		expect(probed(runFns({ candEnv: 'A=b\n', expose: '4300/tcp' }))).toContain(':4300/')
		expect(probed(runFns({ candEnv: 'A=b\n' }))).toContain(':3000/')
	})

	it('unhealthy candidate (strict, 500): FAILED, logs dumped, -next removed, exit 1', () => {
		const r = runFns({ code: '500' })
		expect(r.out).toContain('swap-check: FAILED (no 2[0-9][0-9] response after 12 attempts)')
		expect(r.out).toContain('boot error line')
		expect(r.out).toContain('swap-check: removed demo-next')
		expect(r.out).not.toContain('RC=')
		expect(r.rc).toBe(1)
		expect(r.calls).toContain('logs --tail 200 demo-next')
		expect(r.calls).toContain('rm -f demo-next')
	})

	it('candidate that exited: fails fast with the exit code', () => {
		const r = runFns({ running: 'false' })
		expect(r.out).toContain('swap-check: FAILED (candidate exited (code 1))')
		expect(r.rc).toBe(1)
	})

	it('loose mode, never any HTTP answer, candidate running: skipped, deploy continues', () => {
		const r = runFns({ plan: { path: '/', strict: false }, code: '000' })
		expect(r.out).toContain('swap-check: skipped (candidate never answered HTTP)')
		expect(r.out).toContain('RC=0')
		expect(r.out).not.toContain('FAILED')
	})
	it('loose mode, real 5xx: FAILED', () => {
		const r = runFns({ plan: { path: '/', strict: false }, code: '503' })
		expect(r.out).toContain('swap-check: FAILED')
		expect(r.rc).toBe(1)
	})
	it('loose mode, candidate crashed: FAILED, not skipped', () => {
		const r = runFns({ plan: { path: '/', strict: false }, code: '000', running: 'false' })
		expect(r.out).toContain('swap-check: FAILED (candidate exited')
		expect(r.rc).toBe(1)
	})
	it('strict mode, no connection ever: FAILED (a declared health_url is a promise)', () => {
		const r = runFns({ code: '000' })
		expect(r.out).toContain('swap-check: FAILED')
		expect(r.rc).toBe(1)
	})

	it('host-network app: skipped with one line, nothing started', () => {
		const r = runFns({ netmode: 'host' })
		expect(r.out).toContain('swap-check: skipped (host-network app)')
		expect(r.out).toContain('RC=0')
		expect(r.calls).not.toContain(' run ')
	})

	it('compose run failing: skipped, deploy continues', () => {
		const r = runFns({ runFail: true })
		expect(r.out).toContain('swap-check: skipped (docker compose run failed)')
		expect(r.out).toContain('RC=0')
	})
})

const BA = '{"dependencies":{"better-auth":"1.7.0"}}'
const authCurl = (r: { calls: string }) => r.calls.split('\n').filter((l) => l.includes('/api/auth/'))

describe('swap-check better-auth probe', () => {
	it('better-auth app, get-session 500 with SCHEMA_MISMATCH: fails with a clear reason and the body line', () => {
		const r = runFns({ pkg: BA, acode: '500', body: '{"code":"SCHEMA_MISMATCH","message":"x"}\nsecond line' })
		expect(r.rc).toBe(1)
		expect(r.out).toContain('swap-check: healthy in')
		expect(r.out).toContain('swap-check: FAILED (auth check: /api/auth/get-session returned 500 (better-auth schema mismatch? run the migration): {"code":"SCHEMA_MISMATCH","message":"x"})')
		expect(r.out).not.toContain('second line')
		expect(r.out).toContain('swap-check: old container untouched, not swapping')
		expect(authCurl(r)).toHaveLength(2)
		expect(authCurl(r)[0]).toContain('http://10.0.0.9:3000/api/auth/get-session')
		expect(authCurl(r)[0]).toContain('Host: demo.example.com')
	})
	it('5xx without a schema body: no body suffix', () => {
		const r = runFns({ pkg: BA, acode: '502', body: 'Bad gateway' })
		expect(r.rc).toBe(1)
		expect(r.out).toContain('returned 502 (better-auth schema mismatch? run the migration))')
		expect(r.out).not.toContain('Bad gateway')
	})
	it.each(['200', '307', '401', '404'])('get-session %s passes', (acode) => {
		const r = runFns({ pkg: BA, acode })
		expect(r.rc).toBe(0)
		expect(r.out).toContain(`swap-check: auth check ok (/api/auth/get-session HTTP ${acode})`)
	})
	it('detects better-auth from the lockfile too', () => {
		expect(runFns({ pkg: '{}', lock: 'better-auth@1.7.0', acode: '500' }).rc).toBe(1)
	})
	it('app without better-auth: no auth request at all, even if the path would 500', () => {
		const r = runFns({ pkg: '{"dependencies":{"next":"16"}}', acode: '500' })
		expect(r.rc).toBe(0)
		expect(authCurl(r)).toHaveLength(0)
	})
	it('off for every app (plan.auth=false): no probe and no function', () => {
		const r = runFns({ pkg: BA, acode: '500', plan: { ...active, auth: false } })
		expect(r.rc).toBe(0)
		expect(authCurl(r)).toHaveLength(0)
		expect(swapCheckShellFunctions(CF, 'app', WD, 'demo', { ...active, auth: false })).not.toContain('swap_auth_check')
	})
	it('per-app POWDER_AUTH_CHECK=off opts out', () => {
		const r = runFns({ pkg: BA, acode: '500', candEnv: 'PORT=3000\nPOWDER_AUTH_CHECK=off\n' })
		expect(r.rc).toBe(0)
		expect(r.out).toContain('auth check skipped')
		expect(authCurl(r)).toHaveLength(0)
	})
	it('per-app POWDER_AUTH_CHECK=/path overrides the path and forces the probe without detection', () => {
		const r = runFns({ acode: '500', candEnv: 'PORT=3000\nPOWDER_AUTH_CHECK=/api/auth/ok\n' })
		expect(r.rc).toBe(1)
		expect(authCurl(r)[0]).toContain('/api/auth/ok')
		expect(r.out).toContain('auth check: /api/auth/ok returned 500')
	})
	it('a path with shell metacharacters is ignored (default path, detection applies)', () => {
		const r = runFns({ pkg: BA, acode: '200', candEnv: 'PORT=3000\nPOWDER_AUTH_CHECK=/a;b\n' })
		expect(authCurl(r)[0]).toContain('/api/auth/get-session')
	})
	it('no HTTP answer on the auth path (000) is not a failure', () => {
		expect(runFns({ pkg: BA, acode: '000' }).rc).toBe(0)
	})
	it('resolveSwapCheckPlan: POWDER_SWAP_CHECK_AUTH=off turns the probe off', () => {
		expect(resolveSwapCheckPlan({ appFlag: true, env: { POWDER_SWAP_CHECK_AUTH: 'off' }, probe: null })).toMatchObject({ auth: false })
		expect(resolveSwapCheckPlan({ appFlag: true, env: {}, probe: null })).toMatchObject({ auth: true })
	})
	it('generated deploy script stays valid bash with the auth probe', () => {
		expect(bashN(script(active)).status).toBe(0)
		expect(script(active)).toContain('swap_auth_check')
	})
})

describe('auth check failure parsing', () => {
	const log = (line: string) => `── swap-check ──\nswap-check: healthy in 3s (HTTP 200)\n${line}\nswap-check: old container untouched, not swapping\n__POWDER_FAIL__ step=swap-check code=1\n`
	it('names the auth check, status and the SCHEMA_MISMATCH body', () => {
		const f = parseDeployFailure(log('swap-check: FAILED (auth check: /api/auth/get-session returned 500 (better-auth schema mismatch? run the migration): {"code":"SCHEMA_MISMATCH"})'))
		expect(f.failedStep).toBe('swap-check')
		expect(f.errorSummary).toBe('auth check: /api/auth/get-session returned 500 (better-auth schema mismatch? run the migration): {"code":"SCHEMA_MISMATCH"}')
	})
	it('without a body', () => {
		const f = parseDeployFailure(log('swap-check: FAILED (auth check: /api/auth/get-session returned 500 (better-auth schema mismatch? run the migration))'))
		expect(f.errorSummary).toBe('auth check: /api/auth/get-session returned 500 (better-auth schema mismatch? run the migration)')
	})
})

describe('leftover candidate watchdog', () => {
	it('flags only -next candidates older than 30 minutes', async () => {
		const { parseLeftoverCandidates } = await import('../deploy-watchdog')
		expect(parseLeftoverCandidates('demo-next|120\nold-next|1801\nbad line\nx-next|1800\n')).toEqual(['old-next'])
		expect(parseLeftoverCandidates('')).toEqual([])
	})
})
