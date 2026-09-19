import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { toChatError } from '../utils/formatAdapters';
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

/**
 * Terminal error handler.
 *
 * There is one error envelope now, shared by `/chat` and `/vision`, because there is one
 * public surface. The earlier build chose a shape from the request path because it served
 * three different protocols; that indirection existed only to stop those protocols from
 * leaking into each other, and went away with them.
 *
 * Note: Express 4 inspects the handler's arity to identify it as error middleware, so
 * all four parameters must be declared.
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const config = getConfig();
  const requestId = req.headers['x-request-id'] as string;

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

  // ── Emit ───────────────────────────────────────────────────
  res
    .status(status)
    .json(
      details === undefined
        ? toChatError(message, status, null, code)
        : { ...toChatError(message, status, null, code), details },
    );
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

/** 404 handler. One surface, so one shape. */
export function notFoundHandler(req: Request, res: Response): void {
  res
    .status(404)
    .json(toChatError(`Unknown endpoint: ${req.method} ${req.path}`, 404, null, 'not_found'));
}
