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
      const forwarded = req.headers['x-forwarded-for'];
      const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return req.ip || ip || 'unknown';
    },
  });
}
