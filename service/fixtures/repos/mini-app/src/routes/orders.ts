import { Router } from 'express';
import type { OrderService } from '../services/order-service.js';

// Request handlers for the /orders resource.
export function orderRoutes(orders: OrderService): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const { customerId, items } = req.body ?? {};
    if (!customerId || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'customerId and items are required' });
      return;
    }
    const order = await orders.placeOrder(customerId, items);
    res.status(201).json(order);
  });

  router.get('/:id', async (req, res) => {
    const order = await orders.getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(order);
  });

  return router;
}
