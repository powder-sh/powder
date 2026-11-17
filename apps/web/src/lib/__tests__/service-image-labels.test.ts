import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { serviceImageLabelGuardShell } from '../deploy/fragments'
import { buildDeployScript } from '../deploy/script'
import { writeFakeDocker } from './fixtures/fake-docker'

// the traefik.* image label rule covered only the deployed service; a worker,
// cron or sidecar image (built or pulled by `up`) could add a router for any host.

const root = mkdtempSync(join(tmpdir(), 'lb-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// State dir: present/<image> marks a local image, labels/<image> its labels JSON.
function run(p: {
	fail?: Array<'pull' | 'build'>
	pp?: Record<string, string>
	have: string[]
	labels?: Record<string, string>
	builds: string[]
}) {
	const dir = mkdtempSync(join(root, 'c-'))
	mkdirSync(join(dir, 'present'))
	for (const i of p.have) writeFileSync(join(dir, 'present', i), '')
	const images: Record<string, string> = {
		app: 'shop:latest',
		worker: 'shop-worker',
		side: 'reg/side:1',
		db: 'postgres:16',
	}
	const cfg = ['name: shop', 'services:']
	for (const s of Object.keys(images)) {
		cfg.push(`  ${s}:`, `    image: ${images[s]}`)
		if (p.pp?.[s]) cfg.push(`    pull_policy: ${p.pp[s]}`)
	}
	writeFileSync(join(dir, 'cfg'), `${cfg.join('\n')}\n`)
	for (const f of p.fail ?? []) writeFileSync(join(dir, `fail${f}`), '')
	writeFileSync(join(dir, 'list'), p.builds.map((b) => `${b}|/ctx|Dockerfile|-|0`).join('\n'))
	const lab = (i: string) => p.labels?.[i] ?? '{"org.opencontainers.image.title":"x"}'
	const docker = `#!/bin/bash
D=${JSON.stringify(dir)}
echo "$*" >> "$D/calls"
key() { printf '%s' "$1" | tr '/:' '__'; }
case "$*" in
  *"config --services"*) printf 'app\\nworker\\nside\\ndb\\n'; exit 0;;
  *"config --images app"*) echo shop:latest; exit 0;;
  *"config --images worker"*) echo shop-worker; exit 0;;
  *"config --images side"*) echo reg/side:1; exit 0;;
  *"config --images db"*) echo postgres:16; exit 0;;
  *" config") cat "$D/cfg"; exit 0;;
  *" build worker") [ -e "$D/failbuild" ] && exit 1; touch "$D/present/shop-worker"; exit 0;;
  *" pull --ignore-buildable side") [ -e "$D/failpull" ] && exit 1; touch "$D/present/reg_side_1"; exit 0;;
  "image inspect -f"*) i="\${@: -1}"; [ -e "$D/present/$(key "$i")" ] || exit 1; case "$i" in ${Object.keys(
		p.labels ?? {},
	)
		.map((i) => `${JSON.stringify(i)}) echo ${JSON.stringify(lab(i))};;`)
		.join(' ')} *) echo '{"a":"b"}';; esac; exit 0;;
  "image inspect"*) i="\${@: -1}"; [ -e "$D/present/$(key "$i")" ]; exit $?;;
esac
exit 0
`
	const bin = join(dir, 'bin')
	mkdirSync(bin)
	writeFakeDocker(bin, docker)
	writeFileSync(join(bin, 'timeout'), '#!/bin/bash\nshift; exec "$@"\n')
	chmodSync(join(bin, 'timeout'), 0o755)
	const script =
		`retry() { "$@"; }; cap() { echo 60; }; CP_PROJ=shop; DFR_DIR=${JSON.stringify(dir)}; LB_F=""; ` +
		`${serviceImageLabelGuardShell("-f 'c.yml'", "-f 'c.yml' $DFR_F $LB_F", 'app', '')} && echo "PASSED F=$LB_F"`
	const r = spawnSync('bash', ['-c', script], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
	})
	let calls = ''
	try {
		calls = readFileSync(join(dir, 'calls'), 'utf8')
	} catch {}
	let ov = ''
	try {
		ov = readFileSync(join(dir, 'labels.yml'), 'utf8')
	} catch {}
	return { out: r.stdout + r.stderr, ok: r.stdout.includes('PASSED'), calls, ov }
}

const key = (i: string) => i.replace(/[/:]/g, '_')

describe('every service image passes the label rule', () => {
	it('refuses a worker image with a traefik.* label (old code checked only the deployed service)', () => {
		const r = run({
			have: ['shop_latest', 'shop-worker', 'reg_side_1', 'postgres_16'],
			labels: { 'shop-worker': '{"traefik.http.routers.x.rule":"Host(`victim.example`)"}' },
			builds: ['app', 'worker'],
		})
		expect(r.ok).toBe(false)
		expect(r.out).toContain('shop-worker (service worker) carries a traefik.* image label')
	})

	it('builds a pull_policy: build sibling now, checks it, and pins it so up does not rebuild', () => {
		const r = run({
			pp: { worker: 'build' },
			have: ['shop_latest', 'shop-worker', 'reg_side_1', 'postgres_16'],
			builds: ['app', 'worker'],
		})
		expect(r.ok).toBe(true)
		expect(r.calls).toContain('build worker')
		expect(r.ov).toContain('  worker:\n    pull_policy: missing\n')
		expect(r.out).toMatch(/F=-f .*labels\.yml/)
	})

	it('pulls a missing registry sidecar now and refuses one whose image carries a CR/LF label', () => {
		const ok = run({ have: ['shop_latest', 'shop-worker', 'postgres_16'], builds: ['app'] })
		expect(ok.ok).toBe(true)
		expect(ok.calls).toContain('pull --ignore-buildable side')
		expect(ok.ov).toContain('  side:\n    pull_policy: missing\n')
		const bad = run({
			have: ['shop_latest', 'shop-worker', 'postgres_16'],
			labels: { 'reg/side:1': '{"a":"b\\nc"}' },
			builds: ['app'],
		})
		expect(bad.ok).toBe(false)
		expect(bad.out).toContain('line break')
	})

	it('leaves unchanged multi-service apps alone: present images, default policy, no build, no pull, no pin', () => {
		const r = run({
			have: ['shop_latest', 'shop-worker', 'reg_side_1', 'postgres_16'],
			builds: ['app', 'worker'],
		})
		expect(r.ok).toBe(true)
		expect(r.calls).not.toMatch(/ build | pull /)
		// an empty set stays a valid compose file (an older container label may name it)
		expect(r.ov).toBe('services: {}\n')
		expect(r.out).toContain('PASSED F=\n')
	})

	it('a failing sibling pull or build is a WARN as before, and up cannot fetch that service unchecked', () => {
		const pull = run({
			fail: ['pull'],
			have: ['shop_latest', 'shop-worker', 'postgres_16'],
			builds: ['app'],
		})
		expect(pull.ok, pull.out).toBe(true)
		expect(pull.out).toContain('[image labels] WARN pulling service side failed')
		expect(pull.ov).toContain('  side:\n    pull_policy: never\n')
		const build = run({
			fail: ['build'],
			pp: { worker: 'build' },
			have: ['shop_latest', 'reg_side_1', 'postgres_16'],
			builds: ['app', 'worker'],
		})
		expect(build.ok, build.out).toBe(true)
		expect(build.ov).toContain('  worker:\n    pull_policy: never\n')
		// an image that is there after a failed pull is still checked
		const old = run({
			fail: ['pull'],
			pp: { side: 'always' },
			have: ['shop_latest', 'shop-worker', 'reg_side_1', 'postgres_16'],
			labels: { 'reg/side:1': '{"traefik.http.routers.x.rule":"Host(`v.example`)"}' },
			builds: ['app'],
		})
		expect(old.ok).toBe(false)
		expect(old.out).toContain('carries a traefik.* image label')
	})

	it('a build service whose pull_policy pulls is never pulled: built when missing, else pinned missing', () => {
		for (const pp of ['always', 'daily', 'weekly', 'refresh', 'every_12h']) {
			const have = run({
				pp: { worker: pp },
				have: ['shop_latest', 'shop-worker', 'reg_side_1', 'postgres_16'],
				builds: ['app', 'worker'],
			})
			expect(have.ok, have.out).toBe(true)
			expect(have.calls, pp).not.toMatch(/ pull /)
			expect(have.calls, pp).not.toContain('build worker')
			expect(have.ov, pp).toContain('  worker:\n    pull_policy: missing\n')
			const missing = run({
				pp: { worker: pp },
				have: ['shop_latest', 'reg_side_1', 'postgres_16'],
				builds: ['app', 'worker'],
			})
			expect(missing.ok, missing.out).toBe(true)
			expect(missing.calls, pp).not.toMatch(/ pull /)
			expect(missing.calls, pp).toContain('build worker')
			expect(missing.ov, pp).toContain('  worker:\n    pull_policy: missing\n')
		}
	})

	it('a build service pinned never (powder override) with no image is built and checked, never pulled', () => {
		const r = run({
			pp: { worker: 'never' },
			have: ['shop_latest', 'reg_side_1', 'postgres_16'],
			builds: ['app', 'worker'],
		})
		expect(r.ok, r.out).toBe(true)
		expect(r.calls).toContain('build worker')
		expect(r.calls).not.toMatch(/ pull /)
		expect(r.ov).toContain('  worker:\n    pull_policy: missing\n')
		const have = run({
			pp: { worker: 'never' },
			have: ['shop_latest', 'shop-worker', 'reg_side_1', 'postgres_16'],
			builds: ['app', 'worker'],
		})
		expect(have.calls).not.toContain('build worker')
		expect(have.ov).toBe('services: {}\n')
	})

	it('refuses a service whose image cannot be inspected; pull_policy never is skipped', () => {
		expect(key('reg/side:1')).toBe('reg_side_1')
		const never = run({
			pp: { side: 'never' },
			have: ['shop_latest', 'shop-worker', 'postgres_16'],
			builds: ['app'],
		})
		expect(never.ok).toBe(true)
	})

	it('runs in the deploy script after the deployed image check and before up, which carries $LB_F', () => {
		const s = buildDeployScript({
			workingDir: '/opt/apps/shop',
			configFile: '/opt/apps/shop/docker-compose.yml',
			service: 'app',
			cf: "-f '/opt/apps/shop/docker-compose.yml'",
			declaredMode: 'auto',
			prebuilt: false,
			infra: null,
			wantBranch: null,
			wantSha: null,
			shaIsStrict: false,
		})
		const at = s.indexOf('LB_OV="$DFR_DIR/labels.yml"')
		expect(at).toBeGreaterThan(s.indexOf('step "image labels"'))
		expect(at).toBeLessThan(s.indexOf('step "docker compose up"'))
		expect(s).toMatch(/docker compose [^;|]*\$LB_F up -d --force-recreate/)
	})
})
