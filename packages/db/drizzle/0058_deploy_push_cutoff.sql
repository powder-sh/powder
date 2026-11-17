-- idempotent
-- rollback-tag push ownership (apps/web/src/lib/deploy-push-policy.ts). Records
-- once when this release first ran. A deploy pushes its `<repo>:deploy-<id>` tag only to
-- a repo the app pushed on a successful deploy that started BEFORE this moment (or, for an
-- app with no such history, a repo named after the app), and never to a repo another
-- registered app pushed more recently. Rows after the cutoff are not evidence: image_tag
-- is recorded for a skipped push too. Re-runs keep the first value.
INSERT INTO "powder_meta" ("key", "value") VALUES ('deploy_push_cutoff', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT ("key") DO NOTHING;
