import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requestLogger } from '../../../src/middleware/requestLogger';

/**
 * Request logger middleware tests.
 *
 * Verifies:
 *   1. A finish listener is registered on the response.
 *   2. Log level is chosen by status code: >=500 = error, >=400 = warn, else info.
 */

vi.mock('../../../src/utils/logger', () => {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

import { logger } from '../../../src/utils/logger';

function mockReq(over: Record<string, unknown> = {}): Request {
  return {
    method: 'POST',
    path: '/chat',
    headers: { 'x-request-id': 'req_test' },
    ...over,
  } as unknown as Request;
}

function mockRes() {
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    statusCode: 200,
    on: vi.fn((event: string, fn: () => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    }),
    _emit: (event: string) => {
      for (const fn of listeners[event] ?? []) fn();
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    _emit: (event: string) => void;
  };
}

const next = vi.fn() as unknown as NextFunction;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('requestLogger', () => {
  it('registers a finish listener on the response', () => {
    const res = mockRes();
    requestLogger(mockReq(), res, next);

    expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
  });

  it('calls next immediately', () => {
    const res = mockRes();
    requestLogger(mockReq(), res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('logs at info level for 200-399 status codes', () => {
    const res = mockRes();
    res.statusCode = 200;
    requestLogger(mockReq(), res, next);
    res._emit('finish');

    expect(logger.info).toHaveBeenCalledWith(
      'Request completed',
      expect.objectContaining({ status: 200 }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs at warn level for 400-499 status codes', () => {
    const res = mockRes();
    res.statusCode = 404;
    requestLogger(mockReq(), res, next);
    res._emit('finish');

    expect(logger.warn).toHaveBeenCalledWith(
      'Request rejected',
      expect.objectContaining({ status: 404 }),
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs at error level for 500+ status codes', () => {
    const res = mockRes();
    res.statusCode = 500;
    requestLogger(mockReq(), res, next);
    res._emit('finish');

    expect(logger.error).toHaveBeenCalledWith(
      'Request failed',
      expect.objectContaining({ status: 500 }),
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('includes requestId in the log context', () => {
    const req = mockReq({ headers: { 'x-request-id': 'req_abc' } });
    const res = mockRes();
    res.statusCode = 200;
    requestLogger(req, res, next);
    res._emit('finish');

    expect(logger.info).toHaveBeenCalledWith(
      'Request completed',
      expect.objectContaining({ requestId: 'req_abc' }),
    );
  });

  it('includes method and path in the log context', () => {
    const req = mockReq({ method: 'GET', path: '/health' });
    const res = mockRes();
    res.statusCode = 200;
    requestLogger(req, res, next);
    res._emit('finish');

    expect(logger.info).toHaveBeenCalledWith(
      'Request completed',
      expect.objectContaining({ method: 'GET', path: '/health' }),
    );
  });

  it('logs durationMs as a number', () => {
    const res = mockRes();
    res.statusCode = 200;
    requestLogger(mockReq(), res, next);

    // Advance time by 50ms
    vi.advanceTimersByTime(50);
    res._emit('finish');

    const ctx = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(typeof ctx.durationMs).toBe('number');
    expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
  });
});
