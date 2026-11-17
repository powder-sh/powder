// print every app's env render target and whether it survives the env file
// containment rule (lib/env-pin-report.ts). Read-only. Run in the worker image:
// bin/self-deploy.sh --pin-report.
import { runPinReport } from './lib/env-pin-report'

runPinReport()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(`[env-pin-report] failed: ${err instanceof Error ? err.message : String(err)}`)
		process.exit(1)
	})
