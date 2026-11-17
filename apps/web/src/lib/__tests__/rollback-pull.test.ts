import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { rollbackTargetShell } from '../deploy/health'
import { type PushDecision, deployPushDecision, refusedPush } from '../deploy-push-policy'
import { writeFakeDocker } from './fixtures/fake-docker'

// a rollback whose target image is not local pulls it as root with root's
// registry logins, so only from a repo the app owns under the rollback
// tag push rule; otherwise the rollback refuses. Invented names.

const root = mkdtempSync(join(tmpdir(), 'rb-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function run(local: boolean, pull: PushDecision) {
	const dir = mkdtempSync(join(root, 'r-'))
	const bin = join(dir, 'bin')
	mkdirSync(bin)
	writeFakeDocker(bin, `#!/bin/bash\necho "$*" >> ${JSON.stringify(join(dir, 'calls'))}\ncase "$1 $2" in "image inspect") [ -e ${JSON.stringify(join(dir, 'have'))} ] && { echo sha256:1; exit 0; }; exit 1;; "pull "*) touch ${JSON.stringify(join(dir, 'have'))}; exit 0;; esac\nexit 0\n`)
	if (local) writeFileSync(join(dir, 'have'), '')
	const r = spawnSync('bash', ['-c', `set -e; ${rollbackTargetShell('ghcr.io/example-org/demoapp:deploy-7', pull)} && echo REACHED`], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
	})
	let calls = ''
	try {
		calls = readFileSync(join(dir, 'calls'), 'utf8')
	} catch {}
	return { out: r.stdout + r.stderr, calls }
}

describe('rollback pulls a missing target only from a repo the app owns', () => {
	it('a local target is used as it is, no pull', () => {
		const r = run(true, refusedPush('x'))
		expect(r.out).toContain('REACHED')
		expect(r.calls).not.toContain('pull')
	})
	it('a missing target from an owned repo is pulled', () => {
		const r = run(false, deployPushDecision('demoapp', 'ghcr.io/example-org/demoapp:deploy-7', [], ['demoapp']))
		expect(r.out).toContain('REACHED')
		expect(r.calls).toContain('pull ghcr.io/example-org/demoapp:deploy-7')
	})
	it('a missing target from a repo the app does not own is refused, never pulled', () => {
		const r = run(false, refusedPush('the app otherapp pushed ghcr.io/example-org/demoapp more recently than demoapp'))
		expect(r.out).not.toContain('REACHED')
		expect(r.out).toContain('powder does not pull it (the app otherapp pushed ghcr.io/example-org/demoapp more recently than demoapp)')
		expect(r.calls).not.toContain('pull')
	})
	it('rollbackToImage decides with the push rule; a local image or an unregistered container never pulls', () => {
		const src = readFileSync(join(__dirname, '..', 'deploy', 'health.ts'), 'utf8')
		expect(src).toContain("m.loadDeployPushDecision(opts.app as string, historicalImage)")
		expect(src).toContain("refusedPush('a local image, never pushed')")
		expect(src).toContain("refusedPush('no registered app owns this container')")
		expect(src).toContain('${rollbackTargetShell(historicalImage, pull)} && ')
		expect(src).not.toMatch(/docker pull \$\{shq\(historicalImage\)\}/)
	})
})

describe('the override is re-rendered before the post-sync re-check', () => {
	it('applyComposeOverride runs between the changed-marker branch and the second checkComposeForDeploy', () => {
		const src = readFileSync(join(__dirname, '..', 'deploy', 'run.ts'), 'utf8')
		const branch = src.indexOf('hasMarkerLine(stdout, changedMarker) && !budgetExhausted')
		const render = src.indexOf('compose override (re-rendered after the sync)', branch)
		const again = src.indexOf('const again = await checkComposeForDeploy(', branch)
		expect(branch).toBeGreaterThan(0)
		expect(render).toBeGreaterThan(branch)
		expect(again).toBeGreaterThan(render)
	})
})
