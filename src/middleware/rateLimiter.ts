import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { getConfig } from '../config';
import { toAnthropicError, toOpenAIError } from '../utils/formatAdapters';

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
 */

function protocolFor(path: string): 'anthropic' | 'openai' | 'native' {
  if (path.startsWith('/v1/messages')) return 'anthropic';
  if (path.startsWith('/v1/images') || path.startsWith('/v1/models')) return 'openai';
  return 'native';
}

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

      const message = 'Too many requests, please try again later.';
      const protocol = protocolFor(req.path);

      if (protocol === 'anthropic') {
        res.status(429).json(toAnthropicError(message, 429, req.headers['x-request-id'] as string));
        return;
      }

      if (protocol === 'openai') {
        res.status(429).json(toOpenAIError(message, 429, null, 'rate_limit_exceeded'));
        return;
      }

      res.status(429).json({
        error: 'RATE_LIMITED',
        message,
        statusCode: 429,
        requestId: req.headers['x-request-id'],
      });
    },
  });
}
