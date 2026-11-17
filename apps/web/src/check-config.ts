// config preflight for a self-deploy. Runs in the NEW worker image with the
// server's powder.env BEFORE powder and the worker are recreated
// (`docker compose run --rm --no-deps --entrypoint pnpm worker -F @powder/web exec
// tsx src/check-config.ts`, see CONFIG_PREFLIGHT in bin/self-deploy.sh and
// selfConfigPreflightShell in lib/deploy/self-deploy.ts). The same productionConfigProblems
// the new containers refuse to start on: catching it here keeps the old containers
// serving instead of recreating into a crash loop.
import { CONFIG_BAD_MARKER, productionConfigProblems } from './lib/startup-checks'

const problems = productionConfigProblems({ ...process.env, NODE_ENV: 'production' })
if (problems.length > 0) {
	console.error(
		`${CONFIG_BAD_MARKER} the new powder would refuse to start:\n - ${problems.join('\n - ')}`,
	)
	process.exit(1)
}
console.log('[config-check] powder.env passes the production checks')
