// Next.js boot hook. Runs once per server process. In in-web mode (POWDER_DEPLOY_WORKER off) we
// start the in-process cron scheduler here so cron jobs fire even if no one's
// actively hitting the dashboard. When the deploy worker is enabled, the worker
// process owns the scheduler instead — web must NOT also start it, or both
// processes would tick (double cron fires, racing heartbeat owner).
export async function register() {
	if (process.env.NEXT_RUNTIME === 'nodejs') {
		// Refuse to boot under NODE_ENV=production with placeholder or missing secrets.
		const { exitOnBadProductionConfig, ignoredEnvNotes, startupWarnings } = await import(
			'./lib/startup-checks'
		)
		exitOnBadProductionConfig()
		for (const note of ignoredEnvNotes()) console.warn(`[startup] ${note}`)
		for (const w of startupWarnings()) console.warn(`[startup] WARNING: ${w}`)
		const { warnIfHostKeyChecksDisabled } = await import('./lib/ssh-host-keys')
		warnIfHostKeyChecksDisabled()
		// Fresh install (no admin ids, no users): print the one-time setup token.
		const { announceSetupTokenIfFirstRun } = await import('./lib/first-run')
		await announceSetupTokenIfFirstRun()
		// The install-wide settle window from the env file (POWDER_DEPLOY_SETTLE_SECONDS).
		const { syncSettleDefaultFromEnv } = await import('./lib/deploy-settle-env')
		await syncSettleDefaultFromEnv()
		const { deployWorkerEnabled } = await import('./lib/deploys')
		if (!deployWorkerEnabled()) {
			const { startCronScheduler } = await import('./lib/cron-scheduler')
			startCronScheduler('web')
		}
	}
}
