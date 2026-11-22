// The adopt flows (repo connect, repo import) refuse a container whose compose working
// dir is in powder's preview namespace, /opt/apps/pv-*: a pre-marker preview teardown
// may remove such a dir, and the container name does not show where it runs from.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adoptWorkingDirProblem } from '../app-names'

describe('adoptWorkingDirProblem', () => {
	it.each(['/opt/apps/pv-shop-x', '/opt/apps/pv-shop-x/', '/opt/apps/pv-a/sub', '/opt/apps/PV-x', '//opt//apps//pv-x'])(
		'refuses %s',
		(wd) => {
			expect(adoptWorkingDirProblem(wd)).toBe(
				`the container's compose directory ${wd} is in powder's preview namespace: names under /opt/apps/pv-* are reserved for previews, and a preview of that name would be refused because the directory is not its own. Move the app to a directory with another name, start it from there, then connect it again`,
			)
		},
	)
	it('refuses a path with ..', () => {
		expect(adoptWorkingDirProblem('/opt/apps/x/../pv-y')).toMatch(/not a plain path/)
	})
	it.each(['/opt/apps/shop', '/opt/apps/shop-pv-x', '/srv/pv-x', null, undefined, ''])('accepts %s', (wd) => {
		expect(adoptWorkingDirProblem(wd)).toBeNull()
	})
	it('both adopt routes apply it next to adoptContainerProblem', () => {
		const base = join(__dirname, '../../app/api/servers/[id]/containers/[name]/repo')
		for (const f of ['route.ts', 'import/route.ts'])
			expect(readFileSync(join(base, f), 'utf8')).toContain(
				'adoptContainerProblem(name, detail.compose.project) ?? adoptWorkingDirProblem(detail.compose.workingDir)',
			)
	})
})
