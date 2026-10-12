import type express from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../errors.js';

/**
 * Maps errors to the response envelope `{ error: { code, message, details? } }`.
 * Unexpected errors are logged by message only and returned as a generic 500.
 */
export const errorHandler: express.ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(422).json({
      error: { code: 'validation_failed', message: 'request validation failed', details: err.issues },
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'malformed_json', message: 'request body is not valid JSON' } });
    return;
  }
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'unhandled error',
      path: req.path,
      error: err instanceof Error ? err.message : 'unknown',
    }),
  );
  res.status(500).json({ error: { code: 'internal', message: 'internal error' } });
};
