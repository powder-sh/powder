// README.md and the quickstart show the install commands literally, so they read
// right on GitHub too. They must equal lib/install-command.ts for the version in the
// root package.json: a version bump that forgets them fails here (the maintainers'
// release tooling rewrites them when it bumps).
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installLines } from '../install-command'
import { PUBLIC_REPO_URL } from '../site'

const ROOT = resolve(__dirname, '../../../../..')
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
// Lines without their indentation (the quickstart's block sits inside a list item).
const flat = (s: string) =>
	s
		.split('\n')
		.map((l) => l.trim())
		.join('\n')

describe('install commands written out in the docs', () => {
	const block = installLines(version).join('\n')

	it.each(['README.md', 'apps/web/content/docs/quickstart.md'])('%s has the block for the package.json version', (p) => {
		expect(flat(read(p))).toContain(`\`\`\`bash\n${block}\n\`\`\``)
	})

	it('self-hosting.md clones the same tag', () => {
		expect(read('apps/web/content/docs/self-hosting.md')).toContain(
			`git clone --branch v${version} ${PUBLIC_REPO_URL} /opt/apps/powder/src`,
		)
	})

	it('no other release tag and no placeholder is left in those files', () => {
		for (const p of ['README.md', 'apps/web/content/docs/quickstart.md', 'apps/web/content/docs/self-hosting.md']) {
			const text = read(p)
			for (const m of text.matchAll(/--branch (v\S+)/g)) expect(m[1], p).toBe(`v${version}`)
			expect(text, p).not.toMatch(/\{\{INSTALL_[A-Z]+\}\}/)
		}
	})
})
