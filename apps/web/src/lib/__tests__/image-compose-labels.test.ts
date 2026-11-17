import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIDE_RUN_HARDEN } from '../deploy-snapshots'
import {
	COMPOSE_LABEL_BLANKS,
	imageComposeLabelProblems,
	imageLabelGuardShell,
} from '../deploy/fragments'

// an image may carry only the com.docker.compose.* labels `docker compose build`
// writes (project, service, version); any other one is refused in every mode.
const BUILT = {
	'com.docker.compose.project': 'demoapp',
	'com.docker.compose.service': 'web',
	'com.docker.compose.version': '2.35.1',
	'org.opencontainers.image.source': 'https://github.com/acme/web',
}

const guard = (labels: Record<string, string> | null) => {
	const dir = mkdtempSync(join(tmpdir(), 'img-'))
	writeFileSync(join(dir, 'labels.json'), JSON.stringify(labels))
	const script = `docker() { if [ "$1" = compose ]; then return 0; fi; cat ${dir}/labels.json; }; STAGE_IMG=img:build-1; ${imageLabelGuardShell()} && echo PASSED`
	try {
		return { rc: 0, out: execFileSync('bash', ['-c', script], { encoding: 'utf8' }) }
	} catch (e) {
		const x = e as { status: number; stdout: string }
		return { rc: x.status, out: x.stdout }
	}
}

describe('image compose labels', () => {
	it('passes the labels compose writes on every image it builds', () => {
		expect(guard(BUILT).out).toContain('PASSED')
		expect(guard(null).out).toContain('PASSED')
		expect(guard({}).out).toContain('PASSED')
		expect(imageComposeLabelProblems(BUILT)).toEqual([])
	})
	it.each([
		'com.docker.compose.project.config_files',
		'com.docker.compose.project.working_dir',
		'com.docker.compose.oneoff',
		'com.docker.compose.container-number',
		'com.docker.compose.anything-new',
	])('refuses %s on an image', (k) => {
		const r = guard({ ...BUILT, [k]: '/opt/apps/other/docker-compose.yml' })
		expect(r.rc).toBe(1)
		expect(r.out).toContain(k)
		expect(r.out).not.toContain('PASSED')
		expect(imageComposeLabelProblems({ ...BUILT, [k]: 'x' })).toEqual([k])
	})
	it('a value that merely mentions compose labels is not a key', () => {
		expect(guard({ note: '"com.docker.compose.oneoff"' }).out).toContain('PASSED')
	})
	it('containers powder starts outside compose drop NET_RAW and blank every compose key', () => {
		expect(SIDE_RUN_HARDEN).toContain('--cap-drop NET_RAW')
		for (const k of ['project', 'service', 'project.config_files', 'project.working_dir', 'oneoff'])
			expect(COMPOSE_LABEL_BLANKS).toContain(`--label com.docker.compose.${k}= `)
	})
})
