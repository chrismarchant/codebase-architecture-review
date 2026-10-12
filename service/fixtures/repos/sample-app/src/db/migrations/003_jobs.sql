-- Postgres-backed job queue. Workers claim rows with FOR UPDATE SKIP LOCKED (see src/workers/queue.ts).
CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  attempts    integer NOT NULL DEFAULT 0,
  run_at      timestamptz NOT NULL DEFAULT now(),
  locked_at   timestamptz,
  finished_at timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_ready_idx ON jobs (status, run_at);
