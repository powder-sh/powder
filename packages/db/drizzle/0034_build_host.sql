-- idempotent
-- Dedicated builder host per server ("builds off the app server").
-- When set (an IP/hostname the powder master key can reach), deploys for apps
-- on this server clone + build + test-gate on the builder instead of the
-- production server, and the built image is streamed through powder to the
-- target (`docker save | docker load`). NULL = build locally as before.
-- Keeps compiles off app servers (memory pressure during builds).
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "build_host" text;
