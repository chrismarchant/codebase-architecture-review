import type pg from 'pg';
import type { Queryable } from '../db/client.js';

export interface JobRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
}

export type JobHandler = (job: JobRow) => Promise<void>;

export interface ConsumerOptions {
  pool: pg.Pool;
  handlers: Record<string, JobHandler>;
  pollIntervalMs: number;
  maxAttempts: number;
}

export interface Consumer {
  /** Stops claiming new jobs and waits for the job in progress, if any, to finish. */
  stop(): Promise<void>;
}

/** A row locked longer than this is treated as abandoned by a crashed worker and claimed again. */
const STALE_LOCK = `interval '5 minutes'`;

/** Inserts a job. Pass the transaction client so the job commits with the business write. */
export async function enqueueJob(db: Queryable, type: string, payload: unknown): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO jobs (type, payload) VALUES ($1, $2::jsonb) RETURNING id::text AS id`,
    [type, JSON.stringify(payload)],
  );
  const row = result.rows[0];
  if (!row) throw new Error('enqueue returned no row');
  return row.id;
}

/** Claims one ready job. SKIP LOCKED lets several workers claim concurrently without blocking. */
export async function claimNextJob(pool: pg.Pool): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `UPDATE jobs
        SET status = 'running', locked_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE (status = 'queued' AND run_at <= now())
            OR (status = 'running' AND locked_at < now() - ${STALE_LOCK})
         ORDER BY run_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id::text AS id, type, payload, attempts`,
  );
  return result.rows[0] ?? null;
}

async function completeJob(pool: pg.Pool, id: string): Promise<void> {
  await pool.query(`UPDATE jobs SET status = 'succeeded', finished_at = now(), locked_at = NULL WHERE id = $1`, [id]);
}

/** Requeues with a linear backoff (30 s per attempt) or marks the job dead once attempts are exhausted. */
async function failJob(pool: pg.Pool, job: JobRow, message: string, maxAttempts: number): Promise<void> {
  await pool.query(
    `UPDATE jobs
        SET status = CASE WHEN attempts >= $2 THEN 'dead' ELSE 'queued' END,
            run_at = now() + make_interval(secs => attempts * 30),
            locked_at = NULL,
            last_error = $3
      WHERE id = $1::bigint`,
    [job.id, maxAttempts, message.slice(0, 2000)],
  );
}

async function processJob(opts: ConsumerOptions, job: JobRow): Promise<void> {
  const handler = opts.handlers[job.type];
  try {
    if (!handler) throw new Error(`no handler registered for job type ${job.type}`);
    await handler(job);
    await completeJob(opts.pool, job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error(JSON.stringify({ level: 'error', msg: 'job failed', jobId: job.id, type: job.type, error: message }));
    await failJob(opts.pool, job, message, opts.maxAttempts);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Starts a polling loop. Each iteration claims at most one job and processes it to completion. */
export function startConsumer(opts: ConsumerOptions): Consumer {
  let running = true;
  const loop = (async () => {
    while (running) {
      const job = await claimNextJob(opts.pool);
      if (!job) {
        await sleep(opts.pollIntervalMs);
        continue;
      }
      await processJob(opts, job);
    }
  })().catch((err: unknown) => {
    console.error(JSON.stringify({ level: 'error', msg: 'consumer loop stopped', error: String(err) }));
  });
  return {
    async stop() {
      running = false;
      await loop;
    },
  };
}
