import type { Db } from '../db/client.js';
import type { PaymentGateway } from '../integrations/payment-gateway.js';
import { priceOrder, type LineItem } from './pricing.js';

export interface OrderService {
  placeOrder(customerId: string, items: LineItem[]): Promise<{ id: string; totalCents: number; status: string }>;
  getOrder(id: string): Promise<{ id: string; totalCents: number; status: string } | null>;
}

// Business logic: price the order, charge the customer, persist the result.
export function createOrderService(db: Db, gateway: PaymentGateway): OrderService {
  return {
    async placeOrder(customerId, items) {
      const price = priceOrder(items);
      const charge = await gateway.charge(customerId, price.totalCents);
      const status = charge.approved ? 'paid' : 'payment_failed';
      const id = await db.insertOrder(customerId, price.totalCents, status);
      return { id, totalCents: price.totalCents, status };
    },
    async getOrder(id) {
      return db.findOrder(id);
    },
  };
}
