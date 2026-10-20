import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requestId, generationId } from '../../../src/middleware/requestId';

/**
 * Request identity middleware tests.
 *
 * Pins two behaviors:
 *   1. requestId: preserves incoming id, generates one when absent, rejects >128 chars.
 *   2. generationId: attaches a gen_ prefixed id.
 */

function mockReq(
  over: Record<string, unknown> = {},
): Request & { headers: Record<string, unknown> } {
  return {
    path: '/chat',
    method: 'POST',
    headers: { ...((over.headers as Record<string, unknown>) ?? {}) },
    ...over,
  } as unknown as Request & { headers: Record<string, unknown> };
}

function mockRes() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
    get headers() {
      return headers;
    },
  };
  return res as unknown as Response & {
    setHeader: ReturnType<typeof vi.fn>;
    _headers: Record<string, string>;
  };
}

const next = vi.fn() as unknown as NextFunction;

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── requestId ──────────────────────────────────────────────

describe('requestId', () => {
  it('preserves a valid incoming x-request-id', () => {
    const req = mockReq({ headers: { 'x-request-id': 'client-id-123' } });
    const res = mockRes();
    requestId(req, res, next);

    expect(req.headers['x-request-id']).toBe('client-id-123');
    expect(next).toHaveBeenCalledOnce();
  });

  it('generates an id when no x-request-id is present', () => {
    const req = mockReq({ headers: {} });
    const res = mockRes();
    requestId(req, res, next);

    const id = req.headers['x-request-id'] as string;
    expect(id).toMatch(/^req_/);
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects an x-request-id longer than 128 characters', () => {
    const longId = 'x'.repeat(129);
    const req = mockReq({ headers: { 'x-request-id': longId } });
    const res = mockRes();
    requestId(req, res, next);

    const id = req.headers['x-request-id'] as string;
    expect(id).not.toBe(longId);
    expect(id).toMatch(/^req_/);
  });

  it('accepts an x-request-id of exactly 128 characters', () => {
    const exactId = 'a'.repeat(128);
    const req = mockReq({ headers: { 'x-request-id': exactId } });
    const res = mockRes();
    requestId(req, res, next);

    expect(req.headers['x-request-id']).toBe(exactId);
  });

  it('rejects empty string x-request-id', () => {
    const req = mockReq({ headers: { 'x-request-id': '' } });
    const res = mockRes();
    requestId(req, res, next);

    const id = req.headers['x-request-id'] as string;
    expect(id).toMatch(/^req_/);
  });

  it('sets x-request-id and request-id response headers', () => {
    const req = mockReq({ headers: { 'x-request-id': 'test-id' } });
    const res = mockRes();
    requestId(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'test-id');
    expect(res.setHeader).toHaveBeenCalledWith('request-id', 'test-id');
  });
});

// ─── generationId ───────────────────────────────────────────

describe('generationId', () => {
  it('attaches a gen_ prefixed id to the request', () => {
    const req = mockReq() as Request & { generationId?: string };
    const res = mockRes();
    generationId(req, res, next);

    expect(req.generationId).toMatch(/^gen_[0-9a-f]{24}$/);
    expect(next).toHaveBeenCalledOnce();
  });

  it('generates a unique id on each call', () => {
    const req1 = mockReq() as Request & { generationId?: string };
    const req2 = mockReq() as Request & { generationId?: string };
    const res = mockRes();

    generationId(req1, res, next);
    generationId(req2, res, next);

    expect(req1.generationId).not.toBe(req2.generationId);
  });

  it('does not set any response headers', () => {
    const req = mockReq() as Request & { generationId?: string };
    const res = mockRes();
    generationId(req, res, next);

    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
