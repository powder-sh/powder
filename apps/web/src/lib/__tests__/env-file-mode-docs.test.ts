import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// powder's env file holds every secret; the install steps make it 0600 and
// bin/self-deploy.sh warns (never refuses) while group or other can read it.
const root = resolve(__dirname, '../../../../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8').replace(/\s+/g, ' ')

describe('env file mode', () => {
	for (const doc of ['docs/SELF-HOSTING.md', 'apps/web/content/docs/self-hosting.md']) {
		it(`${doc} creates the env file with chmod 600`, () => {
			expect(read(doc)).toMatch(/cp docker\/powder\.env\.example \/opt\/apps\/powder\.env && chmod 600 \/opt\/apps\/powder\.env/)
		})
	}
	it('bin/self-deploy.sh warns on a group/other readable env file and does not exit', () => {
		const s = readFileSync(resolve(root, 'bin/self-deploy.sh'), 'utf8')
		const block = s.slice(s.indexOf('ENV_MODE=$(ssh'), s.indexOf('# The bundled DB container'))
		expect(block).toContain('stat -c %a $ENVF')
		expect(block).toContain('WARNING')
		expect(block).toContain('chmod 600 $ENVF')
		expect(block).not.toMatch(/\bexit\b/)
	})
	it('the security model says a failed test network refuses the deploy', () => {
		const md = read('apps/web/content/docs/security-model.md')
		expect(md).toContain('the deploy is refused: there is no shared test network')
		expect(md).toContain('compose `include` and `extends` are refused outright')
	})
})
