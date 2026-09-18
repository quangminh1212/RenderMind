import { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { getConfig } from '../config';
import { toAnthropicError, toOpenAIError } from '../utils/formatAdapters';
import { logger } from '../utils/logger';

/**
 * API-key authentication.
 *
 * Fixes found by the audit:
 *   - Only `x-api-key` was read. Every openclaw SDK sends `Authorization: Bearer …`,
 *     so a client using the documented idiom received a 401.
 *   - Keys were compared with `Array.includes`, a timing-unsafe comparison.
 *   - An invalid key returned 403; Anthropic uses 401 for a bad key.
 *   - Failures used the native error envelope, which no protocol SDK can parse.
 */

/** Paths reachable without authentication. */
const EXEMPT_PATHS = new Set([
  '/health',
  '/healthz',
  '/readyz',
  '/docs',
  '/docs/',
  '/api/v1/backends',
]);

/** Which protocol error shape a path speaks. */
function protocolFor(path: string): 'anthropic' | 'openai' | 'native' {
  if (path.startsWith('/v1/messages')) return 'anthropic';
  if (path.startsWith('/v1/images') || path.startsWith('/v1/models')) return 'openai';
  return 'native';
}

function sendAuthError(req: Request, res: Response, status: number, message: string): void {
  const requestId = req.headers['x-request-id'] as string;
  const protocol = protocolFor(req.path);

  if (protocol === 'anthropic') {
    res.status(status).json(toAnthropicError(message, status, requestId));
    return;
  }

  if (protocol === 'openai') {
    res
      .status(status)
      .json(
        toOpenAIError(
          message,
          status,
          null,
          status === 401 ? 'invalid_api_key' : 'permission_error',
        ),
      );
    return;
  }

  res.status(status).json({
    error: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
    message,
    statusCode: status,
    requestId,
  });
}

/**
 * Extract the presented credential.
 *
 * Accepts both `x-api-key` (Anthropic's own header) and `Authorization: Bearer`
 * (openclaw's), plus the configurable header name.
 */
export function extractApiKey(req: Request): string | undefined {
  const config = getConfig();

  const direct = req.headers[config.auth.apiKeyHeader.toLowerCase()];
  if (typeof direct === 'string' && direct.length > 0) return direct;

  // Anthropic's own header, regardless of what the configured header name is.
  const anthropicHeader = req.headers['x-api-key'];
  if (typeof anthropicHeader === 'string' && anthropicHeader.length > 0) return anthropicHeader;

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }

  return undefined;
}

/** Constant-time key comparison. */
export function keyMatches(presented: string, allowed: string[]): boolean {
  const presentedDigest = createHash('sha256').update(presented).digest();

  let matched = false;
  for (const candidate of allowed) {
    const candidateDigest = createHash('sha256').update(candidate).digest();
    // timingSafeEqual requires equal-length buffers; digests always are.
    // Do not short-circuit, so the number of comparisons does not leak which key matched.
    if (timingSafeEqual(presentedDigest, candidateDigest)) matched = true;
  }
  return matched;
}

/** A stable, non-secret bucket key derived from the credential. */
export function bucketKeyFor(presented: string): string {
  return `key:${createHash('sha256').update(presented).digest('hex').slice(0, 16)}`;
}

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const config = getConfig();

  if (!config.auth.enabled) {
    return next();
  }

  if (EXEMPT_PATHS.has(req.path)) {
    return next();
  }

  const presented = extractApiKey(req);

  if (!presented) {
    sendAuthError(
      req,
      res,
      401,
      `Missing API key. Provide it via the "${config.auth.apiKeyHeader}" header or "Authorization: Bearer".`,
    );
    return;
  }

  if (!keyMatches(presented, config.auth.apiKeys)) {
    logger.warn('Rejected request with invalid API key', {
      requestId: req.headers['x-request-id'],
      path: req.path,
      // Log only a fingerprint, never the key itself.
      keyFingerprint: bucketKeyFor(presented),
    });
    // 401, not 403: the credential is invalid, which Anthropic also treats as 401.
    sendAuthError(req, res, 401, 'Invalid API key');
    return;
  }

  // A hashed bucket key keeps the raw secret out of rate-limit keys and logs.
  req.rateLimitBucket = bucketKeyFor(presented);
  next();
}
