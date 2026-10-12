import type Stripe from 'stripe';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createPool, runMigrations } from '../db/client.js';
import { findOrderById } from '../db/repositories/orderRepository.js';
import { findUserById } from '../db/repositories/userRepository.js';
import { createMailer } from '../integrations/mail.js';
import { createBillingService } from '../services/billingService.js';
import { createNotificationService } from '../services/notificationService.js';
import { startConsumer, type JobHandler } from './queue.js';
import { createStripeClient } from '../integrations/stripe.js';

const OrderCreatedPayload = z.object({ orderId: z.string().uuid() });
const StripeEventPayload = z.object({ id: z.string(), type: z.string() }).passthrough();

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, config.DB_POOL_MAX);
  await runMigrations(pool);

  const stripe = createStripeClient(config.STRIPE_SECRET_KEY);
  const billing = createBillingService({ pool, stripe, appPublicUrl: config.APP_PUBLIC_URL });
  const notifications = createNotificationService({
    mailer: createMailer(config.SMTP_URL),
    from: config.MAIL_FROM,
  });

  const handlers: Record<string, JobHandler> = {
    'order.created': async (job) => {
      const { orderId } = OrderCreatedPayload.parse(job.payload);
      const order = await findOrderById(pool, orderId);
      if (!order) throw new Error(`order ${orderId} not found`);
      const user = await findUserById(pool, order.userId);
      if (!user) throw new Error(`user ${order.userId} not found`);
      await notifications.sendOrderReceipt({ order, email: user.email });
    },
    'stripe.event': async (job) => {
      const event = StripeEventPayload.parse(job.payload) as unknown as Stripe.Event;
      await billing.handleStripeEvent(event);
    },
  };

  const consumer = startConsumer({
    pool,
    handlers,
    pollIntervalMs: config.WORKER_POLL_MS,
    maxAttempts: config.WORKER_MAX_ATTEMPTS,
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ level: 'info', msg: 'worker stopping', signal }));
    await consumer.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  console.log(JSON.stringify({ level: 'info', msg: 'worker started', nodeEnv: config.NODE_ENV }));
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'error', msg: 'worker failed to start', error: String(err) }));
  process.exit(1);
});
