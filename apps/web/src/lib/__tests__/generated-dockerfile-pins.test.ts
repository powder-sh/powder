// Generated Dockerfiles for user apps pin their toolchain: exact base image tags,
// a fixed pnpm version and no install script piped from the network into a shell.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	BUN_IMAGE,
	dockerfileFor,
	type FrameworkInfo,
	NODE_IMAGE,
	type PackageManager,
	PNPM_VERSION,
} from '../framework-detect'

const FRAMEWORKS = ['next', 'vite', 'astro', 'sveltekit', 'remix', 'bun-server', 'node', 'unknown']
const PMS: PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun']
const fw = (id: string): FrameworkInfo => ({ id, displayName: id, defaultContainerPort: 3000 })

describe('generated Dockerfiles pin their toolchain', () => {
	it('the pins are exact versions', () => {
		expect(NODE_IMAGE).toMatch(/^node:\d+\.\d+\.\d+-alpine$/)
		expect(BUN_IMAGE).toMatch(/^oven\/bun:\d+\.\d+\.\d+-alpine$/)
		const pkg = JSON.parse(readFileSync(join(__dirname, '../../../../../package.json'), 'utf8'))
		expect(`pnpm@${PNPM_VERSION}`).toBe(pkg.packageManager)
	})
	for (const id of FRAMEWORKS) {
		for (const pm of PMS) {
			it(`${id} + ${pm}`, () => {
				const df = dockerfileFor(fw(id), pm, 'myapp')
				expect(df).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/)
				expect(df).not.toContain('@latest')
				for (const ref of [...df.matchAll(/^COPY --from=(\S+)/gm)].map((m) => m[1])) {
					if (ref.includes(':')) expect([NODE_IMAGE, BUN_IMAGE]).toContain(ref) // else a stage name
				}
				for (const ref of [...df.matchAll(/^FROM (\S+)/gm)].map((m) => m[1])) {
					expect([NODE_IMAGE, BUN_IMAGE]).toContain(ref)
				}
				if (pm === 'pnpm' && id !== 'bun-server') expect(df).toContain(`corepack prepare pnpm@${PNPM_VERSION} --activate`)
				if (pm === 'bun' && id !== 'bun-server') {
					expect(df).toContain(`COPY --from=${BUN_IMAGE} /usr/local/bin/bun /usr/local/bin/bun`)
				}
			})
		}
	}
})
