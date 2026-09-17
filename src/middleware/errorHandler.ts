import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../types/api.types';
import { logger } from '../utils/logger';
import { getConfig } from '../config';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number = 500, isOperational: boolean = true) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const config = getConfig();
  const isProduction = config.server.nodeEnv === 'production';
  const requestId = req.headers['x-request-id'] as string;

  // Zod validation error
  if (err instanceof ZodError) {
    const response: ApiError = {
      error: 'VALIDATION_ERROR',
      message: 'Invalid request body',
      statusCode: 400,
      details: err.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    };

    logger.warn('Validation error', { path: req.path, requestId, details: response.details });
    res.status(400).json(response);
    return;
  }

  // Application error
  if (err instanceof AppError) {
    const response: ApiError = {
      error: err.name.toUpperCase().replace(/\s+/g, '_'),
      message: err.message,
      statusCode: err.statusCode,
    };

    if (err.statusCode >= 500) {
      logger.error('Server error', { path: req.path, requestId, error: err.message });
    } else {
      logger.warn('Client error', { path: req.path, requestId, error: err.message });
    }

    res.status(err.statusCode).json(response);
    return;
  }

  // Unknown error — never leak internals in production
  logger.error('Unhandled error', {
    path: req.path,
    requestId,
    error: err.message,
    stack: err.stack,
  });

  const response: ApiError = {
    error: 'INTERNAL_ERROR',
    message: isProduction ? 'An unexpected error occurred' : err.message,
    statusCode: 500,
  };

  res.status(500).json(response);
}
