import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { errorHandler, notFoundHandler, AppError } from '../../../src/middleware/errorHandler';
import { setConfig, loadConfig } from '../../../src/config';

/**
 * Error handler tests.
 *
 * The key contract these pin is the audit's P0 finding: bridge routes must emit the
 * *protocol's* error envelope, not the native one, or no SDK can parse a failure.
 */

function mockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { status: any; json: any };
}

function mockReq(path: string): Request {
  return { path, method: 'POST', headers: { 'x-request-id': 'req_test' } } as unknown as Request;
}

const next = vi.fn() as unknown as NextFunction;

describe('errorHandler — protocol-aware envelopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv));
  });

  it('emits the native envelope for native routes', () => {
    const res = mockRes();
    errorHandler(new AppError('Not found', 404, 'not_found'), mockReq('/api/v1/thing'), res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'NOT_FOUND', statusCode: 404 }),
    );
  });

  it('emits the openclaw envelope for /v1/images routes', () => {
    const res = mockRes();
    errorHandler(
      new AppError('bad prompt', 400, 'invalid_request_error'),
      mockReq('/v1/images/generations'),
      res,
      next,
    );

    const body = res.json.mock.calls[0][0];
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe('bad prompt');
    expect(body.error.type).toBe('invalid_request_error');
    // The native shape must not leak.
    expect(body.statusCode).toBeUndefined();
  });

  it('emits the Anthropic envelope for /v1/messages routes', () => {
    const res = mockRes();
    errorHandler(
      new AppError('bad request', 400, 'invalid_request_error'),
      mockReq('/v1/messages'),
      res,
      next,
    );

    const body = res.json.mock.calls[0][0];
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.request_id).toBe('req_test');
  });

  it('reports an unknown error as 500 and hides internals in production', () => {
    setConfig(loadConfig({ NODE_ENV: 'production', API_KEYS: 'k' } as NodeJS.ProcessEnv));
    const res = mockRes();
    errorHandler(new Error('Sensitive internal error'), mockReq('/api/v1/thing'), res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'An unexpected error occurred' }),
    );
  });

  it('reveals the message outside production to aid debugging', () => {
    setConfig(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv));
    const res = mockRes();
    errorHandler(new Error('Detailed reason'), mockReq('/api/v1/thing'), res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Detailed reason' }));
  });
});

describe('notFoundHandler', () => {
  beforeEach(() => {
    setConfig(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv));
  });

  it('returns the Anthropic 404 shape for /v1/messages subpaths', () => {
    const res = mockRes();
    notFoundHandler(mockReq('/v1/messages/unknown'), res);

    const body = res.json.mock.calls[0][0];
    expect(res.status).toHaveBeenCalledWith(404);
    expect(body.error.type).toBe('not_found_error');
  });

  it('returns the openclaw 404 shape for /v1/images subpaths', () => {
    const res = mockRes();
    notFoundHandler(mockReq('/v1/images/unknown'), res);

    expect(res.json.mock.calls[0][0].error.type).toBe('not_found_error');
  });

  it('returns the native 404 shape elsewhere', () => {
    const res = mockRes();
    notFoundHandler(mockReq('/nope'), res);
    expect(res.json.mock.calls[0][0].error).toBe('NOT_FOUND');
  });
});

describe('AppError', () => {
  it('carries an explicit machine-readable code', () => {
    const error = new AppError('Test error', 400, 'invalid_request_error');
    expect(error.message).toBe('Test error');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('invalid_request_error');
    expect(error.isOperational).toBe(true);
    expect(error.name).toBe('AppError');
  });

  it('does not derive its code from the error name', () => {
    // The previous implementation produced 'APPERROR' for every instance.
    expect(new AppError('x', 400).code).toBe('internal_error');
    expect(new AppError('x', 400, 'custom_code').code).toBe('custom_code');
  });

  it('defaults to 500', () => {
    expect(new AppError('Test error').statusCode).toBe(500);
  });
});
