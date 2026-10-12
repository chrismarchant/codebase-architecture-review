/**
 * Job store interface (SS00 §3, §7). Implemented over the Db abstraction in ./pg-job-store.ts.
 * All worker-side mutations carry a fence token and MUST return `false` when the
 * caller has been fenced out (zero rows updated).
 */
import type {
  AnalysisBudgets,
  Checkpoint,
  Failure,
  JobEvent,
  JobOutcome,
  JobStatus,
  Progress,
  ProviderUsage,
  ScanRequest,
  Stage,
} from '@archreview/contracts';

export interface JobRow {
  id: string;
  principalId: string;
  status: JobStatus;
  outcome: JobOutcome | null;
  cancelRequested: boolean;
  request: ScanRequest; // token removed
  optionsHash: string;
  repoUrl: string;
  repoRef: string | null;
  commitSha: string | null;
  stage: Stage | null;
  progress: Progress | null;
  checkpoint: Checkpoint | null;
  budgets: AnalysisBudgets;
  usage: ProviderUsage | null;
  failure: Failure | null;
  attempt: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  fenceToken: number;
  publishedAttempt: number | null;
  manifestSha256: string | null;
  idempotencyKey: string | null;
  notBefore: Date | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface CreateJobInput {
  id: string;
  principalId: string;
  request: ScanRequest; // token already stripped
  optionsHash: string;
  retrievalSecret: Uint8Array | null; // encrypted token or null
  budgets: AnalysisBudgets;
  maxAttempts: number;
  idempotencyKey: string | null;
}

export interface ClaimedJob extends JobRow {
  fenceToken: number; // the token this worker must present on every write
}

export interface Fenced {
  jobId: string;
  fenceToken: number;
}

export interface JobStore {
  // --- API side -----------------------------------------------------------
  create(input: CreateJobInput): Promise<JobRow>;
  /** Returns the existing job for (principal, idempotencyKey) or null. */
  findByIdempotencyKey(principalId: string, key: string): Promise<JobRow | null>;
  /** Most recent succeeded job for reuseExisting lookups. */
  findReusable(principalId: string, repoUrl: string, commitSha: string, optionsHash: string): Promise<JobRow | null>;
  get(id: string): Promise<JobRow | null>;
  /** Visible to principal if owner or granted. */
  getForPrincipal(id: string, principalId: string): Promise<JobRow | null>;
  list(principalId: string, opts: { limit: number; cursor?: string | null }): Promise<{ items: JobRow[]; nextCursor: string | null }>;
  /** Position in the queue (0 = next). Null when not queued. */
  queuePosition(id: string): Promise<number | null>;
  requestCancel(id: string): Promise<JobRow | null>;
  listEvents(id: string, afterSeq?: number, limit?: number): Promise<JobEvent[]>;
  /** Jobs needing a wake: queued and (never woken or older than `olderThanMs`). Bounded. */
  listNeedingWake(olderThanMs: number, limit: number): Promise<JobRow[]>;
  /** Running jobs whose lease expired more than `graceMs` ago. Bounded. */
  listExpiredLeases(graceMs: number, limit: number): Promise<JobRow[]>;
  /** Reconciler: requeue (attempt < max) or fail an expired job. Ignores jobs touched meanwhile. */
  requeueOrFailExpired(id: string, expectedFence: number, backoffMs: number): Promise<'requeued' | 'failed' | 'skipped'>;
  recordWake(jobId: string | null, ok: boolean, status: number | null, error: string | null): Promise<void>;

  // --- Runner side ----------------------------------------------------------
  /**
   * Atomically claims up to `slots` jobs for `workerId`: queued (and not_before passed)
   * or running with an expired lease. Increments fence_token and attempt.
   */
  claim(workerId: string, slots: number, leaseTtlMs: number): Promise<ClaimedJob[]>;
  /** Extends the lease. false => fenced out; the caller MUST stop. */
  heartbeat(f: Fenced, workerId: string, leaseTtlMs: number): Promise<boolean>;
  /** Reads cancel flag cheaply. */
  isCancelRequested(jobId: string): Promise<boolean>;
  /** Reads the encrypted retrieval secret; the caller decrypts and MUST call clearRetrievalSecret after retrieve. */
  readRetrievalSecret(f: Fenced): Promise<Uint8Array | null>;
  clearRetrievalSecret(f: Fenced): Promise<boolean>;
  setStage(f: Fenced, stage: Stage, progress: Progress): Promise<boolean>;
  setProgress(f: Fenced, progress: Progress): Promise<boolean>;
  setCommit(f: Fenced, commitSha: string): Promise<boolean>;
  setCheckpoint(f: Fenced, checkpoint: Checkpoint): Promise<boolean>;
  setUsage(f: Fenced, usage: ProviderUsage): Promise<boolean>;
  appendEvent(jobId: string, evt: Omit<JobEvent, 'seq' | 'at'>): Promise<void>;
  /**
   * Publication: exactly one attempt wins. Sets status=succeeded, outcome,
   * published_attempt=fenceToken, manifest_sha256, finished_at. false => fenced out or not running.
   */
  publish(f: Fenced, outcome: JobOutcome, manifestSha256: string): Promise<boolean>;
  /** Terminal failure. If retryable and attempt < max, the job returns to queued with not_before. */
  fail(f: Fenced, failure: Failure, backoffMs: number): Promise<'failed' | 'requeued' | 'fenced'>;
  markCancelled(f: Fenced): Promise<boolean>;
  /** Releases the lease early (SIGTERM). The job stays running until re-claimed. */
  releaseLease(f: Fenced): Promise<boolean>;
}
