-- Architecture Review service: initial schema (SS00 §7). Applied by packages/core/src/db/migrate.ts.
-- Dialect: PostgreSQL 14+; also valid on PGlite (tests). No extensions required.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS principals (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  is_admin    boolean NOT NULL DEFAULT false,
  disabled    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid PRIMARY KEY,
  principal_id  uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  prefix        text NOT NULL UNIQUE,          -- first 12 chars of the key, used for lookup
  hash          bytea NOT NULL,                -- sha256(secret)
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  id            text PRIMARY KEY,              -- random 32 bytes, base64url
  principal_id  uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS jobs (
  id                 uuid PRIMARY KEY,
  principal_id       uuid NOT NULL REFERENCES principals(id),
  kind               text NOT NULL DEFAULT 'scan',
  status             text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  outcome            text CHECK (outcome IN ('complete','partial')),
  cancel_requested   boolean NOT NULL DEFAULT false,
  request            jsonb NOT NULL,           -- normalised ScanRequest with repository.token removed
  options_hash       text NOT NULL,            -- sha256 of canonical options, for reuseExisting
  retrieval_secret   bytea,                    -- AES-256-GCM(token) with RETRIEVAL_KEK; NULL after retrieve
  repo_url           text NOT NULL,
  repo_ref           text,
  commit_sha         char(40),
  stage              text,
  progress           jsonb,
  checkpoint         jsonb,
  budgets            jsonb NOT NULL,
  usage              jsonb,
  failure            jsonb,
  attempt            integer NOT NULL DEFAULT 0,
  max_attempts       integer NOT NULL DEFAULT 3,
  lease_owner        text,
  lease_expires_at   timestamptz,
  fence_token        bigint NOT NULL DEFAULT 0,
  published_attempt  bigint,                   -- fence token of the attempt whose artifacts are visible
  manifest_sha256    text,
  idempotency_key    text,
  not_before         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  CONSTRAINT jobs_idempotency_unique UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, not_before, created_at);
CREATE INDEX IF NOT EXISTS jobs_principal_idx ON jobs(principal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_reuse_idx ON jobs(principal_id, repo_url, commit_sha, options_hash) WHERE status = 'succeeded';

CREATE TABLE IF NOT EXISTS job_events (
  job_id    uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq       bigint NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  level     text NOT NULL CHECK (level IN ('debug','info','warn','error')),
  stage     text,
  code      text NOT NULL,
  message   text NOT NULL,
  data      jsonb,
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE IF NOT EXISTS scan_grants (
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  principal_id  uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, principal_id)
);

CREATE TABLE IF NOT EXISTS comparisons (
  id            uuid PRIMARY KEY,
  principal_id  uuid NOT NULL REFERENCES principals(id),
  base_job_id   uuid NOT NULL REFERENCES jobs(id),
  head_job_id   uuid NOT NULL REFERENCES jobs(id),
  status        text NOT NULL CHECK (status IN ('ready','failed')),
  result_key    text,                          -- object key of comparison.json
  failure       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wake_log (
  id            bigserial PRIMARY KEY,
  job_id        uuid,
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  ok            boolean NOT NULL,
  status        integer,
  error         text
);

CREATE TABLE IF NOT EXISTS rate_limits (
  principal_id  uuid NOT NULL,
  bucket        text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (principal_id, bucket, window_start)
);
