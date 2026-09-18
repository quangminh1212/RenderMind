import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * HTTP request logging.
 *
 * Carries the request id minted by the `requestId` middleware (which now runs first), so
 * a log line can be joined to a specific request — the previous implementation never
 * logged the id at all.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  const requestId = req.headers['x-request-id'];

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const context = {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    };

    if (res.statusCode >= 500) {
      logger.error('Request failed', context);
    } else if (res.statusCode >= 400) {
      logger.warn('Request rejected', context);
    } else {
      logger.info('Request completed', context);
    }
  });

  next();
}
