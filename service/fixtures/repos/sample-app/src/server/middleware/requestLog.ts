import type express from 'express';

/**
 * One JSON log line per request. Logs method, path (without query string), status and
 * duration only. Headers, bodies and query strings are deliberately not logged.
 */
export function requestLog(): express.RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'request',
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(durationMs),
        }),
      );
    });
    next();
  };
}
