import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit tests for the pure halves of the deploy/backup engine, no SSH. Modules that
// import `@powder/db` get a lazy postgres client that never connects unless a test
// queries. Only the *.db.test.ts files do: each uses a real Postgres (its own
// initdb, or POWDER_TEST_DATABASE_URL) and is skipped when none is available.
export default defineConfig({
	resolve: { alias: { '@': resolve(__dirname, 'src') } },
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node',
		// Many tests run generated shell scripts with stubs, and on a loaded machine (the
		// self-deploy test gate on a busy server) fork and exec slow them down several-fold.
		// This bounds an async hang. It does NOT bound a synchronous spawn: vitest cannot
		// interrupt a blocked event loop, so a spawnSync/execFileSync call needs its own
		// `timeout` option, and the gate's outer limit is the backstop.
		testTimeout: 120_000,
		hookTimeout: 120_000,
		// Yields to the event loop after every test (see the file for why).
		setupFiles: ['./vitest.setup.ts'],
		// the parent dir of the per-file hermetic roots, removed when the run ends
		globalSetup: ['./vitest.global-setup.ts'],
	},
})
