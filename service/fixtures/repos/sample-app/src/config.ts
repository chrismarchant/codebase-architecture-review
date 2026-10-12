import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  APP_PUBLIC_URL: z.string().url(),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  SMTP_URL: z.string().min(1),
  MAIL_FROM: z.string().email(),
  WORKER_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
});

export type Config = z.infer<typeof EnvSchema>;

/** Parses and validates the process environment. Throws a ZodError on invalid input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}
