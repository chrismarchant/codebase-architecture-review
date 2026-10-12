/**
 * Railway Infrastructure as Code for the Architecture Review service (ADR-007).
 *
 * Evaluate with the Railway CLI from the repository root:
 *   cd .railway && npm install          # installs the `railway` SDK used by this file
 *   railway login && railway link       # choose project + environment
 *   railway config plan                 # review; nothing is applied under the build directive
 *   railway config apply                # operator action, outside this directive
 *
 * Every key used below exists in the `railway@3.13.1` SDK type definitions
 * (node_modules/railway/dist/index-*.d.ts: IntentServiceConfig, BuildConfig,
 * DeployConfig) and in the Railway documentation fetched on 2026-10-12
 * (/infrastructure-as-code/reference, /config-as-code/reference for the
 * deploy/build field semantics). Nothing here is invented.
 *
 * Topology (SS00 §2, §10):
 *   api     — public HTTP service (web UI + /v1 API), may sleep when idle
 *   runner  — private service, woken by the API over the private network, may sleep when idle
 *   postgres — authoritative job state
 *   artifacts — private S3-compatible bucket for published artifacts
 */
import { bucket, defineRailway, github, group, postgres, preserve, project, ref, service } from 'railway/iac';

const REPO = 'chrismarchant/codebase-architecture-review';
const BRANCH = 'main';

export default defineRailway((ctx) => {
  const prod = ctx.environment === 'production';

  const db = postgres('postgres');
  const artifacts = bucket('artifacts', { region: 'iad' });

  // Variables shared by both services. Secrets are `preserve()`d: the operator sets
  // them once in the Railway dashboard (or `railway variables`) and IaC never
  // writes their values into source control.
  const common = {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    DB_POOL_MAX: '3',
    DB_IDLE_TIMEOUT_MS: '10000',
    ARTIFACT_STORE: 's3',
    S3_ENDPOINT: ref(artifacts, 'ENDPOINT'),
    S3_REGION: ref(artifacts, 'REGION'),
    S3_BUCKET: ref(artifacts, 'BUCKET'),
    S3_ACCESS_KEY_ID: ref(artifacts, 'ACCESS_KEY_ID'),
    S3_SECRET_ACCESS_KEY: ref(artifacts, 'SECRET_ACCESS_KEY'),
    DATABASE_URL: db.env.DATABASE_URL, // private-network URL (not DATABASE_PUBLIC_URL)
    WAKE_SHARED_SECRET: preserve(),
    RETRIEVAL_KEK: preserve(),
    SHUTDOWN_GRACE_MS: '25000',
  } as const;

  const runner = service('runner', {
    source: github(REPO, { branch: BRANCH }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'service/apps/runner/Dockerfile' },
    deploy: {
      healthcheckPath: '/health',
      healthcheckTimeout: 120,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      drainingSeconds: 30, // SIGTERM → graceful lease release before SIGKILL (SS00 §10.6)
      sleepApplication: true, // Serverless: sleeps after 5–10 min without outbound traffic (SS00 §10)
      numReplicas: 1,
    },
    env: {
      ...common,
      PORT: '3001',
      RUNNER_MAX_CONCURRENCY: '1',
      LEASE_TTL_MS: '120000',
      LEASE_HEARTBEAT_MS: '30000',
      CANCEL_POLL_MS: '5000',
      WORKSPACE_ROOT: '/tmp/archreview-work',
      RETRIEVAL_HOST_ALLOWLIST: 'github.com',
      RETRIEVAL_GITHUB_TOKEN: preserve(),
      ANALYSIS_RUNTIME: 'claude-agent-sdk',
      ANALYSIS_MODEL: 'claude-sonnet-5-5', // configuration, never a development-session model (ADR-014)
      ANALYSIS_EFFORT: 'medium',
      ANTHROPIC_API_KEY: preserve(),
    },
  });

  const api = service('api', {
    source: github(REPO, { branch: BRANCH }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'service/apps/api/Dockerfile' },
    deploy: {
      healthcheckPath: '/health',
      healthcheckTimeout: 120,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      drainingSeconds: 30,
      sleepApplication: true,
      numReplicas: 1,
    },
    env: {
      ...common,
      PORT: '3000',
      // Private network hostname of the runner (SS00 §10): wake calls never leave the project.
      RUNNER_INTERNAL_URL: `http://${runner.env.RAILWAY_PRIVATE_DOMAIN}:3001`,
      // Railway variable-reference syntax, resolved by Railway at deploy time.
      PUBLIC_BASE_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      AUTH_BOOTSTRAP_KEYS: preserve(),
      SESSION_TTL_HOURS: '12',
      RATE_LIMIT_PER_MINUTE: '60',
      LEASE_TTL_MS: '120000',
      RECONCILE_MIN_INTERVAL_MS: '60000',
      RECONCILE_MAX_INTERVAL_MS: '900000',
      RETENTION_DAYS: prod ? '90' : '14',
      COOKIE_SECURE: '1',
    },
  });

  return project('architecture-review', {
    resources: [group('Control plane', [api, db]), group('Analysis', [runner, artifacts])],
  });
});
