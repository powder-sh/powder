// every BuildKit cache mount in a powder-generated Dockerfile is per app.
import { describe, expect, it } from 'vitest'
import { cacheId, dockerfileFor } from '../framework-detect'

const fw = (id: string) => ({ id, displayName: id, defaultContainerPort: 3000 })

describe('generated cache mounts carry a per-app id', () => {
	it('for every framework and package manager', () => {
		for (const id of ['next', 'vite', 'remix', 'bun-server', 'node', 'unknown']) {
			for (const pm of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
				const df = dockerfileFor(fw(id), pm, 'shop')
				const mounts = df.match(/--mount=type=cache[^ ]*/g) ?? []
				expect(mounts.length, `${id}/${pm}`).toBeGreaterThan(0)
				for (const m of mounts) expect(m, `${id}/${pm}`).toMatch(/,id=shop-[a-z-]+,/)
				expect(df).not.toContain(dockerfileFor(fw(id), pm, 'other').match(/id=[^,]+/)?.[0])
			}
		}
	})
	it('ids are sanitized', () => {
		expect(cacheId('My App!', 'npm-cache')).toBe('my-app--npm-cache')
		expect(cacheId('--x', 'n')).toBe('x-n')
	})
})
