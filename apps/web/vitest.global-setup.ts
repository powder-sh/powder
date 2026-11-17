import { mkdtempSync, rmSync } from 'node:fs'
import { HERMETIC_BASE } from './src/lib/__tests__/hermetic'

// One parent dir per run for the per-file hermetic roots (src/lib/__tests__/hermetic.ts).
// A file whose tests are all skipped runs no afterAll, so its root is removed
// here, with the whole parent, when the run ends.
export default function setup() {
	// short and fixed, never the long macOS TMPDIR (see hermetic.ts)
	const parent = mkdtempSync(HERMETIC_BASE)
	process.env.VITEST_HERMETIC_PARENT = parent
	return () => rmSync(parent, { recursive: true, force: true })
}
