import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({}))
vi.mock('../servers', () => ({}))
import { imageLabelGuardShell } from '../ssh'
import { buildDeployScript } from '../deploy/script'

const run = (labels: string, env = 'STAGE_IMG=img:build-1') => {
	const script = `docker() { if [ "$1" = compose ]; then return 0; fi; echo '${labels}'; }; ${env}; ${imageLabelGuardShell()} && echo PASSED`
	try {
		return { rc: 0, out: execFileSync('bash', ['-c', script], { encoding: 'utf8' }) }
	} catch (e) {
		const x = e as { status: number; stdout: string }
		return { rc: x.status, out: x.stdout }
	}
}

describe('image traefik label guard', () => {
	it('fails the deploy when the image carries a traefik.* label', () => {
		const r = run('{"traefik.http.routers.x.rule":"Host(`victim.com`)"}')
		expect(r.rc).toBe(1)
		expect(r.out).toContain('carries a traefik.* image label')
	})
	it('passes for ordinary labels and for null labels', () => {
		expect(run('{"org.opencontainers.image.source":"x"}').out).toContain('PASSED')
		expect(run('null').out).toContain('PASSED')
	})
	it('no STAGE_IMG/IMGREF still resolves an image (CP_PROJ-service fallback) and fails on a traefik label', () => {
		const r = run('{"traefik.x":"y"}', 'STAGE_IMG=; IMGREF=; CP_PROJ=proj')
		expect(r.rc).toBe(1)
		expect(r.out).toContain('proj-app carries a traefik.* image label')
	})
	it('uses docker compose config --images when IMGREF is unset', () => {
		const script = `docker() { if [ "$1" = compose ]; then echo reg/x:1; else echo '{"traefik.x":"y"}'; fi; }; ${imageLabelGuardShell('-f c.yml', 'web')} && echo PASSED`
		expect(() => execFileSync('bash', ['-c', script], { encoding: 'utf8' })).toThrow()
	})
	it('fails closed when nothing resolves and the service has a build: key', () => {
		const r = run('null', 'STAGE_IMG=; IMGREF=; CP_PROJ=; HAS_BUILD=y')
		expect(r.rc).toBe(1)
		expect(r.out).toContain('cannot resolve the image')
	})
	it('image resolves but inspect fails (no such image) and HAS_BUILD=y fails closed', () => {
		const script = `docker() { return 1; }; STAGE_IMG=img:1; HAS_BUILD=y; ${imageLabelGuardShell()} && echo PASSED`
		expect(() => execFileSync('bash', ['-c', script], { encoding: 'utf8' })).toThrow()
		const ok = `docker() { return 1; }; STAGE_IMG=img:1; HAS_BUILD=n; ${imageLabelGuardShell()} && echo PASSED`
		expect(execFileSync('bash', ['-c', ok], { encoding: 'utf8' })).toContain('PASSED')
	})
	it('nothing resolves and no build: key passes', () => {
		expect(run('null', 'STAGE_IMG=; IMGREF=; CP_PROJ=; HAS_BUILD=n').out).toContain('PASSED')
	})
	it('a rendered script WITHOUT swapOrdinal still runs the guard with an image expression', () => {
		const sc = buildDeployScript({
			workingDir: '/opt/apps/demo',
			configFile: '/opt/apps/demo/docker-compose.yml',
			service: 'app',
			cf: '-f /opt/apps/demo/docker-compose.yml',
			declaredMode: 'build',
			prebuilt: false,
			migrateApp: 'demo',
			infra: ['db'],
			wantBranch: 'main',
			wantSha: null,
			shaIsStrict: false,
		})
		expect(sc).toContain('step "image labels"')
		expect(sc).toContain('config --images')
		expect(sc).toContain('LB_IMG="$CP_PROJ-"')
	})
})
