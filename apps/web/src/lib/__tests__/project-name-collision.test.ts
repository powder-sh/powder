// a new or imported app whose compose project name (lowercase, [a-z0-9_-] only)
// equals another app's on the server, or powder's, is refused before anything is written.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectNameCollisionError } from '../app-names'

describe('project name collision', () => {
	it('refuses a name that normalises to another app or a powder name', () => {
		expect(projectNameCollisionError('Tea.Shop', ['teashop'])).toContain('teashop')
		expect(projectNameCollisionError('teashop', ['Tea.Shop'])).toContain('Tea.Shop')
		expect(projectNameCollisionError('Powder', [])).toContain('powder')
		expect(projectNameCollisionError('traefik', [])).toContain('traefik')
		expect(projectNameCollisionError('...', [])).toContain('no characters')
	})
	it('passes a distinct name, and the app itself in the list', () => {
		expect(projectNameCollisionError('teashop', ['teashop', 'coffee-bar'])).toBeNull()
		expect(projectNameCollisionError('tea-shop', ['teashop'])).toBeNull()
	})
	it('every create / import path checks it before writing', () => {
		const api = join(__dirname, '..', '..', 'app', 'api')
		for (const f of [
			join(api, 'apps', 'route.ts'),
			join(api, 'servers', '[id]', 'containers', '[name]', 'repo', 'route.ts'),
			join(api, 'servers', '[id]', 'containers', '[name]', 'repo', 'import', 'route.ts'),
		]) {
			const src = readFileSync(f, 'utf8')
			const check = src.indexOf('await projectNameProblem(')
			expect(check).toBeGreaterThan(-1)
			expect(check).toBeLessThan(src.indexOf('await createRepo('))
		}
		expect(readFileSync(join(__dirname, '..', 'repos.ts'), 'utf8')).toMatch(/const clash = await projectNameProblem\(input\.serverId/)
	})
})
