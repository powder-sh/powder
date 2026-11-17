import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderOverride } from '../compose-override'
import { type ComposeGuardContext, composeViolations, isHighSeverity } from '../compose-safety'
import { buildDeployScript } from '../deploy/script'
import { composeUpCommand } from '../deploy/fragments'

// a service with a build section and `pull_policy: always` (daily, weekly,
// refresh, every_<d>) made compose PULL its `image:` as root with root's registry logins
// and run it. The login rule (checkSiblingImage) runs only for services without a build.
// Invented names.

const base: ComposeGuardContext = { appName: 'demoapp', otherApps: ['otherapp'], registryLoginHosts: ['ghcr.io'] }
const compose = (services: Record<string, unknown>) => ({ name: 'demoapp', services })
const findings = (c: unknown, ctx: ComposeGuardContext = base) => composeViolations(c, ctx)

describe('compose rule: a pulling pull_policy on a build service', () => {
	const svc = (pull_policy?: unknown) => ({
		demoapp: { build: { context: '/opt/apps/demoapp/src', dockerfile: 'Dockerfile' }, image: 'demoapp:latest', container_name: 'demoapp' },
		side: {
			build: { context: '/opt/apps/demoapp/src', dockerfile: 'Dockerfile' },
			image: 'ghcr.io/example-org/payroll:latest',
			container_name: 'demoapp-side',
			...(pull_policy === undefined ? {} : { pull_policy }),
		},
	})

	it('refuses always, daily, weekly, refresh and every_<d> (high severity)', () => {
		for (const pp of ['always', 'daily', 'weekly', 'refresh', 'every_12h', 'Always', ' always ']) {
			const f = findings(compose(svc(pp))).filter((v) => v.code === 'pull_policy')
			expect(f, pp).toHaveLength(1)
			const [v] = f
			expect(v?.service).toBe('side')
			expect(v && isHighSeverity(v)).toBe(true)
		}
	})

	it('passes unset, missing, if_not_present, never and build', () => {
		for (const pp of [undefined, null, '', 'missing', 'if_not_present', 'never', 'build'])
			expect(findings(compose(svc(pp))).map((v) => v.code), String(pp)).not.toContain('pull_policy')
	})

	it('is never exemptable, by code or by value', () => {
		const byCode = findings(compose(svc('always')), { ...base, exempt: ['pull_policy'] })
		expect(byCode.map((v) => v.code)).toContain('pull_policy')
		const byValue = findings(compose(svc('always')), { ...base, exemptValues: { pull_policy: ['always', '*'] } })
		expect(byValue.map((v) => v.code)).toContain('pull_policy')
	})

	it('leaves a service without a build alone (its image goes through the login rule)', () => {
		const c = compose({
			demoapp: { image: 'ghcr.io/example-org/demoapp:latest', container_name: 'demoapp', pull_policy: 'always' },
		})
		expect(findings(c).map((v) => v.code)).toEqual([])
	})
})

describe('shell: pulls skip build services, recreates never pull', () => {
	it('recreates keep compose defaults for non-build services (no global --pull never); the build pin lives in the override', () => {
		const c = composeUpCommand('/opt/apps/demoapp/docker-compose.yml', 'demoapp', '/opt/apps/demoapp', {
			app: 'demoapp',
			approval: { hash: 'c'.repeat(64), app: 'demoapp', log: '' },
		})
		expect(c).toContain('up -d --no-build --force-recreate')
		expect(c).not.toContain('--pull never')
		const ov = renderOverride({ service: 'demoapp', labels: null, ports: {}, services: ['demoapp', 'db'], buildServices: ['demoapp', 'worker'] })
		expect(ov).toContain('  "demoapp":\n    cap_drop:\n      - "NET_RAW"\n    pull_policy: never\n')
		expect(ov).toContain('  "worker":\n    pull_policy: never\n')
		expect(ov).not.toMatch(/"db":[^"]*pull_policy/)
		expect(renderOverride({ service: 'demoapp', labels: null, ports: {}, services: ['db'] })).not.toContain('pull_policy')
	})

	it('the override writer passes every service with a build section', () => {
		const src = readFileSync(join(__dirname, '..', 'compose-override-io.ts'), 'utf8')
		expect(src).toMatch(/renderOverride\(\{ service: facts\.service, labels, ports: plan\.overrides, services, buildServices \}\)/)
	})

	it('every compose pull in the deploy script passes --ignore-buildable', () => {
		for (const declaredMode of ['auto', 'registry'] as const) {
			const s = buildDeployScript({
				workingDir: '/opt/apps/demoapp',
				configFile: '/opt/apps/demoapp/docker-compose.yml',
				service: 'demoapp',
				cf: "-f '/opt/apps/demoapp/docker-compose.yml'",
				declaredMode,
				prebuilt: false,
				infra: null,
				wantBranch: null,
				wantSha: null,
				shaIsStrict: false,
			})
			const pulls = s.match(/docker compose [^;|&]*? pull\b[^;|&]*/g) ?? []
			expect(pulls.length, declaredMode).toBeGreaterThan(0)
			for (const p of pulls) expect(p, p).toContain('pull --ignore-buildable ')
		}
	})
})
