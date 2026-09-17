import { describe, it, expect, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { errorHandler, AppError } from '../../../src/middleware/errorHandler';
import { ZodError } from 'zod';

describe('errorHandler', () => {
  const mockReq = { path: '/test' } as Request;
  const mockRes = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response;
  const mockNext = vi.fn() as NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle AppError with correct status code', () => {
    const error = new AppError('Not found', 404);
    errorHandler(error, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'APPERROR',
        message: 'Not found',
        statusCode: 404,
      }),
    );
  });

  it('should handle unknown errors with 500', () => {
    const error = new Error('Something went wrong');
    errorHandler(error, mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'INTERNAL_ERROR',
        statusCode: 500,
      }),
    );
  });
});

describe('AppError', () => {
  it('should create an error with message and status code', () => {
    const error = new AppError('Test error', 400);
    expect(error.message).toBe('Test error');
    expect(error.statusCode).toBe(400);
    expect(error.isOperational).toBe(true);
  });

  it('should default to 500 status code', () => {
    const error = new AppError('Test error');
    expect(error.statusCode).toBe(500);
  });
});
