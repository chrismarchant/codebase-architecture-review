import type pg from 'pg';
import type Stripe from 'stripe';
import { findOrderById, setStripeSession, transitionStatus } from '../db/repositories/orderRepository.js';
import { findUserById } from '../db/repositories/userRepository.js';
import { createCheckoutSession } from '../integrations/stripe.js';
import { ConflictError, NotFoundError } from '../errors.js';

export interface BillingDeps {
  pool: pg.Pool;
  stripe: Stripe;
  appPublicUrl: string;
}

export function createBillingService(deps: BillingDeps) {
  return {
    /** Creates a hosted Checkout Session for a pending order owned by the caller. */
    async startCheckout(userId: string, orderId: string): Promise<{ url: string }> {
      const order = await findOrderById(deps.pool, orderId);
      if (!order || order.userId !== userId) throw new NotFoundError('order');
      if (order.status !== 'pending') throw new ConflictError(`order is ${order.status}`);

      const user = await findUserById(deps.pool, userId);
      if (!user) throw new NotFoundError('user');

      const session = await createCheckoutSession(deps.stripe, {
        orderId: order.id,
        amountCents: order.totalCents,
        currency: order.currency,
        customerEmail: user.email,
        successUrl: `${deps.appPublicUrl}/orders/${order.id}?paid=1`,
        cancelUrl: `${deps.appPublicUrl}/orders/${order.id}`,
      });
      if (!session.url) throw new Error('checkout session returned no url');

      await setStripeSession(deps.pool, order.id, session.id);
      return { url: session.url };
    },

    /**
     * Applies a verified Stripe event. Runs in the worker, after the webhook has been
     * acknowledged. Redelivery is safe: the status transition is a compare-and-set.
     */
    async handleStripeEvent(event: Stripe.Event): Promise<void> {
      if (event.type !== 'checkout.session.completed') return;
      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = session.metadata?.orderId;
      if (!orderId) throw new Error(`checkout session ${session.id} has no orderId metadata`);
      const moved = await transitionStatus(deps.pool, orderId, 'pending', 'paid');
      if (!moved) {
        console.log(JSON.stringify({ level: 'info', msg: 'order already settled', orderId, eventId: event.id }));
      }
    },
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
