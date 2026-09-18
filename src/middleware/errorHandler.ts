import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { toAnthropicError, toOpenAIError } from '../utils/formatAdapters';
import { logger } from '../utils/logger';
import { getConfig } from '../config';

/**
 * Application error with an explicit machine-readable code.
 *
 * The previous class derived its code from `err.name`, so every instance reported
 * `APPERROR` regardless of what went wrong.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, code = 'internal_error', isOperational = true) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/** Which protocol error envelope a path expects. */
function protocolFor(path: string): 'anthropic' | 'openai' | 'native' {
  if (path.startsWith('/v1/messages')) return 'anthropic';
  if (path.startsWith('/v1/images') || path.startsWith('/v1/models')) return 'openai';
  return 'native';
}

/**
 * Terminal error handler.
 *
 * Fixes the audit's P0 finding that bridge routes leaked the native envelope, so no
 * openclaw or Anthropic SDK could parse a failure. The shape now follows the path.
 *
 * Note: Express 4 inspects the handler's arity to identify it as error middleware, so
 * all four parameters must be declared.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const config = getConfig();
  const requestId = req.headers['x-request-id'] as string;
  const protocol = protocolFor(req.path);

  // ── Resolve status and message ─────────────────────────────
  let status = 500;
  let message = 'An unexpected error occurred';
  let code = 'internal_error';
  let details: unknown;

  if (err instanceof ZodError) {
    status = 400;
    message = 'Invalid request body';
    code = 'invalid_request_error';
    details = err.errors.map((e) => ({ field: e.path.join('.'), message: e.message }));
  } else if (err instanceof AppError) {
    status = err.statusCode;
    message = err.message;
    code = err.code;
  } else if (isJsonParseError(err)) {
    // A malformed JSON body previously surfaced as a 500 leaking the parser's message.
    status = 400;
    message = 'Request body is not valid JSON';
    code = 'invalid_request_error';
  } else {
    // Unknown error: log fully, disclose nothing in production.
    logger.error('Unhandled error', {
      path: req.path,
      requestId,
      error: err.message,
      stack: err.stack,
    });
    message = config.server.isProduction ? 'An unexpected error occurred' : err.message;
  }

  if (status >= 500) {
    logger.error('Server error', { path: req.path, requestId, code, error: err.message });
  } else {
    logger.warn('Client error', { path: req.path, requestId, code, error: err.message });
  }

  // ── Emit in the caller's protocol ──────────────────────────
  if (protocol === 'anthropic') {
    res.status(status).json(toAnthropicError(message, status, requestId));
    return;
  }

  if (protocol === 'openai') {
    res.status(status).json(toOpenAIError(message, status, null, code));
    return;
  }

  res.status(status).json({
    error: code.toUpperCase(),
    message,
    statusCode: status,
    requestId,
    ...(details ? { details } : {}),
  });
}

/** Detect a body-parser JSON syntax error. */
function isJsonParseError(err: Error): boolean {
  return (
    err instanceof SyntaxError &&
    'body' in err &&
    'status' in err &&
    (err as { status?: number }).status === 400
  );
}

/** 404 handler that also respects the caller's protocol. */
export function notFoundHandler(req: Request, res: Response): void {
  const requestId = req.headers['x-request-id'] as string;
  const protocol = protocolFor(req.path);

  if (protocol === 'anthropic') {
    res
      .status(404)
      .json(toAnthropicError(`Unknown endpoint: ${req.method} ${req.path}`, 404, requestId));
    return;
  }

  if (protocol === 'openai') {
    res
      .status(404)
      .json(toOpenAIError(`Unknown endpoint: ${req.method} ${req.path}`, 404, null, 'not_found'));
    return;
  }

  res.status(404).json({
    error: 'NOT_FOUND',
    message: 'The requested endpoint does not exist',
    statusCode: 404,
    requestId,
  });
}
