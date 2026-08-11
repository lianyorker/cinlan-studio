CREATE TABLE IF NOT EXISTS studio_identity_sessions (
  owner_id text PRIMARY KEY REFERENCES creative_owners(id) ON DELETE CASCADE,
  encrypted_access_token text NOT NULL,
  encrypted_refresh_token text,
  access_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauth_required', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS studio_provider_credentials (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES creative_owners(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'sub2api',
  group_id bigint NOT NULL CHECK (group_id >= 0),
  remote_key_id bigint,
  encrypted_api_key text,
  status text NOT NULL CHECK (status IN ('provisioning', 'active', 'invalid', 'orphaned_group', 'reauth_required', 'revoked')),
  rotation_version integer NOT NULL DEFAULT 0 CHECK (rotation_version >= 0),
  last_verified_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, provider, group_id)
);

CREATE INDEX IF NOT EXISTS studio_provider_credentials_owner_status_idx
  ON studio_provider_credentials(owner_id, status, group_id);

CREATE UNIQUE INDEX IF NOT EXISTS studio_provider_credentials_remote_key_idx
  ON studio_provider_credentials(provider, remote_key_id)
  WHERE remote_key_id IS NOT NULL;
