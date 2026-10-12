import type pg from 'pg';
import { withTransaction } from '../db/client.js';
import {
  findOrderForUser,
  insertOrder,
  transitionStatus,
  type Order,
  type OrderLine,
} from '../db/repositories/orderRepository.js';
import { AppError, ConflictError, NotFoundError } from '../errors.js';
import { enqueueJob } from '../workers/queue.js';

export interface CreateOrderInput {
  currency: 'GBP' | 'USD' | 'EUR';
  items: Array<{ sku: string; quantity: number }>;
}

/** Sample catalogue. Prices are server-side only; clients never send a price. */
const CATALOGUE: Record<string, { name: string; unitCents: number }> = {
  'SKU-BASIC': { name: 'Basic plan seat', unitCents: 1200 },
  'SKU-PRO': { name: 'Pro plan seat', unitCents: 4900 },
  'SKU-SUPPORT': { name: 'Priority support add-on', unitCents: 900 },
};

/** Resolves SKUs to priced lines. Throws AppError(422) for an unknown SKU. */
export function priceItems(items: CreateOrderInput['items']): OrderLine[] {
  return items.map((item) => {
    const entry = CATALOGUE[item.sku];
    if (!entry) throw new AppError(422, 'unknown_sku', `unknown sku ${item.sku}`);
    return { sku: item.sku, name: entry.name, quantity: item.quantity, unitCents: entry.unitCents };
  });
}

export function createOrderService(pool: pg.Pool) {
  return {
    /** Writes the order and its `order.created` job in one transaction. */
    async createOrder(userId: string, input: CreateOrderInput): Promise<Order> {
      const lines = priceItems(input.items);
      const totalCents = lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
      return withTransaction(pool, async (tx) => {
        const order = await insertOrder(tx, { userId, currency: input.currency, totalCents, lines });
        await enqueueJob(tx, 'order.created', { orderId: order.id });
        return order;
      });
    },

    async getOrder(userId: string, orderId: string): Promise<Order> {
      const order = await findOrderForUser(pool, orderId, userId);
      if (!order) throw new NotFoundError('order');
      return order;
    },

    async cancelOrder(userId: string, orderId: string): Promise<Order> {
      const order = await findOrderForUser(pool, orderId, userId);
      if (!order) throw new NotFoundError('order');
      const moved = await transitionStatus(pool, order.id, 'pending', 'cancelled');
      if (!moved) throw new ConflictError(`order is ${order.status}; only pending orders can be cancelled`);
      return { ...order, status: 'cancelled' };
    },
  };
}

export type OrderService = ReturnType<typeof createOrderService>;
