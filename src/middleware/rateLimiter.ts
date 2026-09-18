import rateLimit from 'express-rate-limit';
import { getConfig } from '../config';

export function createRateLimiter() {
  const config = getConfig();
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'RATE_LIMITED',
      message: 'Too many requests, please try again later',
      statusCode: 429,
    },
    keyGenerator: (req) => {
      // Prefer API key for stable rate limiting, fall back to IP
      const apiKeyHeader = (req as any).rateLimitKeyHeader as string | undefined;
      if (apiKeyHeader) {
        const apiKey = req.headers[apiKeyHeader.toLowerCase()];
        if (apiKey) return `key:${apiKey}`;
      }
      return req.ip || 'unknown';
    },
  });
}
