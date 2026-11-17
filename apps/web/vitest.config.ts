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
		// Many tests run bash scripts with stubs; under load (the self-deploy test
		// gate on a busy server) the 5 s default flakes.
		testTimeout: 30_000,
		// Yields to the event loop after every test (see the file for why).
		setupFiles: ['./vitest.setup.ts'],
		// the parent dir of the per-file hermetic roots, removed when the run ends
		globalSetup: ['./vitest.global-setup.ts'],
	},
})
