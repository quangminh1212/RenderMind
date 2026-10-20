import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CircuitBreaker,
  classifyFailure,
  backoffDelay,
  sleep,
  DEFAULT_RETRY,
  FAILURE_THRESHOLD,
  OPEN_DURATION_MS,
} from '../../../src/platform/http.client';
import { ProviderError } from '../../../src/engine/errors';

/**
 * HTTP client resilience tests.
 *
 * Covers the circuit breaker state machine, failure classification,
 * backoff delay bounds, and the sleep helper.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── CircuitBreaker ─────────────────────────────────────────

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker();
  });

  it('starts in closed state and allows attempts', () => {
    expect(breaker.canAttempt('provider-a')).toBe(true);
    expect(breaker.state('provider-a')).toBe('closed');
  });

  it('opens after FAILURE_THRESHOLD consecutive failures', () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure('p');
    }

    expect(breaker.state('p')).toBe('open');
    expect(breaker.canAttempt('p')).toBe(false);
  });

  it('opens immediately on failure from half-open state', () => {
    // Push to open
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure('p');
    }
    // Wait for open duration to elapse so we can probe
    vi.advanceTimersByTime(OPEN_DURATION_MS + 1);
    expect(breaker.canAttempt('p')).toBe(true); // transitions to half-open

    // Fail the probe
    breaker.recordFailure('p');
    expect(breaker.state('p')).toBe('open');
    expect(breaker.canAttempt('p')).toBe(false);
  });

  it('closes on success after half-open probe', () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure('p');
    }

    vi.advanceTimersByTime(OPEN_DURATION_MS + 1);
    expect(breaker.canAttempt('p')).toBe(true); // half-open

    breaker.recordSuccess('p');
    expect(breaker.state('p')).toBe('closed');
    expect(breaker.canAttempt('p')).toBe(true);
  });

  it('resets failure count on success', () => {
    // Record some failures, but below threshold
    for (let i = 0; i < 3; i++) {
      breaker.recordFailure('p');
    }
    breaker.recordSuccess('p');

    // The remaining failures should not trigger open
    for (let i = 0; i < 3; i++) {
      breaker.recordFailure('p');
    }
    // 3 failures after a reset: below threshold, so still closed
    expect(breaker.state('p')).toBe('closed');
  });

  it('allows only one probe in half-open state', () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure('p');
    }

    vi.advanceTimersByTime(OPEN_DURATION_MS + 1);
    expect(breaker.canAttempt('p')).toBe(true); // first probe
    expect(breaker.canAttempt('p')).toBe(false); // second is blocked
  });

  it('reports half-open state when open duration expires', () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure('p');
    }

    vi.advanceTimersByTime(OPEN_DURATION_MS + 1);
    expect(breaker.state('p')).toBe('half-open');
  });

  it('clears all records on reset()', () => {
    breaker.recordFailure('p1');
    breaker.recordFailure('p2');
    breaker.reset();

    expect(breaker.state('p1')).toBe('closed');
    expect(breaker.state('p2')).toBe('closed');
    expect(breaker.canAttempt('p1')).toBe(true);
  });

  it('tracks providers independently', () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      breaker.recordFailure('failing');
    }

    expect(breaker.state('failing')).toBe('open');
    expect(breaker.state('healthy')).toBe('closed');
    expect(breaker.canAttempt('healthy')).toBe(true);
  });

  it('returns closed for unknown providers', () => {
    expect(breaker.state('nonexistent')).toBe('closed');
  });
});

// ─── classifyFailure ────────────────────────────────────────

describe('classifyFailure', () => {
  it('respects Retry-After from a ProviderError', () => {
    const error = new ProviderError({
      provider: 'test',
      message: 'rate limited',
      status: 429,
      retryAfterSeconds: 30,
    });

    const result = classifyFailure(error);
    expect(result.retryable).toBe(true);
    expect(result.delayMs).toBe(30_000);
  });

  it('marks terminal (non-retryable) errors correctly', () => {
    const error = new ProviderError({
      provider: 'test',
      message: 'bad request',
      status: 400,
      retryable: false,
    });

    const result = classifyFailure(error);
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBe(0);
  });

  it('treats a retryable ProviderError without Retry-After as zero-delay', () => {
    const error = new ProviderError({
      provider: 'test',
      message: 'server error',
      status: 500,
    });

    const result = classifyFailure(error);
    expect(result.retryable).toBe(true);
    expect(result.delayMs).toBe(0);
  });

  it('treats a bare Error as retryable', () => {
    const result = classifyFailure(new Error('ECONNREFUSED'));
    expect(result.retryable).toBe(true);
    expect(result.delayMs).toBe(0);
  });

  it('treats a non-Error value as non-retryable', () => {
    const result = classifyFailure('string error');
    expect(result.retryable).toBe(false);
    expect(result.delayMs).toBe(0);
  });
});

// ─── backoffDelay ───────────────────────────────────────────

describe('backoffDelay', () => {
  it('stays within bounds for attempt 0', () => {
    const policy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 };
    for (let i = 0; i < 50; i++) {
      const delay = backoffDelay(0, policy);
      // Full jitter: [base/2, base] = [500, 1000]
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });

  it('scales exponentially with attempt number', () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10000 };
    // Attempt 0: exponential = min(100 * 2^0, 10000) = 100 => jitter [50, 100]
    // Attempt 2: exponential = min(100 * 2^2, 10000) = 400 => jitter [200, 400]
    const delay0 = backoffDelay(0, policy);
    const delay2 = backoffDelay(2, policy);
    expect(delay2).toBeGreaterThanOrEqual(delay0);
  });

  it('caps at maxDelayMs', () => {
    const policy = { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 500 };
    for (let i = 0; i < 100; i++) {
      const delay = backoffDelay(20, policy);
      // exponential = min(100 * 2^20, 500) = 500 => jitter [250, 500]
      expect(delay).toBeLessThanOrEqual(500);
    }
  });

  it('uses DEFAULT_RETRY policy when none is provided', () => {
    const delay = backoffDelay(0);
    // DEFAULT_RETRY: baseDelayMs=500 => jitter [250, 500]
    expect(delay).toBeGreaterThanOrEqual(250);
    expect(delay).toBeLessThanOrEqual(500);
  });
});

// ─── sleep ──────────────────────────────────────────────────

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    let resolved = false;
    sleep(1000).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(true);
  });

  it('caps to deadline when provided', async () => {
    const start = Date.now();
    const deadline = start + 500;

    let resolved = false;
    sleep(5000, deadline).then(() => {
      resolved = true;
    });

    vi.advanceTimersByTime(500);
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(true);
  });

  it('resolves immediately when deadline is in the past', async () => {
    const start = Date.now();
    const deadline = start - 100;

    let resolved = false;
    sleep(1000, deadline).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(resolved).toBe(true);
  });
});

// ─── constants ──────────────────────────────────────────────

describe('exported constants', () => {
  it('DEFAULT_RETRY has sensible values', () => {
    expect(DEFAULT_RETRY.maxAttempts).toBe(3);
    expect(DEFAULT_RETRY.baseDelayMs).toBe(500);
    expect(DEFAULT_RETRY.maxDelayMs).toBe(5000);
  });

  it('FAILURE_THRESHOLD is defined', () => {
    expect(FAILURE_THRESHOLD).toBe(5);
  });

  it('OPEN_DURATION_MS is defined', () => {
    expect(OPEN_DURATION_MS).toBe(30_000);
  });
});
