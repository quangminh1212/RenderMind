import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { errorHandler, notFoundHandler, AppError } from '../../../src/middleware/errorHandler';
import { setConfig, loadConfig } from '../../../src/config';

/**
 * Error handler tests.
 *
 * The contract these pin: RenderMind exposes one public surface (`/chat`, `/vision`), so
 * there is exactly one error envelope. The earlier build chose a shape per request path
 * because it served three protocols; that indirection is gone, and these tests assert the
 * single shape is emitted regardless of path.
 */

function mockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

function mockReq(path: string): Request {
  return { path, method: 'POST', headers: { 'x-request-id': 'req_test' } } as unknown as Request;
}

const next = vi.fn() as unknown as NextFunction;

describe('errorHandler — one envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv));
  });

  it('emits the chat envelope for an operational AppError', () => {
    const res = mockRes();
    errorHandler(new AppError('Not found', 404, 'not_found'), mockReq('/chat'), res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe('Not found');
    expect(body.error.code).toBe('not_found');
    // The old native shape must not leak.
    expect(body.statusCode).toBeUndefined();
  });

  it('uses the same envelope regardless of path', () => {
    const paths = ['/chat', '/vision', '/anything', '/api/v1/thing'];
    const shapes = paths.map((path) => {
      const res = mockRes();
      errorHandler(
        new AppError('bad request', 400, 'invalid_request_error'),
        mockReq(path),
        res,
        next,
      );
      return JSON.stringify(res.json.mock.calls[0][0]);
    });

    // One shape, so a client cannot be handed an envelope it cannot parse.
    expect(new Set(shapes).size).toBe(1);
  });

  it('maps a Zod-ish 400 to invalid_request_error', () => {
    const res = mockRes();
    errorHandler(
      new AppError('bad prompt', 400, 'invalid_request_error'),
      mockReq('/chat'),
      res,
      next,
    );

    const body = res.json.mock.calls[0][0];
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toBe('bad prompt');
  });

  it('reports an unknown error as 500 and hides internals in production', () => {
    setConfig(loadConfig({ NODE_ENV: 'production', API_KEYS: 'k' } as NodeJS.ProcessEnv));
    const res = mockRes();
    errorHandler(new Error('Sensitive internal error'), mockReq('/chat'), res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.error.message).toBe('An unexpected error occurred');
    expect(body.error.type).toBe('server_error');
  });

  it('reveals the message outside production to aid debugging', () => {
    setConfig(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv));
    const res = mockRes();
    errorHandler(new Error('Detailed reason'), mockReq('/chat'), res, next);

    expect(res.json.mock.calls[0][0].error.message).toBe('Detailed reason');
  });
});

describe('notFoundHandler', () => {
  beforeEach(() => {
    setConfig(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv));
  });

  it('returns a 404 in the chat envelope', () => {
    const res = mockRes();
    notFoundHandler(mockReq('/nope'), res);

    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('/nope');
  });

  it('treats every unknown path identically', () => {
    const a = mockRes();
    const b = mockRes();
    notFoundHandler(mockReq('/v1/messages/unknown'), a);
    notFoundHandler(mockReq('/nope'), b);

    expect(a.json.mock.calls[0][0].error.code).toBe(b.json.mock.calls[0][0].error.code);
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
