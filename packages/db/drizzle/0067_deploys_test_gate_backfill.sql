-- idempotent
-- post-deploy
-- Backfill deploys.test_gate (0066) for the git deploys of the last 30 days, so the column
-- has history from the start for readers added later; nothing reads it yet, and this file
-- posts nothing anywhere. History only: these values come from the
-- stored log text, which an app's build output could have printed, so they are weaker
-- than the nonced mark new deploys record. The rules (first match wins):
--   a line "[test-gate] no .powder/test.sh ..." (either prefix)      -> 'none'
--     (checked first: only the script prints it, and with no .powder/test.sh any
--     pass line in the log came from the build output, not from a gate)
--   failed_step names the test gate                                  -> 'failed'
--     (the deploy failed AT the gate)
--   a whole line "[test-gate] passed" or "[builder test-gate] passed" -> 'passed'
--     (includes a deploy that passed the gate and failed at a later step)
--   anything else stays NULL.
-- Safe to run twice: only rows still NULL are touched, and a row a new deploy already
-- wrote is never changed. Bounded to kind = 'git_deploy' and started_at in the last
-- 30 days. Post-deploy, on two paths:
--   - container boot (docker/powder-entrypoint.sh): runs in the background once
--     /api/health answers; a failure is logged and the file retries on the next boot.
--   - bin/self-deploy.sh: runs right after `up`, before its health check; a failure
--     exits the script with 1, skipping the health check and every step after it,
--     the post-deploy hook included (the new code is already live; re-run the script).
-- Neither path sets a statement_timeout (bin/lib-migrations.sh sets lock_timeout 5s
-- only), so this file caps itself at 120s, the same limit as powder's query pool.
SET LOCAL statement_timeout = '120s';
UPDATE "deploys"
SET "test_gate" = CASE
	WHEN "output" ~ '(^|\n)\[(builder )?test-gate\] no \.powder/test\.sh' THEN 'none'
	WHEN "failed_step" ~* 'test gate' THEN 'failed'
	WHEN "output" ~ '(^|\n)\[(builder )?test-gate\] passed[ \t\r]*(\n|$)' THEN 'passed'
END
WHERE "test_gate" IS NULL
	AND "kind" = 'git_deploy'
	AND "started_at" > now() - interval '30 days'
	AND "status" IN ('success', 'failed')
	AND (
		"failed_step" ~* 'test gate'
		OR "output" ~ '(^|\n)\[(builder )?test-gate\] (passed|no \.powder/test\.sh)'
	);
