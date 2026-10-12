import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Failure, Progress, ScanRequest } from '@archreview/contracts';
import { DEFAULT_BUDGETS } from '@archreview/contracts';
import type { Db } from '../../src/db/index.js';
import { IdempotencyConflict, InvalidCursorError, PgJobStore } from '../../src/jobs/index.js';
import type { CreateJobInput, Fenced } from '../../src/jobs/index.js';
import { createTestDb } from '../../src/testing/index.js';

let db: Db;
let store: PgJobStore;
let principal: string;

async function addPrincipal(): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO principals (id, name) VALUES ($1, 'p')`, [id]);
  return id;
}

function request(url = 'https://github.com/o/r', token?: string): ScanRequest {
  return {
    repository: { url, ...(token ? { token } : {}) },
    options: { language: 'en', reuseExisting: false },
  };
}

function input(over: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    id: randomUUID(),
    principalId: principal,
    request: request(),
    optionsHash: 'h1',
    retrievalSecret: null,
    budgets: DEFAULT_BUDGETS,
    maxAttempts: 3,
    idempotencyKey: null,
    ...over,
  };
}

const progress = (stage: Progress['stage'] = 'retrieve'): Progress => ({
  stage,
  stageStartedAt: new Date().toISOString(),
  message: 'working',
  perspectives: {},
});

const failure = (retryable: boolean): Failure => ({
  code: 'boom',
  message: 'it broke',
  stage: 'analyze',
  retryable,
  at: new Date().toISOString(),
});

const expireLease = (id: string) =>
  db.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
const fenceOf = (j: { id: string; fenceToken: number }): Fenced => ({ jobId: j.id, fenceToken: j.fenceToken });

// One migrated PGlite instance per file (startup dominates runtime); tables are emptied between tests.
beforeAll(async () => {
  db = await createTestDb();
  store = new PgJobStore(db);
});
beforeEach(async () => {
  await db.query('TRUNCATE wake_log, scan_grants, job_events, comparisons, jobs, principals CASCADE');
  principal = await addPrincipal();
});
afterAll(async () => {
  await db.close();
});

describe('create / read', () => {
  it('creates a queued job, maps columns and never persists the token', async () => {
    const secret = new Uint8Array([1, 2, 3]);
    const created = await store.create(input({ request: request('https://github.com/o/r', 'ghp_secret'), retrievalSecret: secret }));
    expect(created.status).toBe('queued');
    expect(created.attempt).toBe(0);
    expect(created.fenceToken).toBe(0);
    expect(created.repoUrl).toBe('https://github.com/o/r');
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.budgets).toEqual(DEFAULT_BUDGETS);
    expect(created.request.repository).not.toHaveProperty('token');
    expect(JSON.stringify(created)).not.toContain('ghp_secret');
    expect(created).not.toHaveProperty('retrievalSecret');

    const fetched = await store.get(created.id);
    expect(fetched).toEqual(created);
    expect(await store.get(randomUUID())).toBeNull();
  });

  it('surfaces a duplicate idempotency key as IdempotencyConflict and finds the original', async () => {
    const a = await store.create(input({ idempotencyKey: 'k1' }));
    await expect(store.create(input({ idempotencyKey: 'k1' }))).rejects.toBeInstanceOf(IdempotencyConflict);
    expect((await store.findByIdempotencyKey(principal, 'k1'))?.id).toBe(a.id);
    expect(await store.findByIdempotencyKey(principal, 'other')).toBeNull();

    // Same key for another principal, and null keys, never conflict.
    const other = await addPrincipal();
    await store.create(input({ principalId: other, idempotencyKey: 'k1' }));
    await store.create(input());
    await store.create(input());
  });

  it('does not wrap other constraint violations', async () => {
    const id = randomUUID();
    await store.create(input({ id }));
    const err = await store.create(input({ id })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(IdempotencyConflict);
  });

  it('getForPrincipal honours ownership and grants', async () => {
    const job = await store.create(input());
    const stranger = await addPrincipal();
    expect((await store.getForPrincipal(job.id, principal))?.id).toBe(job.id);
    expect(await store.getForPrincipal(job.id, stranger)).toBeNull();
    await db.query('INSERT INTO scan_grants (job_id, principal_id) VALUES ($1, $2)', [job.id, stranger]);
    expect((await store.getForPrincipal(job.id, stranger))?.id).toBe(job.id);
  });

  it('findReusable returns the most recent succeeded job for the exact tuple', async () => {
    const sha = 'a'.repeat(40);
    const make = async (hash: string) => {
      const j = await store.create(input({ optionsHash: hash }));
      const [c] = await store.claim('w', 1, 60_000);
      expect(c?.id).toBe(j.id);
      await store.setCommit(fenceOf(c!), sha);
      await store.publish(fenceOf(c!), 'complete', 'f'.repeat(64));
      return j;
    };
    const first = await make('h1');
    const second = await make('h1');
    await make('h2');
    const found = await store.findReusable(principal, 'https://github.com/o/r', sha, 'h1');
    expect(found?.id).toBe(second.id);
    expect(found?.commitSha).toBe(sha);
    expect(found?.id).not.toBe(first.id);
    expect(await store.findReusable(principal, 'https://github.com/o/r', sha, 'nope')).toBeNull();
    expect(await store.findReusable(principal, 'https://github.com/o/other', sha, 'h1')).toBeNull();
  });
});

describe('claim, lease and fencing', () => {
  it('claims with fence 1, refuses a live lease, re-claims an expired one with fence 2 / attempt 2', async () => {
    const job = await store.create(input());
    const [first, ...rest] = await store.claim('w1', 5, 60_000);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ id: job.id, status: 'running', fenceToken: 1, attempt: 1, leaseOwner: 'w1' });
    expect(first!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(first!.startedAt).toBeInstanceOf(Date);

    expect(await store.claim('w2', 5, 60_000)).toEqual([]);

    await expireLease(job.id);
    const [second] = await store.claim('w2', 5, 60_000);
    expect(second).toMatchObject({ id: job.id, fenceToken: 2, attempt: 2, leaseOwner: 'w2' });
    expect(second!.startedAt!.getTime()).toBe(first!.startedAt!.getTime());
  });

  it('rejects every write from the fenced-out worker and accepts the new holder', async () => {
    await store.create(input());
    const [old] = await store.claim('w1', 1, 60_000);
    await expireLease(old!.id);
    const [cur] = await store.claim('w2', 1, 60_000);
    const stale = fenceOf(old!);
    const fresh = fenceOf(cur!);

    expect(await store.heartbeat(stale, 'w1', 60_000)).toBe(false);
    expect(await store.setStage(stale, 'analyze', progress('analyze'))).toBe(false);
    expect(await store.setProgress(stale, progress())).toBe(false);
    expect(await store.setCommit(stale, 'b'.repeat(40))).toBe(false);
    expect(await store.setCheckpoint(stale, { stage: 'retrieve', perspectivesCompleted: [], updatedAt: new Date().toISOString() })).toBe(false);
    expect(await store.setUsage(stale, { runtime: 'mock', estimatedBy: 'mock', turns: 1, durationMs: 1, byModel: {} })).toBe(false);
    expect(await store.clearRetrievalSecret(stale)).toBe(false);
    expect(await store.readRetrievalSecret(stale)).toBeNull();
    expect(await store.releaseLease(stale)).toBe(false);
    expect(await store.markCancelled(stale)).toBe(false);
    expect(await store.fail(stale, failure(false), 1000)).toBe('fenced');
    expect(await store.publish(stale, 'complete', 'f'.repeat(64))).toBe(false);

    // Wrong owner with the right fence also fails the heartbeat.
    expect(await store.heartbeat(fresh, 'w1', 60_000)).toBe(false);
    expect(await store.heartbeat(fresh, 'w2', 60_000)).toBe(true);
    expect(await store.setStage(fresh, 'analyze', progress('analyze'))).toBe(true);
    expect(await store.setCommit(fresh, 'b'.repeat(40))).toBe(true);
    const cp = { stage: 'analyze' as const, perspectivesCompleted: ['security'], updatedAt: new Date().toISOString() };
    expect(await store.setCheckpoint(fresh, cp)).toBe(true);
    expect(await store.setUsage(fresh, { runtime: 'mock', estimatedBy: 'mock', turns: 2, durationMs: 5, byModel: {} })).toBe(true);

    const row = await store.get(cur!.id);
    expect(row).toMatchObject({ stage: 'analyze', commitSha: 'b'.repeat(40), checkpoint: cp });
    expect(row?.usage?.turns).toBe(2);
    expect(row?.progress?.message).toBe('working');

    // Publication: exactly one attempt wins and records the fence as published_attempt.
    expect(await store.publish(fresh, 'partial', 'c'.repeat(64))).toBe(true);
    expect(await store.publish(fresh, 'complete', 'd'.repeat(64))).toBe(false);
    expect(await store.publish(stale, 'complete', 'd'.repeat(64))).toBe(false);
    const done = await store.get(cur!.id);
    expect(done).toMatchObject({
      status: 'succeeded',
      outcome: 'partial',
      publishedAttempt: 2,
      manifestSha256: 'c'.repeat(64),
    });
    expect(done!.finishedAt).toBeInstanceOf(Date);
    // A published job can no longer be claimed, failed or cancelled.
    expect(await store.fail(fresh, failure(false), 0)).toBe('fenced');
    expect(await store.markCancelled(fresh)).toBe(false);
    expect(await store.claim('w3', 5, 60_000)).toEqual([]);
    // Stage 7 cleanup can still write after publication and then release the lease.
    expect(await store.setStage(fresh, 'cleanup', progress('cleanup'))).toBe(true);
    expect(await store.releaseLease(fresh)).toBe(true);
    expect((await store.get(cur!.id))?.leaseOwner).toBeNull();
  });

  it('stops a zombie worker from writing after the reconciler requeued the job', async () => {
    const job = await store.create(input());
    const [c] = await store.claim('w1', 1, 60_000);
    await expireLease(job.id);
    expect(await store.requeueOrFailExpired(job.id, c!.fenceToken, 0)).toBe('requeued');
    expect(await store.setStage(fenceOf(c!), 'analyze', progress('analyze'))).toBe(false);
    expect(await store.publish(fenceOf(c!), 'complete', 'f'.repeat(64))).toBe(false);
  });

  it('claims in created_at order up to the slot limit and honours not_before', async () => {
    const a = await store.create(input());
    const b = await store.create(input());
    const c = await store.create(input());
    await db.query(`UPDATE jobs SET created_at = now() - interval '3 minute' WHERE id = $1`, [b.id]);
    await db.query(`UPDATE jobs SET created_at = now() - interval '2 minute' WHERE id = $1`, [a.id]);
    await db.query(`UPDATE jobs SET not_before = now() + interval '1 hour' WHERE id = $1`, [c.id]);

    expect(await store.claim('w', 0, 1000)).toEqual([]);
    const claimed = await store.claim('w', 5, 60_000);
    expect(claimed.map((j) => j.id)).toEqual([b.id, a.id]); // c is deferred
    expect((await store.get(c.id))?.status).toBe('queued');
  });

  it('does not claim an expired job that exhausted its attempts', async () => {
    const job = await store.create(input({ maxAttempts: 1 }));
    await store.claim('w1', 1, 60_000);
    await expireLease(job.id);
    expect(await store.claim('w2', 1, 60_000)).toEqual([]);
    expect(await store.requeueOrFailExpired(job.id, 1, 0)).toBe('failed');
    const row = await store.get(job.id);
    expect(row).toMatchObject({ status: 'failed', failure: { code: 'max_attempts', retryable: false } });
    expect(row?.failure?.stage).toBeUndefined();
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it('releaseLease makes a running job claimable immediately', async () => {
    await store.create(input());
    const [c] = await store.claim('w1', 1, 60_000);
    expect(await store.releaseLease(fenceOf(c!))).toBe(true);
    const [again] = await store.claim('w2', 1, 60_000);
    expect(again).toMatchObject({ fenceToken: 2, attempt: 2 });
  });
});

describe('fail', () => {
  it('requeues retryable failures with backoff until max_attempts, then fails', async () => {
    const job = await store.create(input({ maxAttempts: 2 }));
    const [c1] = await store.claim('w', 1, 60_000);
    expect(await store.fail(fenceOf(c1!), failure(true), 60_000)).toBe('requeued');
    const queued = await store.get(job.id);
    expect(queued).toMatchObject({ status: 'queued', leaseOwner: null, leaseExpiresAt: null, attempt: 1 });
    expect(queued!.notBefore!.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(await store.claim('w', 1, 60_000)).toEqual([]); // backing off
    expect(await store.heartbeat(fenceOf(c1!), 'w', 1000)).toBe(false);

    await db.query('UPDATE jobs SET not_before = now() - interval \'1 second\' WHERE id = $1', [job.id]);
    const [c2] = await store.claim('w', 1, 60_000);
    expect(c2).toMatchObject({ fenceToken: 2, attempt: 2 });
    expect(await store.fail(fenceOf(c2!), failure(true), 0)).toBe('failed'); // attempt == max
    const failed = await store.get(job.id);
    expect(failed).toMatchObject({ status: 'failed', failure: { code: 'boom', retryable: true } });
    expect(failed!.finishedAt).toBeInstanceOf(Date);
  });

  it('fails immediately when not retryable and wipes the retrieval secret', async () => {
    const job = await store.create(input({ retrievalSecret: new Uint8Array([9, 9]) }));
    const [c] = await store.claim('w', 1, 60_000);
    expect(Array.from((await store.readRetrievalSecret(fenceOf(c!)))!)).toEqual([9, 9]);
    expect(await store.fail(fenceOf(c!), failure(false), 0)).toBe('failed');
    expect(await store.readRetrievalSecret(fenceOf(c!))).toBeNull();
    expect((await store.get(job.id))?.status).toBe('failed');
  });

  it('clearRetrievalSecret nulls the column', async () => {
    await store.create(input({ retrievalSecret: new Uint8Array([1]) }));
    const [c] = await store.claim('w', 1, 60_000);
    expect(await store.clearRetrievalSecret(fenceOf(c!))).toBe(true);
    expect(await store.readRetrievalSecret(fenceOf(c!))).toBeNull();
  });
});

describe('cancel', () => {
  it('cancels queued jobs immediately, flags running jobs, and leaves terminal jobs unchanged', async () => {
    const queued = await store.create(input({ retrievalSecret: new Uint8Array([1]) }));
    const cancelled = await store.requestCancel(queued.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelRequested: true });
    expect(cancelled!.finishedAt).toBeInstanceOf(Date);
    const secret = await db.query('SELECT retrieval_secret FROM jobs WHERE id = $1', [queued.id]);
    expect(secret.rows[0]).toEqual({ retrieval_secret: null });
    expect(await store.claim('w', 5, 1000)).toEqual([]);

    const running = await store.create(input());
    const [c] = await store.claim('w', 1, 60_000);
    expect(await store.isCancelRequested(running.id)).toBe(false);
    const flagged = await store.requestCancel(running.id);
    expect(flagged).toMatchObject({ status: 'running', cancelRequested: true });
    expect(await store.isCancelRequested(running.id)).toBe(true);
    expect(await store.markCancelled(fenceOf(c!))).toBe(true);
    const done = await store.get(running.id);
    expect(done).toMatchObject({ status: 'cancelled' });
    expect(done!.finishedAt).toBeInstanceOf(Date);

    const again = await store.requestCancel(running.id);
    expect(again).toEqual(done);

    const ok = await store.create(input());
    const [d] = await store.claim('w', 1, 60_000);
    await store.publish(fenceOf(d!), 'complete', 'f'.repeat(64));
    const unchanged = await store.requestCancel(ok.id);
    expect(unchanged).toMatchObject({ status: 'succeeded', cancelRequested: false });

    expect(await store.requestCancel(randomUUID())).toBeNull();
    expect(await store.isCancelRequested(randomUUID())).toBe(false);
  });
});

describe('events', () => {
  it('assigns increasing seq per job, supports afterSeq/limit and preserves data', async () => {
    const a = await store.create(input());
    const b = await store.create(input());
    await store.appendEvent(a.id, { level: 'info', stage: 'retrieve', code: 'c1', message: 'm1', data: { n: 1 } });
    await store.appendEvent(a.id, { level: 'warn', stage: null, code: 'c2', message: 'm2' });
    await store.appendEvent(b.id, { level: 'error', stage: 'analyze', code: 'c3', message: 'm3' });
    await Promise.all([1, 2, 3].map((i) => store.appendEvent(a.id, { level: 'info', stage: null, code: `p${i}`, message: 'parallel' })));

    const all = await store.listEvents(a.id);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all[0]).toMatchObject({ level: 'info', stage: 'retrieve', code: 'c1', data: { n: 1 } });
    expect(all[1]).not.toHaveProperty('data');
    expect(typeof all[0]!.at).toBe('string');
    expect((await store.listEvents(a.id, 2, 2)).map((e) => e.seq)).toEqual([3, 4]);
    expect((await store.listEvents(b.id)).map((e) => e.seq)).toEqual([1]);
    expect(await store.listEvents(randomUUID())).toEqual([]);
  });
});

describe('list and queuePosition', () => {
  it('paginates newest first with a stable keyset cursor, including identical timestamps', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await store.create(input())).id);
    // Force a created_at tie between the two newest rows; id breaks the tie.
    await db.query(
      `UPDATE jobs SET created_at = (SELECT created_at FROM jobs WHERE id = $1) WHERE id = $2`,
      [ids[3], ids[4]],
    );
    const other = await addPrincipal();
    await store.create(input({ principalId: other }));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<PgJobStore['list']>> = await store.list(principal, { limit: 2, cursor });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((j) => j.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual([...ids].sort());

    const full = await store.list(principal, { limit: 50 });
    expect(full.nextCursor).toBeNull();
    expect(full.items).toHaveLength(5);
    const times = full.items.map((j) => j.createdAt.getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it('rejects malformed cursors', async () => {
    await expect(store.list(principal, { limit: 5, cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(InvalidCursorError);
    const evil = Buffer.from(JSON.stringify(["2020-01-01'; DROP TABLE jobs;--", 'x'])).toString('base64url');
    await expect(store.list(principal, { limit: 5, cursor: evil })).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('queuePosition counts earlier queued jobs and is null otherwise', async () => {
    const a = await store.create(input());
    const b = await store.create(input());
    const c = await store.create(input());
    await db.query(`UPDATE jobs SET created_at = now() - interval '3 minute' WHERE id = $1`, [a.id]);
    await db.query(`UPDATE jobs SET created_at = now() - interval '2 minute' WHERE id = $1`, [b.id]);
    expect(await store.queuePosition(a.id)).toBe(0);
    expect(await store.queuePosition(b.id)).toBe(1);
    expect(await store.queuePosition(c.id)).toBe(2);
    const [claimed] = await store.claim('w', 1, 60_000);
    expect(claimed!.id).toBe(a.id);
    expect(await store.queuePosition(a.id)).toBeNull();
    expect(await store.queuePosition(b.id)).toBe(0);
    expect(await store.queuePosition(randomUUID())).toBeNull();
  });
});

describe('reconciler queries', () => {
  it('listNeedingWake: never woken or last attempt older than the threshold, queued and due, bounded', async () => {
    const a = await store.create(input());
    const b = await store.create(input());
    const c = await store.create(input());
    const deferred = await store.create(input());
    await db.query(`UPDATE jobs SET not_before = now() + interval '1 hour' WHERE id = $1`, [deferred.id]);
    await db.query(`UPDATE jobs SET created_at = now() - interval '4 minute' WHERE id = $1`, [a.id]);
    await db.query(`UPDATE jobs SET created_at = now() - interval '3 minute' WHERE id = $1`, [b.id]);
    await db.query(`UPDATE jobs SET created_at = now() - interval '2 minute' WHERE id = $1`, [c.id]);

    await store.recordWake(b.id, true, 202, null); // just woken
    await store.recordWake(c.id, false, 502, 'bad gateway');
    await db.query(`UPDATE wake_log SET attempted_at = now() - interval '5 minute' WHERE job_id = $1`, [c.id]);
    await store.recordWake(null, true, 202, null); // global wake does not count for a job

    const needing = await store.listNeedingWake(60_000, 10);
    expect(needing.map((j) => j.id)).toEqual([a.id, c.id]);
    expect((await store.listNeedingWake(60_000, 1)).map((j) => j.id)).toEqual([a.id]);

    const [claimed] = await store.claim('w', 1, 60_000);
    expect(claimed!.id).toBe(a.id);
    expect((await store.listNeedingWake(60_000, 10)).map((j) => j.id)).toEqual([c.id]); // running is not queued

    const log = await db.query('SELECT ok, status, error FROM wake_log WHERE job_id = $1', [c.id]);
    expect(log.rows).toEqual([{ ok: false, status: 502, error: 'bad gateway' }]);
  });

  it('listExpiredLeases returns running jobs expired longer than the grace period, bounded', async () => {
    const jobs = [];
    for (let i = 0; i < 3; i++) jobs.push(await store.create(input()));
    await store.claim('w', 3, 60_000);
    await db.query(`UPDATE jobs SET lease_expires_at = now() - interval '10 minute' WHERE id = $1`, [jobs[0]!.id]);
    await db.query(`UPDATE jobs SET lease_expires_at = now() - interval '5 minute' WHERE id = $1`, [jobs[1]!.id]);
    // jobs[2] still holds a live lease.

    expect((await store.listExpiredLeases(60_000, 10)).map((j) => j.id)).toEqual([jobs[0]!.id, jobs[1]!.id]);
    expect((await store.listExpiredLeases(7 * 60_000, 10)).map((j) => j.id)).toEqual([jobs[0]!.id]);
    expect(await store.listExpiredLeases(60_000, 1)).toHaveLength(1);
  });

  it('requeueOrFailExpired only acts on the expected fence of an expired running job', async () => {
    const job = await store.create(input());
    const [c] = await store.claim('w', 1, 60_000);
    expect(await store.requeueOrFailExpired(job.id, c!.fenceToken, 0)).toBe('skipped'); // lease still live
    await expireLease(job.id);
    expect(await store.requeueOrFailExpired(job.id, c!.fenceToken + 1, 0)).toBe('skipped'); // wrong fence
    expect(await store.requeueOrFailExpired(job.id, c!.fenceToken, 30_000)).toBe('requeued');
    const row = await store.get(job.id);
    expect(row).toMatchObject({ status: 'queued', leaseOwner: null, leaseExpiresAt: null });
    expect(row!.notBefore!.getTime()).toBeGreaterThan(Date.now());
    expect(await store.requeueOrFailExpired(job.id, c!.fenceToken, 0)).toBe('skipped'); // no longer running
    expect(await store.requeueOrFailExpired(randomUUID(), 1, 0)).toBe('skipped');
  });
});
