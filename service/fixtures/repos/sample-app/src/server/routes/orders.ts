import express from 'express';
import { z } from 'zod';
import type { BillingService } from '../../services/billingService.js';
import type { OrderService } from '../../services/orderService.js';
import { currentUser } from '../middleware/auth.js';

export const CreateOrderBody = z.object({
  currency: z.enum(['GBP', 'USD', 'EUR']),
  items: z
    .array(
      z.object({
        sku: z.string().min(1).max(64),
        quantity: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(50),
});

const OrderIdParam = z.string().uuid();

export function createOrdersRouter(orders: OrderService, billing: BillingService): express.Router {
  const router = express.Router();

  router.post('/', async (req, res, next) => {
    try {
      const body = CreateOrderBody.parse(req.body);
      const order = await orders.createOrder(currentUser(res).id, body);
      res.status(201).json({ order });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const id = OrderIdParam.parse(req.params.id);
      const order = await orders.getOrder(currentUser(res).id, id);
      res.json({ order });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/cancel', async (req, res, next) => {
    try {
      const id = OrderIdParam.parse(req.params.id);
      const order = await orders.cancelOrder(currentUser(res).id, id);
      res.json({ order });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/checkout', async (req, res, next) => {
    try {
      const id = OrderIdParam.parse(req.params.id);
      const checkout = await billing.startCheckout(currentUser(res).id, id);
      res.status(201).json({ checkout });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
