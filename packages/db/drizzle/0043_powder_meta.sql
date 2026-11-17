-- idempotent
-- Small key/value table for instance-level facts. First user: the cached
-- result of the daily update check (key 'update_check').
CREATE TABLE IF NOT EXISTS powder_meta (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
