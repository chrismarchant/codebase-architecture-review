import express from 'express';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createPaymentGateway } from './integrations/payment-gateway.js';
import { createOrderService } from './services/order-service.js';
import { orderRoutes } from './routes/orders.js';

// HTTP entry point: wires configuration, database, gateway and routes together.
const config = loadConfig(process.env);
const db = createDb(config.databaseUrl);
const gateway = createPaymentGateway(config.paymentApiUrl, config.paymentApiKey);
const orders = createOrderService(db, gateway);

const app = express();
app.use(express.json());
app.use('/orders', orderRoutes(orders));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(config.port, () => {
  console.log(`listening on ${config.port}`);
});
