CREATE TABLE IF NOT EXISTS background_removal_usage (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES creative_owners(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  job_id text NOT NULL UNIQUE REFERENCES creative_jobs(id) ON DELETE CASCADE,
  source_asset_id text NOT NULL REFERENCES creative_assets(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
  daily_limit integer NOT NULL CHECK (daily_limit IN (5, 20)),
  balance_snapshot numeric,
  provider_request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, usage_date, idempotency_key)
);

CREATE INDEX IF NOT EXISTS background_removal_usage_owner_day_idx
  ON background_removal_usage(owner_id, usage_date, status);

CREATE INDEX IF NOT EXISTS background_removal_usage_source_idx
  ON background_removal_usage(owner_id, source_asset_id, created_at DESC);
