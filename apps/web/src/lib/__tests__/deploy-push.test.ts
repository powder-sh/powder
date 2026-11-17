import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type PushHistoryRow, deployPushDecision, pushRepoOf, refusedPush } from '../deploy-push-policy'
import { tagDeployCommand } from '../deploy/run'

// the rollback-tag push goes only to a repo the app owns. Shapes with
// invented names: apps whose ghcr repo differs from the app name (history keeps them
// pushing), a repo two apps pushed (the most recent pusher owns it), a new app.

const d = (s: string) => new Date(`${s}T12:00:00Z`)
const H: PushHistoryRow[] = [
	{ app: 'alpha', repo: 'ghcr.io/exampleorg/alpha-webapp', last: d('2026-11-02') },
	{ app: 'beta-app', repo: 'ghcr.io/example-io/beta-xx', last: d('2026-10-30') },
	{ app: 'oldname', repo: 'ghcr.io/example-dev/dev-shared', last: d('2026-07-27') },
	{ app: 'newname', repo: 'ghcr.io/example-dev/dev-shared', last: d('2026-11-01') },
	{ app: 'payroll', repo: 'ghcr.io/victimorg/payroll', last: d('2026-10-01') },
	{ app: 'gone-app', repo: 'ghcr.io/exampleorg/fresh', last: d('2026-09-01') },
]
const REG = ['alpha', 'beta-app', 'oldname', 'newname', 'payroll', 'fresh', 'attacker', 'brandnew']

describe('deployPushDecision', () => {
	it('(a) an app keeps pushing the repo it pushed before, whatever the name', () => {
		expect(deployPushDecision('alpha', 'ghcr.io/exampleorg/alpha-webapp:latest', H, REG).allow).toBe(true)
		expect(deployPushDecision('beta-app', 'ghcr.io/Example-IO/beta-xx:main', H, REG).allow).toBe(true)
		expect(deployPushDecision('payroll', `ghcr.io/victimorg/payroll@sha256:${'a'.repeat(64)}`, H, REG).allow).toBe(true)
	})
	it('a repo two apps pushed belongs to the most recent pusher', () => {
		expect(deployPushDecision('newname', 'ghcr.io/example-dev/dev-shared:latest', H, REG).allow).toBe(true)
		const old = deployPushDecision('oldname', 'ghcr.io/example-dev/dev-shared:latest', H, REG)
		expect(old.allow).toBe(false)
		expect(old.reason).toContain('newname pushed ghcr.io/example-dev/dev-shared more recently')
	})
	it("another app's repo, another org's package: refused", () => {
		for (const img of ['ghcr.io/victimorg/payroll:latest', 'ghcr.io/victimorg/otherpkg:1', 'docker.io/victimuser/attacker-not:1']) {
			expect(deployPushDecision('attacker', img, H, REG).allow, img).toBe(false)
		}
		// an app with history cannot switch to a new repo, even one named after itself
		expect(deployPushDecision('alpha', 'ghcr.io/victimorg/alpha:1', H, REG).allow).toBe(false)
	})
	it('(b) a new app pushes only a repo named after it that no other app pushed', () => {
		expect(deployPushDecision('brandnew', 'ghcr.io/anyorg/brandnew:latest', H, REG).allow).toBe(true)
		expect(deployPushDecision('brandnew', 'ghcr.io/anyorg/brandnew-web:latest', H, REG).allow).toBe(false)
		// a new app named like a repo a registered app pushed: refused
		expect(deployPushDecision('payroll2', 'ghcr.io/victimorg/payroll:1', H, [...REG, 'payroll2']).allow).toBe(false)
		const attackerNamed = deployPushDecision('payroll', 'ghcr.io/victimorg/payroll:1', H.filter((h) => h.app !== 'payroll'), REG)
		expect(attackerNamed.allow).toBe(true)
		// a repo only an unregistered (deleted) app pushed does not block a new app named after it
		expect(deployPushDecision('fresh', 'ghcr.io/exampleorg/fresh:1', H, REG).allow).toBe(true)
		// ... but a registered one does
		expect(deployPushDecision('fresh', 'ghcr.io/exampleorg/fresh:1', H, [...REG, 'gone-app']).allow).toBe(false)
	})
	it('a local image is never pushed; the repo is normalised', () => {
		expect(deployPushDecision('brandnew', 'brandnew:latest', [], REG).allow).toBe(false)
		expect(pushRepoOf('GHCR.io/Org/App:deploy-abc')).toBe('ghcr.io/org/app')
		expect(pushRepoOf('localhost:5000/app')).toBe('localhost:5000/app')
		expect(pushRepoOf('docker.io/library/node:22')).toBe('node')
		expect(pushRepoOf('index.docker.io/user/app@sha256:abc')).toBe('user/app')
	})
})

describe('the tag command', () => {
	it('pushes only when allowed; a refused push is a WARN and still tags', () => {
		const ok = deployPushDecision('app', 'ghcr.io/exampleorg/app:latest', [], ['app'])
		expect(ok.allow).toBe(true)
		const yes = tagDeployCommand('ghcr.io/exampleorg/app:latest', 'dep_x1', ok)
		expect(yes).toContain("docker push 'ghcr.io/exampleorg/app:deploy-x1'")
		const no = tagDeployCommand('ghcr.io/victimorg/payroll:latest', 'dep_x1', refusedPush("it's \nnot yours"))
		expect(no).not.toContain('docker push')
		expect(no).toContain("docker tag 'ghcr.io/victimorg/payroll:latest' 'ghcr.io/victimorg/payroll:deploy-x1'")
		expect(no).toContain('WARN not pushing ghcr.io/victimorg/payroll:deploy-x1')
		expect(no).not.toContain('\n')
		expect(tagDeployCommand('app:latest', 'dep_x1', ok)).not.toContain('docker push')
	})
	it('the deploy runner passes the decision from the DB lookup, read before the 0058 cutoff', () => {
		const src = readFileSync(join(__dirname, '..', 'deploy-runner.ts'), 'utf8')
		expect(src).toContain('tagDeployImage(srv, image, deploy.id, await loadDeployPushDecision(containerName, image))')
		const db = readFileSync(join(__dirname, '..', 'deploy-push.ts'), 'utf8')
		expect(db).toMatch(/started_at < \$\{cutoff\.toISOString\(\)\}::timestamptz/)
		expect(db).toContain("status = 'success'")
		const mig = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle', '0058_deploy_push_cutoff.sql'), 'utf8')
		expect(mig).toMatch(/^-- idempotent/)
		expect(mig).toContain("'deploy_push_cutoff'")
		expect(mig).toContain('ON CONFLICT ("key") DO NOTHING')
	})
})
