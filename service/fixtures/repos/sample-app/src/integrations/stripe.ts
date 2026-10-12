import Stripe from 'stripe';
import { AppError } from '../errors.js';

export interface CheckoutInput {
  orderId: string;
  amountCents: number;
  currency: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}

export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey);
}

/**
 * Creates a one-off payment Checkout Session. The order id travels in metadata so the
 * webhook can find the order again. The idempotency key stops a retried request from
 * creating a second session for the same order.
 */
export async function createCheckoutSession(
  client: Stripe,
  input: CheckoutInput,
): Promise<{ id: string; url: string | null }> {
  const session = await client.checkout.sessions.create(
    {
      mode: 'payment',
      customer_email: input.customerEmail,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: input.amountCents,
            product_data: { name: `Order ${input.orderId}` },
          },
        },
      ],
      metadata: { orderId: input.orderId },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    },
    { idempotencyKey: `checkout-${input.orderId}` },
  );
  return { id: session.id, url: session.url };
}

/** Verifies the Stripe-Signature header against the raw request body. Throws AppError(400) on failure. */
export function verifyWebhookEvent(client: Stripe, rawBody: Buffer, signature: string, secret: string): Stripe.Event {
  try {
    return client.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new AppError(400, 'invalid_signature', 'invalid Stripe webhook signature');
  }
}
