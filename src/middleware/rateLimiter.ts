import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { getConfig } from '../config';
import { toChatError } from '../utils/formatAdapters';

/**
 * Rate limiting.
 *
 * Fixes from the audit:
 *   - The limiter was mounted *before* the middleware that set the key it read, so
 *     per-key limiting silently degraded to per-IP for every request. The key is now
 *     read from the request directly.
 *   - `/health` was rate limited, so a liveness probe could be 429'd and trigger a
 *     restart loop for a healthy process.
 *   - A 429 returned the native envelope, which protocol SDKs cannot parse.
 *
 * The 429 now uses the one `/chat` envelope, because the engine exposes one surface.
 */

export function createRateLimiter() {
  const config = getConfig();

  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.maxRequests,
    standardHeaders: true,
    legacyHeaders: false,

    // Never throttle health/readiness probes or static docs.
    skip: (req: Request) =>
      req.path === '/health' ||
      req.path === '/healthz' ||
      req.path === '/readyz' ||
      req.path.startsWith('/docs'),

    keyGenerator: (req: Request): string => {
      // The auth middleware sets a hashed bucket key. Reading it here (rather than via
      // an indirection mounted later) is what makes per-key limiting actually engage.
      if (req.rateLimitBucket) return req.rateLimitBucket;
      return req.ip ?? 'unknown';
    },

    handler: (req: Request, res: Response) => {
      const retryAfterSeconds = Math.ceil(config.rateLimit.windowMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));

      res
        .status(429)
        .json(
          toChatError(
            'Too many requests, please try again later.',
            429,
            null,
            'rate_limit_exceeded',
          ),
        );
    },
  });
}
