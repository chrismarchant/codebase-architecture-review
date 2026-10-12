import type {
  AnalysisBudgets,
  Checkpoint,
  Failure,
  JobEvent,
  JobOutcome,
  Progress,
  ProviderUsage,
  Stage,
} from '@archreview/contracts';
import type { Db, Queryable } from '../db/db.js';
import type { ClaimedJob, CreateJobInput, Fenced, JobRow, JobStore } from './store.js';

/** Thrown by create() when (principal_id, idempotency_key) already exists. */
export class IdempotencyConflict extends Error {
  override readonly name = 'IdempotencyConflict';
  constructor(
    readonly principalId: string,
    readonly idempotencyKey: string,
  ) {
    super('a job with this idempotency key already exists for the principal');
  }
}

/** Thrown by list() for a malformed cursor. */
export class InvalidCursorError extends Error {
  override readonly name = 'InvalidCursorError';
  constructor() {
    super('invalid pagination cursor');
  }
}

// Explicit column list: retrieval_secret (encrypted token) is never loaded with the row.
const COLS = `id, principal_id, kind, status, outcome, cancel_requested, request, options_hash, repo_url, repo_ref,
  commit_sha, stage, progress, checkpoint, budgets, usage, failure, attempt, max_attempts, lease_owner,
  lease_expires_at, fence_token, published_attempt, manifest_sha256, idempotency_key, not_before,
  created_at, updated_at, started_at, finished_at`;

// Precise (microsecond) text form of created_at for keyset cursors; JS Dates would truncate to ms.
const CURSOR_TS = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Predicate shared by every worker-side write: the caller's fence token must be the
 * current one, and the job must not have been returned to the queue (after a requeue
 * the fence is unchanged until the next claim, so a zombie worker would otherwise pass).
 * Terminal states are allowed so stage-7 cleanup can still record its final writes.
 */
const FENCED = `id = $1 AND fence_token = $2 AND status <> 'queued'`;

type Row = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
const json = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);
const jsonOrNull = (v: unknown): unknown => (v === null || v === undefined ? null : json(v));
const toJson = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

export function mapJobRow(r: Row): JobRow {
  return {
    id: r.id as string,
    principalId: r.principal_id as string,
    status: r.status as JobRow['status'],
    outcome: (r.outcome ?? null) as JobRow['outcome'],
    cancelRequested: r.cancel_requested as boolean,
    request: json(r.request) as JobRow['request'],
    optionsHash: r.options_hash as string,
    repoUrl: r.repo_url as string,
    repoRef: (r.repo_ref ?? null) as string | null,
    commitSha: r.commit_sha === null || r.commit_sha === undefined ? null : String(r.commit_sha).trim(),
    stage: (r.stage ?? null) as Stage | null,
    progress: jsonOrNull(r.progress) as Progress | null,
    checkpoint: jsonOrNull(r.checkpoint) as Checkpoint | null,
    budgets: json(r.budgets) as AnalysisBudgets,
    usage: jsonOrNull(r.usage) as ProviderUsage | null,
    failure: jsonOrNull(r.failure) as Failure | null,
    attempt: num(r.attempt),
    maxAttempts: num(r.max_attempts),
    leaseOwner: (r.lease_owner ?? null) as string | null,
    leaseExpiresAt: dateOrNull(r.lease_expires_at),
    fenceToken: num(r.fence_token),
    publishedAttempt: numOrNull(r.published_attempt),
    manifestSha256: (r.manifest_sha256 ?? null) as string | null,
    idempotencyKey: (r.idempotency_key ?? null) as string | null,
    notBefore: dateOrNull(r.not_before),
    createdAt: dateOrNull(r.created_at) as Date,
    updatedAt: dateOrNull(r.updated_at) as Date,
    startedAt: dateOrNull(r.started_at),
    finishedAt: dateOrNull(r.finished_at),
  };
}

function mapEvent(r: Row): JobEvent {
  const at = r.at instanceof Date ? r.at : new Date(String(r.at));
  const evt: JobEvent = {
    seq: num(r.seq),
    at: at.toISOString(),
    level: r.level as JobEvent['level'],
    stage: (r.stage ?? null) as JobEvent['stage'],
    code: r.code as string,
    message: r.message as string,
  };
  const data = jsonOrNull(r.data);
  if (data !== null) evt.data = data;
  return evt;
}

function pgCode(err: unknown): { code?: string; constraint?: string } {
  return typeof err === 'object' && err !== null ? (err as { code?: string; constraint?: string }) : {};
}

function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify([ts, id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') {
      if (CURSOR_TS_RE.test(v[0]) && UUID_RE.test(v[1])) return [v[0], v[1]];
    }
  } catch {
    /* fall through */
  }
  throw new InvalidCursorError();
}

// Interval from a millisecond parameter. The explicit cast keeps the parameter type resolvable on pg and PGlite.
const ms = (p: string) => `(${p}::double precision * interval '1 millisecond')`;

export class PgJobStore implements JobStore {
  constructor(private readonly db: Db) {}

  // --- API side -----------------------------------------------------------

  async create(input: CreateJobInput): Promise<JobRow> {
    // Defence in depth: the retrieval token must never be persisted inside the request JSON.
    const { token: _token, ...repository } = input.request.repository;
    const request = { ...input.request, repository };
    try {
      const res = await this.db.query<Row>(
        `INSERT INTO jobs (id, principal_id, status, request, options_hash, retrieval_secret, repo_url, repo_ref,
                           budgets, max_attempts, idempotency_key)
         VALUES ($1, $2, 'queued', $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9, $10)
         RETURNING ${COLS}`,
        [
          input.id,
          input.principalId,
          JSON.stringify(request),
          input.optionsHash,
          input.retrievalSecret ? Buffer.from(input.retrievalSecret) : null,
          repository.url,
          repository.ref ?? null,
          JSON.stringify(input.budgets),
          input.maxAttempts,
          input.idempotencyKey,
        ],
      );
      return mapJobRow(res.rows[0] as Row);
    } catch (err) {
      const { code, constraint } = pgCode(err);
      if (code === '23505' && constraint === 'jobs_idempotency_unique' && input.idempotencyKey !== null) {
        throw new IdempotencyConflict(input.principalId, input.idempotencyKey);
      }
      throw err;
    }
  }

  async findByIdempotencyKey(principalId: string, key: string): Promise<JobRow | null> {
    return this.one(`SELECT ${COLS} FROM jobs WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key]);
  }

  async findReusable(principalId: string, repoUrl: string, commitSha: string, optionsHash: string): Promise<JobRow | null> {
    return this.one(
      `SELECT ${COLS} FROM jobs
       WHERE principal_id = $1 AND repo_url = $2 AND commit_sha = $3 AND options_hash = $4 AND status = 'succeeded'
       ORDER BY finished_at DESC NULLS LAST, created_at DESC LIMIT 1`,
      [principalId, repoUrl, commitSha, optionsHash],
    );
  }

  async get(id: string): Promise<JobRow | null> {
    return this.one(`SELECT ${COLS} FROM jobs WHERE id = $1`, [id]);
  }

  async getForPrincipal(id: string, principalId: string): Promise<JobRow | null> {
    return this.one(
      `SELECT ${COLS} FROM jobs
       WHERE id = $1 AND (principal_id = $2 OR EXISTS (SELECT 1 FROM scan_grants g WHERE g.job_id = jobs.id AND g.principal_id = $2))`,
      [id, principalId],
    );
  }

  async list(
    principalId: string,
    opts: { limit: number; cursor?: string | null },
  ): Promise<{ items: JobRow[]; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(Math.trunc(opts.limit), 200));
    const params: unknown[] = [principalId, limit + 1];
    let where = 'principal_id = $1';
    if (opts.cursor) {
      const [ts, id] = decodeCursor(opts.cursor);
      params.push(ts, id);
      where += ' AND (created_at, id) < ($3::timestamptz, $4::uuid)';
    }
    const res = await this.db.query<Row>(
      `SELECT ${COLS}, ${CURSOR_TS} AS cursor_ts FROM jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $2`,
      params,
    );
    const hasMore = res.rows.length > limit;
    const page = hasMore ? res.rows.slice(0, limit) : res.rows;
    const last = page[page.length - 1];
    return {
      items: page.map(mapJobRow),
      nextCursor: hasMore && last ? encodeCursor(last.cursor_ts as string, last.id as string) : null,
    };
  }

  async queuePosition(id: string): Promise<number | null> {
    const res = await this.db.query<Row>(
      `SELECT (SELECT count(*) FROM jobs o WHERE o.status = 'queued' AND (o.created_at, o.id) < (j.created_at, j.id)) AS pos
       FROM jobs j WHERE j.id = $1 AND j.status = 'queued'`,
      [id],
    );
    const row = res.rows[0];
    return row ? num(row.pos) : null;
  }

  async requestCancel(id: string): Promise<JobRow | null> {
    // One statement; every SET expression sees the pre-update row, so the CASEs agree with each other.
    const res = await this.db.query<Row>(
      `UPDATE jobs SET
         cancel_requested = true,
         status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
         finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END,
         retrieval_secret = CASE WHEN status = 'queued' THEN NULL ELSE retrieval_secret END,
         updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')
       RETURNING ${COLS}`,
      [id],
    );
    const row = res.rows[0];
    return row ? mapJobRow(row) : this.get(id); // terminal or unknown: unchanged
  }

  async listEvents(id: string, afterSeq = 0, limit = 100): Promise<JobEvent[]> {
    const res = await this.db.query<Row>(
      `SELECT seq, at, level, stage, code, message, data FROM job_events
       WHERE job_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [id, afterSeq, Math.max(1, Math.min(Math.trunc(limit), 1000))],
    );
    return res.rows.map(mapEvent);
  }

  async listNeedingWake(olderThanMs: number, limit: number): Promise<JobRow[]> {
    // "Never woken" (no wake_log row) or last attempt (ok or not) older than the threshold.
    // Jobs deferred by not_before are not due yet.
    const res = await this.db.query<Row>(
      `SELECT ${COLS} FROM jobs
       WHERE status = 'queued' AND (not_before IS NULL OR not_before <= now())
         AND NOT EXISTS (
           SELECT 1 FROM wake_log w WHERE w.job_id = jobs.id AND w.attempted_at > now() - ${ms('$1')}
         )
       ORDER BY created_at LIMIT $2`,
      [olderThanMs, limit],
    );
    return res.rows.map(mapJobRow);
  }

  async listExpiredLeases(graceMs: number, limit: number): Promise<JobRow[]> {
    const res = await this.db.query<Row>(
      `SELECT ${COLS} FROM jobs
       WHERE status = 'running' AND lease_expires_at < now() - ${ms('$1')}
       ORDER BY lease_expires_at LIMIT $2`,
      [graceMs, limit],
    );
    return res.rows.map(mapJobRow);
  }

  async requeueOrFailExpired(id: string, expectedFence: number, backoffMs: number): Promise<'requeued' | 'failed' | 'skipped'> {
    const requeue = 'attempt < max_attempts';
    const res = await this.db.query<Row>(
      `UPDATE jobs SET
         status = CASE WHEN ${requeue} THEN 'queued' ELSE 'failed' END,
         not_before = CASE WHEN ${requeue} THEN now() + ${ms('$3')} ELSE not_before END,
         lease_owner = NULL,
         lease_expires_at = NULL,
         failure = CASE WHEN ${requeue} THEN failure ELSE jsonb_strip_nulls(jsonb_build_object(
           'code', 'max_attempts', 'message', $4::text, 'stage', stage, 'retryable', false, 'at', $5::text)) END,
         finished_at = CASE WHEN ${requeue} THEN finished_at ELSE now() END,
         retrieval_secret = CASE WHEN ${requeue} THEN retrieval_secret ELSE NULL END,
         updated_at = now()
       WHERE id = $1 AND fence_token = $2 AND status = 'running' AND lease_expires_at < now()
       RETURNING status`,
      [id, expectedFence, backoffMs, 'lease expired and the attempt limit was reached', new Date().toISOString()],
    );
    const row = res.rows[0];
    if (!row) return 'skipped';
    return row.status === 'queued' ? 'requeued' : 'failed';
  }

  async recordWake(jobId: string | null, ok: boolean, status: number | null, error: string | null): Promise<void> {
    await this.db.query('INSERT INTO wake_log (job_id, ok, status, error) VALUES ($1, $2, $3, $4)', [
      jobId,
      ok,
      status,
      error === null ? null : error.slice(0, 1024),
    ]);
  }

  // --- Runner side ----------------------------------------------------------

  async claim(workerId: string, slots: number, leaseTtlMs: number): Promise<ClaimedJob[]> {
    const n = Math.trunc(slots);
    if (!(n > 0)) return [];
    // A single statement is the atomicity boundary (ADR-006). The `attempt < max_attempts` guard on the
    // expired-lease branch keeps exhausted jobs out of the claim: the reconciler fails them
    // (requeueOrFailExpired) instead of letting a runner run a fourth attempt.
    const res = await this.db.query<Row>(
      `UPDATE jobs SET status = 'running', lease_owner = $1, lease_expires_at = now() + ${ms('$2')},
         fence_token = fence_token + 1, attempt = attempt + 1, started_at = COALESCE(started_at, now()), updated_at = now()
       WHERE id IN (
         SELECT id FROM jobs
         WHERE (status = 'queued' AND (not_before IS NULL OR not_before <= now()))
            OR (status = 'running' AND lease_expires_at < now() AND attempt < max_attempts)
         ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED)
       RETURNING ${COLS}`,
      [workerId, leaseTtlMs, n],
    );
    return res.rows.map(mapJobRow).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async heartbeat(f: Fenced, workerId: string, leaseTtlMs: number): Promise<boolean> {
    return this.fenced(
      `UPDATE jobs SET lease_expires_at = now() + ${ms('$4')}, updated_at = now()
       WHERE ${FENCED} AND lease_owner = $3`,
      [f.jobId, f.fenceToken, workerId, leaseTtlMs],
    );
  }

  async isCancelRequested(jobId: string): Promise<boolean> {
    const res = await this.db.query<Row>('SELECT cancel_requested FROM jobs WHERE id = $1', [jobId]);
    return res.rows[0]?.cancel_requested === true;
  }

  async readRetrievalSecret(f: Fenced): Promise<Uint8Array | null> {
    const res = await this.db.query<Row>(
      `SELECT retrieval_secret FROM jobs WHERE ${FENCED}`,
      [f.jobId, f.fenceToken],
    );
    const v = res.rows[0]?.retrieval_secret;
    return v ? new Uint8Array(v as Uint8Array) : null;
  }

  clearRetrievalSecret(f: Fenced): Promise<boolean> {
    return this.fenced(`UPDATE jobs SET retrieval_secret = NULL, updated_at = now() WHERE ${FENCED}`, [f.jobId, f.fenceToken]);
  }

  setStage(f: Fenced, stage: Stage, progress: Progress): Promise<boolean> {
    return this.fenced(`UPDATE jobs SET stage = $3, progress = $4::jsonb, updated_at = now() WHERE ${FENCED}`, [
      f.jobId,
      f.fenceToken,
      stage,
      JSON.stringify(progress),
    ]);
  }

  setProgress(f: Fenced, progress: Progress): Promise<boolean> {
    return this.fenced(`UPDATE jobs SET progress = $3::jsonb, updated_at = now() WHERE ${FENCED}`, [
      f.jobId,
      f.fenceToken,
      JSON.stringify(progress),
    ]);
  }

  setCommit(f: Fenced, commitSha: string): Promise<boolean> {
    return this.fenced(`UPDATE jobs SET commit_sha = $3, updated_at = now() WHERE ${FENCED}`, [f.jobId, f.fenceToken, commitSha]);
  }

  setCheckpoint(f: Fenced, checkpoint: Checkpoint): Promise<boolean> {
    return this.fenced(`UPDATE jobs SET checkpoint = $3::jsonb, updated_at = now() WHERE ${FENCED}`, [
      f.jobId,
      f.fenceToken,
      JSON.stringify(checkpoint),
    ]);
  }

  setUsage(f: Fenced, usage: ProviderUsage): Promise<boolean> {
    return this.fenced(`UPDATE jobs SET usage = $3::jsonb, updated_at = now() WHERE ${FENCED}`, [
      f.jobId,
      f.fenceToken,
      JSON.stringify(usage),
    ]);
  }

  async appendEvent(jobId: string, evt: Omit<JobEvent, 'seq' | 'at'>): Promise<void> {
    const insert = (tx: Queryable) =>
      tx.query(
        `INSERT INTO job_events (job_id, seq, level, stage, code, message, data)
         SELECT $1::uuid, COALESCE(MAX(seq), 0) + 1, $2, $3, $4, $5, $6::jsonb FROM job_events WHERE job_id = $1::uuid`,
        [jobId, evt.level, evt.stage ?? null, evt.code, evt.message, toJson(evt.data)],
      );
    // Concurrent appenders can compute the same seq; the primary key rejects the loser, which retries.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.db.transaction(insert);
        return;
      } catch (err) {
        if (pgCode(err).code === '23505' && attempt < 8) continue;
        throw err;
      }
    }
  }

  publish(f: Fenced, outcome: JobOutcome, manifestSha256: string): Promise<boolean> {
    return this.fenced(
      `UPDATE jobs SET status = 'succeeded', outcome = $3, published_attempt = fence_token, manifest_sha256 = $4,
         finished_at = now(), retrieval_secret = NULL, updated_at = now()
       WHERE id = $1 AND fence_token = $2 AND status = 'running'`,
      [f.jobId, f.fenceToken, outcome, manifestSha256],
    );
  }

  async fail(f: Fenced, failure: Failure, backoffMs: number): Promise<'failed' | 'requeued' | 'fenced'> {
    const requeue = '($3::boolean AND attempt < max_attempts)';
    const res = await this.db.query<Row>(
      `UPDATE jobs SET
         status = CASE WHEN ${requeue} THEN 'queued' ELSE 'failed' END,
         failure = CASE WHEN ${requeue} THEN failure ELSE $4::jsonb END,
         not_before = CASE WHEN ${requeue} THEN now() + ${ms('$5')} ELSE not_before END,
         lease_owner = CASE WHEN ${requeue} THEN NULL ELSE lease_owner END,
         lease_expires_at = CASE WHEN ${requeue} THEN NULL ELSE lease_expires_at END,
         finished_at = CASE WHEN ${requeue} THEN finished_at ELSE now() END,
         retrieval_secret = CASE WHEN ${requeue} THEN retrieval_secret ELSE NULL END,
         updated_at = now()
       WHERE id = $1 AND fence_token = $2 AND status = 'running'
       RETURNING status`,
      [f.jobId, f.fenceToken, failure.retryable, JSON.stringify(failure), backoffMs],
    );
    const row = res.rows[0];
    if (!row) return 'fenced';
    return row.status === 'queued' ? 'requeued' : 'failed';
  }

  markCancelled(f: Fenced): Promise<boolean> {
    return this.fenced(
      `UPDATE jobs SET status = 'cancelled', cancel_requested = true, finished_at = now(), retrieval_secret = NULL, updated_at = now()
       WHERE id = $1 AND fence_token = $2 AND status = 'running'`,
      [f.jobId, f.fenceToken],
    );
  }

  releaseLease(f: Fenced): Promise<boolean> {
    // Running: expire the lease now so the next claim can take it (SS00 §10.6). Terminal (stage 7 after
    // publish/fail/cancel): drop the lease entirely.
    return this.fenced(
      `UPDATE jobs SET
         lease_expires_at = CASE WHEN status = 'running' THEN now() - interval '1 millisecond' ELSE NULL END,
         lease_owner = CASE WHEN status = 'running' THEN lease_owner ELSE NULL END,
         updated_at = now()
       WHERE ${FENCED}`,
      [f.jobId, f.fenceToken],
    );
  }

  // --- helpers --------------------------------------------------------------

  private async one(sql: string, params: unknown[]): Promise<JobRow | null> {
    const res = await this.db.query<Row>(sql, params);
    const row = res.rows[0];
    return row ? mapJobRow(row) : null;
  }

  private async fenced(sql: string, params: unknown[]): Promise<boolean> {
    const res = await this.db.query(sql, params);
    return res.rowCount === 1;
  }
}
