import { describe, it, expect } from 'vitest';
import {
  ProviderError,
  UnsupportedCapabilityError,
  NoProviderAvailableError,
  AllProvidersUnavailableError,
  GenerationTimeoutError,
} from '../../../src/engine/errors';
import { classifyFailure, backoffDelay, CircuitBreaker } from '../../../src/platform/http.client';

/**
 * Engine error and resilience tests.
 *
 * The engine's honesty depends on these types carrying enough information to make the
 * right status decision: a client error must be distinguishable from an outage, and a
 * retryable failure from a terminal one.
 */

describe('ProviderError', () => {
  it('derives retryability from the status', () => {
    expect(new ProviderError({ provider: 'p', message: 'x', status: 503 }).retryable).toBe(true);
    expect(new ProviderError({ provider: 'p', message: 'x', status: 400 }).retryable).toBe(false);
  });

  it('treats a missing status (transport failure) as retryable', () => {
    expect(new ProviderError({ provider: 'p', message: 'x' }).retryable).toBe(true);
  });

  it('honours an explicit retryable override', () => {
    const error = new ProviderError({ provider: 'p', message: 'x', status: 500, retryable: false });
    expect(error.retryable).toBe(false);
  });

  it('knows client errors from upstream errors', () => {
    expect(new ProviderError({ provider: 'p', message: 'x', status: 400 }).isClientError).toBe(
      true,
    );
    expect(new ProviderError({ provider: 'p', message: 'x', status: 502 }).isClientError).toBe(
      false,
    );
  });

  it('preserves status, code, Retry-After and cause', () => {
    const cause = new Error('root');
    const error = new ProviderError({
      provider: 'p',
      message: 'x',
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 12,
      cause,
    });
    expect(error.status).toBe(429);
    expect(error.code).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(12);
    expect((error as { cause?: unknown }).cause).toBe(cause);
  });
});

describe('other engine errors', () => {
  it('UnsupportedCapabilityError carries details', () => {
    const error = new UnsupportedCapabilityError('nope', ['a: b']);
    expect(error.details).toEqual(['a: b']);
    expect(error.name).toBe('UnsupportedCapabilityError');
  });

  it('NoProviderAvailableError has a default message', () => {
    expect(new NoProviderAvailableError().message).toMatch(/No image provider/);
  });

  it('AllProvidersUnavailableError names the providers', () => {
    const error = new AllProvidersUnavailableError(['a', 'b']);
    expect(error.providers).toEqual(['a', 'b']);
    expect(error.message).toMatch(/temporarily unavailable/);
  });

  it('GenerationTimeoutError names the budget', () => {
    expect(new GenerationTimeoutError(5000).message).toContain('5000ms');
  });
});

describe('classifyFailure', () => {
  it('honours an upstream Retry-After as the delay', () => {
    const error = new ProviderError({
      provider: 'p',
      message: 'x',
      status: 429,
      retryAfterSeconds: 3,
    });
    expect(classifyFailure(error)).toEqual({ retryable: true, delayMs: 3000 });
  });

  it('marks a terminal ProviderError non-retryable', () => {
    const error = new ProviderError({ provider: 'p', message: 'x', status: 400 });
    expect(classifyFailure(error).retryable).toBe(false);
  });

  it('treats a bare Error as worth one retry', () => {
    expect(classifyFailure(new Error('transport')).retryable).toBe(true);
  });

  it('treats a non-Error as non-retryable', () => {
    expect(classifyFailure('string').retryable).toBe(false);
  });
});

describe('backoffDelay', () => {
  it('stays within the exponential envelope and is capped', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const delay = backoffDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(5000);
    }
  });
});

describe('CircuitBreaker', () => {
  it('opens after the failure threshold and blocks attempts', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.canAttempt('p')).toBe(true);

    for (let i = 0; i < 5; i++) breaker.recordFailure('p');

    expect(breaker.state('p')).toBe('open');
    expect(breaker.canAttempt('p')).toBe(false);
  });

  it('closes again after a success', () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 5; i++) breaker.recordFailure('p');
    breaker.recordSuccess('p');
    expect(breaker.state('p')).toBe('closed');
    expect(breaker.canAttempt('p')).toBe(true);
  });

  it('reports a provider with no history as closed', () => {
    expect(new CircuitBreaker().state('never-seen')).toBe('closed');
  });

  it('reset clears all history', () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 5; i++) breaker.recordFailure('p');
    breaker.reset();
    expect(breaker.state('p')).toBe('closed');
  });
});
