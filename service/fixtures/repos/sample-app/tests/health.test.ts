import express from 'express';
import type pg from 'pg';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createHealthRouter } from '../src/server/routes/health.js';

/** A stand-in pool. Only query() is used by the health router. */
function appWithQuery(query: () => Promise<unknown>) {
  const pool = { query } as unknown as pg.Pool;
  const app = express();
  app.use(createHealthRouter(pool));
  return app;
}

describe('health routes', () => {
  it('GET /health reports liveness without querying the database', async () => {
    const app = appWithQuery(async () => {
      throw new Error('health must not query the database');
    });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /ready returns 200 when the database answers', async () => {
    const app = appWithQuery(async () => ({ rows: [{ '?column?': 1 }] }));
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('GET /ready returns 503 when the database fails', async () => {
    const app = appWithQuery(async () => {
      throw new Error('connection refused');
    });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready' });
  });
});
