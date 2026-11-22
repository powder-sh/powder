import { existsSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bridgeShellFunctions, hostAppsDir, swapCheckShellFunctions } from '../deploy/fragments'
import { hermeticRoot } from './hermetic'

// Class guard: a generated script that reads a host config file (/opt/apps/.mem-cap)
// would let the real file of the machine running the suite beat the snapshot's 2g
// default, so the suite would pass or fail by machine. A
// generated bridge / swap-check script may read the app's own working dir (the test's
// fixture path) but no other /opt/apps path: host config files go through hostAppsDir,
// which every test file points at an empty dir in its hermetic root.
const WD = '/opt/apps/demo'
const plans = [
	{ path: '/api/health', strict: true, host: 'demo.example.com' },
	{ path: '/', strict: false },
	{ path: '/', strict: false, auth: false },
]
const scripts = [
	bridgeShellFunctions("-f 'c.yml'", 'app', WD, 'n1'),
	bridgeShellFunctions("-f 'c.yml'", 'app', WD),
	...plans.map((p) => swapCheckShellFunctions("-f 'c.yml'", 'app', WD, 'demo', p as never)),
]

/** Every /opt/apps path in `script` that is not under the fixture's working dir. */
function hostPathsOutsideWorkingDir(script: string): string[] {
	return [...script.matchAll(/\/opt\/apps(?:\/[^\s'"|;)]*)?/g)]
		.map((m) => m[0])
		.filter((p) => p !== WD && !p.startsWith(`${WD}/`))
}

describe('generated bridge / swap-check scripts never read real host paths in tests', () => {
	it('no /opt/apps path outside the fixture working dir', () => {
		for (const s of scripts) expect(hostPathsOutsideWorkingDir(s)).toEqual([])
	})
	it('host config files are read from the empty dir in this file hermetic root', () => {
		const dir = hostAppsDir()
		expect(dir.startsWith(hermeticRoot())).toBe(true)
		expect(existsSync(dir)).toBe(true)
		expect(readdirSync(dir)).toEqual([])
		for (const s of scripts.slice(0, 2)) expect(s).toContain(`cat ${dir}/.mem-cap`)
	})
	it('the guard itself catches a host path outside the working dir', () => {
		expect(hostPathsOutsideWorkingDir('cat /opt/apps/.mem-cap; ls /opt/apps/demo/src')).toEqual(['/opt/apps/.mem-cap'])
	})
	it('production is always /opt/apps: the override needs VITEST and a plain absolute path', () => {
		expect(hostAppsDir({})).toBe('/opt/apps')
		expect(hostAppsDir({ POWDER_TEST_HOST_APPS_DIR: '/tmp/x' })).toBe('/opt/apps')
		expect(hostAppsDir({ VITEST: 'true', POWDER_TEST_HOST_APPS_DIR: '/tmp/x; rm -rf /' })).toBe('/opt/apps')
		expect(hostAppsDir({ VITEST: 'true', POWDER_TEST_HOST_APPS_DIR: '/tmp/x' })).toBe('/tmp/x')
	})
})
