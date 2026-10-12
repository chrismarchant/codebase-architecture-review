import { loadConfig } from '../config.js';
import { createPool, runMigrations } from '../db/client.js';
import { createStripeClient } from '../integrations/stripe.js';
import { createApp } from './app.js';

/**
 * API entry point. Migrations run before the listener opens. On SIGTERM the server stops
 * accepting connections, drains in-flight requests and closes the pool.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);
  await runMigrations(pool);

  const app = createApp({
    pool,
    stripe: createStripeClient(config.STRIPE_SECRET_KEY),
    stripeWebhookSecret: config.STRIPE_WEBHOOK_SECRET,
    appPublicUrl: config.APP_PUBLIC_URL,
  });

  const server = app.listen(config.PORT, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'api listening', port: config.PORT }));
  });

  process.on('SIGTERM', () => {
    console.log(JSON.stringify({ level: 'info', msg: 'api stopping' }));
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'error', msg: 'api failed to start', error: String(err) }));
  process.exit(1);
});
