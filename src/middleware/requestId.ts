import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';

/**
 * Request identity.
 *
 * Runs early so that auth, rate limiting and error handling can all correlate to the
 * same id. The previous implementation minted the id *after* auth, so an authentication
 * failure was logged without one.
 *
 * The id is echoed on every response and, for Anthropic clients, mirrored into error
 * bodies as `request_id` — both are part of that protocol's contract.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128
      ? incoming
      : `req_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;

  req.headers['x-request-id'] = id;
  res.setHeader('x-request-id', id);
  // Anthropic's own header spelling.
  res.setHeader('request-id', id);

  next();
}

/**
 * Attach a generation id.
 *
 * Adapters need a stable identifier for the result they are about to build — the
 * Anthropic bridge derives `msg_…`/`toolu_…` ids from it — so it is assigned here rather
 * than deep inside the engine.
 */
export function generationId(req: Request, _res: Response, next: NextFunction): void {
  req.generationId = `gen_${randomBytes(12).toString('hex')}`;
  next();
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      generationId?: string;
      /** Bucket key used by the rate limiter; set by the auth middleware. */
      rateLimitBucket?: string;
    }
  }
}
