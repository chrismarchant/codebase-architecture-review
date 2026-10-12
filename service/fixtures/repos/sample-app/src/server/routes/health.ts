import express from 'express';
import type pg from 'pg';
import { pingDatabase } from '../../db/client.js';

/** /health: process liveness only. /ready: also checks the database. */
export function createHealthRouter(pool: pg.Pool): express.Router {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    const ok = await pingDatabase(pool);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready' });
  });

  return router;
}
