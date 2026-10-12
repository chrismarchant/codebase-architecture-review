import express from 'express';
import type pg from 'pg';
import type Stripe from 'stripe';
import { createBillingService } from '../services/billingService.js';
import { createOrderService } from '../services/orderService.js';
import { createUserService } from '../services/userService.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLog } from './middleware/requestLog.js';
import { createHealthRouter } from './routes/health.js';
import { createOrdersRouter } from './routes/orders.js';
import { createUsersRouter } from './routes/users.js';
import { createWebhooksRouter } from './routes/webhooks.js';

export interface AppDeps {
  pool: pg.Pool;
  stripe: Stripe;
  stripeWebhookSecret: string;
  appPublicUrl: string;
}

/** Builds the Express application. Routes are mounted here; nothing listens on a port yet. */
export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLog());

  app.use(createHealthRouter(deps.pool));

  // The webhook router reads the raw body itself and must be mounted before express.json().
  app.use(
    '/webhooks',
    createWebhooksRouter({ pool: deps.pool, stripe: deps.stripe, webhookSecret: deps.stripeWebhookSecret }),
  );

  app.use(express.json({ limit: '100kb' }));

  const users = createUserService(deps.pool);
  const orders = createOrderService(deps.pool);
  const billing = createBillingService({ pool: deps.pool, stripe: deps.stripe, appPublicUrl: deps.appPublicUrl });

  app.use('/v1/users', authenticate(users), createUsersRouter(users));
  app.use('/v1/orders', authenticate(users), createOrdersRouter(orders, billing));

  app.use(errorHandler);
  return app;
}
