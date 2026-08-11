CREATE TABLE IF NOT EXISTS creative_owners (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('user', 'api_key')),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creative_credentials (
  owner_id text PRIMARY KEY REFERENCES creative_owners(id) ON DELETE CASCADE,
  encrypted_api_key text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creative_assets (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES creative_owners(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reference', 'mask', 'result', 'thumbnail')),
  original_name text,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 text,
  storage_path text,
  external_url text,
  width integer,
  height integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (storage_path IS NOT NULL OR external_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS creative_assets_owner_created_idx ON creative_assets(owner_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS creative_assets_owner_sha_idx ON creative_assets(owner_id, sha256, kind) WHERE sha256 IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS creative_jobs (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES creative_owners(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('GENERATE', 'EDIT')),
  status text NOT NULL CHECK (status IN ('CREATED','ANALYZING','READY','QUEUED','RUNNING','VALIDATING','COMPLETED','PARTIAL_SUCCESS','CANCEL_REQUESTED','CANCELLED','FAILED','EXPIRED')),
  model text NOT NULL,
  prompt_original text NOT NULL,
  prompt_compiled text,
  plan jsonb,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_task_id text,
  provider_request_id text,
  idempotency_key text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  poll_count integer NOT NULL DEFAULT 0,
  result_count integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  lease_owner text,
  lease_expires_at timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  deleted_at timestamptz,
  UNIQUE(owner_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS creative_jobs_claim_idx ON creative_jobs(status, next_run_at, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS creative_jobs_owner_created_idx ON creative_jobs(owner_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS creative_job_assets (
  job_id text NOT NULL REFERENCES creative_jobs(id) ON DELETE CASCADE,
  asset_id text NOT NULL REFERENCES creative_assets(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('input', 'mask', 'output', 'thumbnail')),
  ordinal integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id, role, ordinal),
  UNIQUE(job_id, asset_id, role)
);

CREATE TABLE IF NOT EXISTS creative_job_events (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES creative_jobs(id) ON DELETE CASCADE,
  type text NOT NULL,
  phase text NOT NULL,
  message_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creative_job_events_job_idx ON creative_job_events(job_id, id);

CREATE TABLE IF NOT EXISTS creative_versions (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES creative_owners(id) ON DELETE CASCADE,
  job_id text NOT NULL UNIQUE REFERENCES creative_jobs(id) ON DELETE CASCADE,
  parent_version_id text REFERENCES creative_versions(id) ON DELETE SET NULL,
  result_asset_id text NOT NULL REFERENCES creative_assets(id) ON DELETE RESTRICT,
  prompt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creative_versions_owner_created_idx ON creative_versions(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS model_capabilities (
  model_slug text PRIMARY KEY,
  capabilities jsonb NOT NULL,
  source text NOT NULL,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
