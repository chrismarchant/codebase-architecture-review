import express from 'express';
import type pg from 'pg';
import type Stripe from 'stripe';
import { verifyWebhookEvent } from '../../integrations/stripe.js';
import { AppError } from '../../errors.js';
import { enqueueJob } from '../../workers/queue.js';

export interface WebhookDeps {
  pool: pg.Pool;
  stripe: Stripe;
  webhookSecret: string;
}

/**
 * Stripe delivers events here. The signature is verified against the raw body, the event
 * is queued for the worker and the handler returns 200 without doing the business work
 * itself, so Stripe does not time out and retry.
 */
export function createWebhooksRouter(deps: WebhookDeps): express.Router {
  const router = express.Router();

  router.post('/stripe', express.raw({ type: 'application/json', limit: '512kb' }), async (req, res, next) => {
    try {
      const signature = req.get('stripe-signature');
      if (!signature) throw new AppError(400, 'missing_signature', 'missing Stripe-Signature header');
      const event = verifyWebhookEvent(deps.stripe, req.body as Buffer, signature, deps.webhookSecret);
      await enqueueJob(deps.pool, 'stripe.event', event);
      res.status(200).json({ received: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
