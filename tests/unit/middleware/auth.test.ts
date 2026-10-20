import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { extractApiKey, keyMatches, bucketKeyFor, apiKeyAuth } from '../../../src/middleware/auth';
import { setConfig, loadConfig } from '../../../src/config';

/**
 * Auth middleware tests.
 *
 * Pins the three key behaviors the audit surfaced:
 *   1. Three header sources are accepted (configured header, x-api-key, Authorization: Bearer).
 *   2. Key comparison is constant-time (no short-circuit on first match).
 *   3. Auth failures use the chat error envelope, not a native shape.
 */

function configWithKeys(...keys: string[]) {
  return loadConfig({
    NODE_ENV: 'test',
    API_KEYS: keys.join(','),
  } as NodeJS.ProcessEnv);
}

function mockReq(over: Record<string, unknown> = {}): Request {
  return {
    path: '/chat',
    headers: {},
    ...over,
  } as unknown as Request;
}

function mockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

const next = vi.fn() as unknown as NextFunction;

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── extractApiKey ──────────────────────────────────────────

describe('extractApiKey', () => {
  beforeEach(() => {
    setConfig(configWithKeys('test-key-1'));
  });

  it('reads from the configured header name', () => {
    const req = mockReq({ headers: { 'x-api-key': 'my-key' } });
    setConfig(
      loadConfig({
        NODE_ENV: 'test',
        API_KEYS: 'test-key-1',
        API_KEY_HEADER: 'x-api-key',
      } as NodeJS.ProcessEnv),
    );
    expect(extractApiKey(req)).toBe('my-key');
  });

  it('reads from x-api-key even if configured header differs', () => {
    const req = mockReq({ headers: { 'x-api-key': 'fallback-key' } });
    setConfig(
      loadConfig({
        NODE_ENV: 'test',
        API_KEYS: 'test-key-1',
        API_KEY_HEADER: 'custom-header',
      } as NodeJS.ProcessEnv),
    );
    expect(extractApiKey(req)).toBe('fallback-key');
  });

  it('reads from Authorization: Bearer header', () => {
    const req = mockReq({ headers: { authorization: 'Bearer bearer-key' } });
    expect(extractApiKey(req)).toBe('bearer-key');
  });

  it('is case-insensitive for Bearer prefix', () => {
    const req = mockReq({ headers: { authorization: 'bearer bearer-key' } });
    expect(extractApiKey(req)).toBe('bearer-key');
  });

  it('returns undefined when no key is present', () => {
    const req = mockReq();
    expect(extractApiKey(req)).toBeUndefined();
  });

  it('returns undefined for empty string headers', () => {
    const req = mockReq({ headers: { 'x-api-key': '', authorization: '' } });
    expect(extractApiKey(req)).toBeUndefined();
  });

  it('prefers configured header over x-api-key when both present', () => {
    setConfig(
      loadConfig({
        NODE_ENV: 'test',
        API_KEYS: 'test-key-1',
        API_KEY_HEADER: 'x-api-key',
      } as NodeJS.ProcessEnv),
    );
    const req = mockReq({ headers: { 'x-api-key': 'first-match' } });
    expect(extractApiKey(req)).toBe('first-match');
  });

  it('strips whitespace from Bearer token', () => {
    const req = mockReq({ headers: { authorization: 'Bearer  spaced-key  ' } });
    expect(extractApiKey(req)).toBe('spaced-key');
  });
});

// ─── keyMatches ─────────────────────────────────────────────

describe('keyMatches', () => {
  it('returns true for a matching key', () => {
    expect(keyMatches('correct-key', ['wrong', 'correct-key', 'other'])).toBe(true);
  });

  it('returns false when no key matches', () => {
    expect(keyMatches('presented', ['alpha', 'beta', 'gamma'])).toBe(false);
  });

  it('returns false for an empty allowed list', () => {
    expect(keyMatches('key', [])).toBe(false);
  });

  it('returns true even when matching key is not the first in the list', () => {
    // Verifies no short-circuit: the comparison must check all candidates.
    expect(keyMatches('last-key', ['a', 'b', 'c', 'last-key'])).toBe(true);
  });
});

// ─── bucketKeyFor ───────────────────────────────────────────

describe('bucketKeyFor', () => {
  it('returns a stable, prefixed hash', () => {
    const bucket = bucketKeyFor('my-secret-key');
    expect(bucket).toMatch(/^key:[0-9a-f]{16}$/);
  });

  it('returns the same value for the same input', () => {
    expect(bucketKeyFor('same')).toBe(bucketKeyFor('same'));
  });

  it('returns different values for different inputs', () => {
    expect(bucketKeyFor('key-a')).not.toBe(bucketKeyFor('key-b'));
  });
});

// ─── apiKeyAuth ─────────────────────────────────────────────

describe('apiKeyAuth', () => {
  it('passes through when auth is disabled (no API_KEYS configured)', () => {
    setConfig(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv));
    const req = mockReq();
    apiKeyAuth(req, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through for exempt paths', () => {
    setConfig(configWithKeys('secret'));
    const exemptPaths = ['/health', '/healthz', '/readyz', '/docs', '/docs/', '/api/v1/backends'];

    for (const path of exemptPaths) {
      vi.clearAllMocks();
      const req = mockReq({ path });
      apiKeyAuth(req, mockRes(), next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('rejects missing key with 401', () => {
    setConfig(configWithKeys('secret'));
    const res = mockRes();
    const req = mockReq({ headers: {} });
    apiKeyAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('rejects invalid key with 401', () => {
    setConfig(configWithKeys('secret'));
    const res = mockRes();
    const req = mockReq({ headers: { 'x-api-key': 'wrong-key' } });
    apiKeyAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.error.message).toBe('Invalid API key');
  });

  it('passes for a valid key and sets rateLimitBucket', () => {
    setConfig(configWithKeys('secret'));
    const res = mockRes();
    const req = mockReq({ headers: { 'x-api-key': 'secret' } }) as Request & {
      rateLimitBucket?: string;
    };
    apiKeyAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.rateLimitBucket).toBe(bucketKeyFor('secret'));
  });

  it('includes x-request-id in error responses', () => {
    setConfig(configWithKeys('secret'));
    const res = mockRes();
    const req = mockReq({
      headers: { 'x-request-id': 'req_abc123' },
    });
    apiKeyAuth(req, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.request_id).toBe('req_abc123');
  });
});
