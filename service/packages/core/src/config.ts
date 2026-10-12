/**
 * Environment configuration (single source for both apps). Every variable is
 * documented in docs/ENV-TEMPLATE.md. Secrets are never logged; `describe()`
 * returns a redacted view for startup logs.
 */
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true');
const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseFloat(v)))
    .pipe(z.number());

export const CommonEnv = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: int(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SERVICE_VERSION: z.string().default('0.1.0'),
  SERVICE_GIT_SHA: z.string().optional(),

  // Database (ADR-006)
  DATABASE_URL: z.string().optional(), // required in production; tests use PGlite
  DB_POOL_MAX: int(3),
  DB_IDLE_TIMEOUT_MS: int(10_000),
  DB_CONNECT_TIMEOUT_MS: int(10_000),

  // Artifact storage (ADR-005). ARTIFACT_STORE=fs for local/dev, s3 for Railway Buckets.
  ARTIFACT_STORE: z.enum(['s3', 'fs']).default('s3'),
  ARTIFACT_FS_ROOT: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,

  // Shared secrets
  WAKE_SHARED_SECRET: z.string().optional(), // HMAC key for /internal/wake
  RETRIEVAL_KEK: z.string().optional(), // base64 32 bytes; encrypts per-request tokens at rest

  // Upstream location override (ADR-002)
  ARCHREVIEW_UPSTREAM_ROOT: z.string().optional(),

  // Shutdown
  SHUTDOWN_GRACE_MS: int(25_000),
});

export const ApiEnv = CommonEnv.extend({
  PUBLIC_BASE_URL: z.string().optional(),
  RUNNER_INTERNAL_URL: z.string().optional(), // e.g. http://runner.railway.internal:3001
  AUTH_BOOTSTRAP_KEYS: z.string().optional(), // "name:ar_xxx;name2:ar_yyy" created on first start
  SESSION_TTL_HOURS: int(12),
  RATE_LIMIT_PER_MINUTE: int(60),
  WAKE_RETRY_DELAYS_MS: z.string().default('1000,3000,9000'),
  RECONCILE_MIN_INTERVAL_MS: int(60_000),
  RECONCILE_MAX_INTERVAL_MS: int(900_000),
  RECONCILE_BATCH: int(50),
  LEASE_TTL_MS: int(120_000),
  RETENTION_DAYS: int(90),
  RETENTION_BATCH: int(200),
  BUDGET_CEILING_MAX_BUDGET_USD: num(20),
  BUDGET_CEILING_MAX_TIME_SECONDS: int(5_400),
  BUDGET_CEILING_MAX_TURNS: int(1_000),
  BUDGET_CEILING_MAX_BYTES: int(500 * 1024 * 1024),
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v !== '0' && v !== 'false'),
});
export type ApiEnv = z.infer<typeof ApiEnv>;

export const RunnerEnv = CommonEnv.extend({
  RUNNER_WORKER_ID: z.string().optional(), // default: hostname + pid
  RUNNER_MAX_CONCURRENCY: int(1),
  LEASE_TTL_MS: int(120_000),
  LEASE_HEARTBEAT_MS: int(30_000),
  CANCEL_POLL_MS: int(5_000),
  WORKSPACE_ROOT: z.string().default('/tmp/archreview-work'),
  RETRIEVAL_HOST_ALLOWLIST: z.string().default('github.com'),
  RETRIEVAL_GITHUB_TOKEN: z.string().optional(),
  RETRIEVAL_TIMEOUT_MS: int(600_000),
  ANALYSIS_RUNTIME: z.enum(['claude-agent-sdk', 'mock']).default('claude-agent-sdk'),
  ANALYSIS_MODEL: z.string().default('claude-sonnet-5-5'),
  ANALYSIS_FALLBACK_MODEL: z.string().optional(),
  ANALYSIS_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  MOCK_AGENT_SCRIPT: z.string().optional(), // path to a fixture script when ANALYSIS_RUNTIME=mock
});
export type RunnerEnv = z.infer<typeof RunnerEnv>;

const SECRET_KEYS = new Set([
  'DATABASE_URL',
  'S3_SECRET_ACCESS_KEY',
  'S3_ACCESS_KEY_ID',
  'WAKE_SHARED_SECRET',
  'RETRIEVAL_KEK',
  'RETRIEVAL_GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  'AUTH_BOOTSTRAP_KEYS',
]);

/** Redacted view for structured startup logs. */
export function describe<T extends Record<string, unknown>>(env: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) out[k] = SECRET_KEYS.has(k) ? (v ? '<set>' : '<unset>') : v;
  return out;
}

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  return ApiEnv.parse(source);
}
export function loadRunnerEnv(source: NodeJS.ProcessEnv = process.env): RunnerEnv {
  return RunnerEnv.parse(source);
}
