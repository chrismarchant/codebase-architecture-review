import { z } from 'zod';
import { ElementSegment, IsoDateTime, Sha1Hex, Sha256Hex, Uuid } from './common.js';

// ---------------------------------------------------------------------------
// Budgets (SS00 §9). Service maxima are enforced separately (BUDGET_CEILING_*).
// ---------------------------------------------------------------------------
export const AnalysisBudgets = z.object({
  maxFiles: z.number().int().positive().default(20_000),
  maxBytes: z.number().int().positive().default(200 * 1024 * 1024),
  maxFileBytes: z.number().int().positive().default(1024 * 1024),
  maxReadBytesTotal: z.number().int().positive().default(40 * 1024 * 1024),
  maxReadBytesPerCall: z.number().int().positive().default(256 * 1024),
  maxTurns: z.number().int().positive().default(400),
  maxBudgetUsd: z.number().positive().default(5),
  maxTimeSeconds: z.number().int().positive().default(2_700),
  maxDepth: z.number().int().min(1).max(8).default(4),
  maxElements: z.number().int().positive().default(300),
});
export type AnalysisBudgets = z.infer<typeof AnalysisBudgets>;
export const DEFAULT_BUDGETS: AnalysisBudgets = AnalysisBudgets.parse({});

// ---------------------------------------------------------------------------
// Scan request (POST /v1/scans body)
// ---------------------------------------------------------------------------
export const RepositoryRef = z.object({
  /** https://github.com/{owner}/{repo}(.git) or an allow-listed https Git remote */
  url: z.string().url().max(512),
  /** branch, tag or any ref understood by the provider; ignored when sha is given */
  ref: z.string().min(1).max(256).optional(),
  /** full 40-hex commit SHA; when present the resolved SHA MUST equal it */
  sha: Sha1Hex.optional(),
  /** per-request retrieval token; encrypted at rest, deleted after retrieval */
  token: z.string().min(1).max(4096).optional(),
});
export type RepositoryRef = z.infer<typeof RepositoryRef>;

export const ScanOptions = z.object({
  /** restrict to these upstream perspectives; default lets the agent choose from the catalogue */
  perspectives: z.array(ElementSegment).max(12).optional(),
  /** content language for field text (ISO 639-1); ids are always English kebab-case */
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default('en'),
  budgets: AnalysisBudgets.partial().optional(),
  /** when true, an existing succeeded scan of the same (principal, url, sha, optionsHash) is returned */
  reuseExisting: z.boolean().default(false),
});
export type ScanOptions = z.infer<typeof ScanOptions>;

export const ScanRequest = z.object({
  repository: RepositoryRef,
  options: ScanOptions.prefault({}),
  labels: z.record(z.string().max(64), z.string().max(256)).optional(),
});
export type ScanRequest = z.infer<typeof ScanRequest>;

// ---------------------------------------------------------------------------
// Scan state (GET /v1/scans/:id)
// ---------------------------------------------------------------------------
export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;
export const JobOutcome = z.enum(['complete', 'partial']);
export type JobOutcome = z.infer<typeof JobOutcome>;
export const Stage = z.enum(['authorize', 'retrieve', 'inventory', 'analyze', 'validate', 'publish', 'cleanup']);
export type Stage = z.infer<typeof Stage>;
export const STAGE_ORDER: readonly Stage[] = Stage.options;

export const PerspectiveState = z.enum(['pending', 'running', 'done', 'skipped_budget', 'skipped_cancel', 'failed']);

export const Progress = z.object({
  stage: Stage,
  stageStartedAt: IsoDateTime,
  percent: z.number().min(0).max(100).optional(),
  message: z.string().max(512),
  perspectives: z.record(z.string(), PerspectiveState).default({}),
});
export type Progress = z.infer<typeof Progress>;

export const Failure = z.object({
  code: z.string(),
  message: z.string().max(2048),
  stage: Stage.optional(),
  retryable: z.boolean(),
  at: IsoDateTime,
});
export type Failure = z.infer<typeof Failure>;

/** Provider usage as reported by the runtime. Always an estimate unless `estimatedBy` says otherwise. */
export const ModelUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative().default(0),
  cacheCreationInputTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().optional(),
});
export const ProviderUsage = z.object({
  runtime: z.string(),
  estimatedBy: z.string(),
  totalCostUsd: z.number().nonnegative().optional(),
  turns: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  apiDurationMs: z.number().int().nonnegative().optional(),
  byModel: z.record(z.string(), ModelUsage).default({}),
});
export type ProviderUsage = z.infer<typeof ProviderUsage>;

export const Checkpoint = z.object({
  stage: Stage,
  commitSha: Sha1Hex.optional(),
  snapshotSha256: Sha256Hex.optional(),
  perspectivesCompleted: z.array(ElementSegment).default([]),
  /** object key prefix of the attempt that wrote the checkpointed artifacts */
  attemptPrefix: z.string().optional(),
  updatedAt: IsoDateTime,
});
export type Checkpoint = z.infer<typeof Checkpoint>;

export const ArtifactIndexEntry = z.object({
  path: z.string(),
  schema: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  sha256: Sha256Hex,
  href: z.string(),
});

export const Scan = z.object({
  id: Uuid,
  principalId: Uuid,
  status: JobStatus,
  outcome: JobOutcome.nullable(),
  cancelRequested: z.boolean(),
  repository: z.object({ url: z.string(), ref: z.string().nullable(), commitSha: Sha1Hex.nullable() }),
  options: ScanOptions,
  labels: z.record(z.string(), z.string()).nullable(),
  budgets: AnalysisBudgets,
  stage: Stage.nullable(),
  progress: Progress.nullable(),
  usage: ProviderUsage.nullable(),
  failure: Failure.nullable(),
  attempt: z.number().int().nonnegative(),
  queuePosition: z.number().int().nonnegative().nullable(),
  manifestSha256: Sha256Hex.nullable(),
  artifacts: z.array(ArtifactIndexEntry).nullable(),
  links: z.object({
    self: z.string(),
    events: z.string(),
    artifacts: z.string().nullable(),
    architecture: z.string().nullable(),
    viewer: z.string().nullable(),
    studioExport: z.string().nullable(),
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
});
export type Scan = z.infer<typeof Scan>;

export const JobEvent = z.object({
  seq: z.number().int().nonnegative(),
  at: IsoDateTime,
  level: z.enum(['debug', 'info', 'warn', 'error']),
  stage: Stage.nullable(),
  code: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JobEvent = z.infer<typeof JobEvent>;

export const ScanList = z.object({
  items: z.array(Scan),
  nextCursor: z.string().nullable(),
});

export const CancelResponse = z.object({ id: Uuid, status: JobStatus, cancelRequested: z.boolean() });

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------
export const ComparisonRequest = z.object({ baseScanId: Uuid, headScanId: Uuid });
export type ComparisonRequest = z.infer<typeof ComparisonRequest>;

export const ComparisonRecord = z.object({
  id: Uuid,
  principalId: Uuid,
  baseScanId: Uuid,
  headScanId: Uuid,
  status: z.enum(['ready', 'failed']),
  createdAt: IsoDateTime,
  links: z.object({ self: z.string(), result: z.string() }),
});
export type ComparisonRecord = z.infer<typeof ComparisonRecord>;

// ---------------------------------------------------------------------------
// Runner wake (POST /internal/wake)
// ---------------------------------------------------------------------------
export const WakeRequest = z.object({
  scanId: Uuid.optional(),
  nonce: z.string().min(16).max(64),
  ts: z.number().int(),
});
export type WakeRequest = z.infer<typeof WakeRequest>;
