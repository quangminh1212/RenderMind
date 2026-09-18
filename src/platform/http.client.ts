import { ProviderError } from '../engine/errors';
import { logger } from '../utils/logger';

/**
 * Circuit breaker states.
 *
 * The audit found the old retry loop hammering a single backend with a fixed delay,
 * retrying even terminal 4xx errors. A breaker lets a failing provider be skipped
 * *before* a call is attempted, which is what connects resilience to routing: an open
 * breaker makes the provider report `unavailable` and the matcher routes around it.
 */
export type BreakerState = 'closed' | 'open' | 'half-open';

interface BreakerRecord {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
  /** Half-open probe in flight, to avoid stampeding on recovery. */
  probing: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
};

/** Consecutive failures before a provider is taken out of rotation. */
const FAILURE_THRESHOLD = 5;
/** How long a breaker stays open before a single probe is allowed. */
const OPEN_DURATION_MS = 30_000;

/**
 * Per-provider circuit breaker.
 *
 * Deliberately in-memory: it protects a single process, which is the unit that actually
 * issues upstream calls. A shared breaker would need shared state and is out of scope.
 */
export class CircuitBreaker {
  private readonly records = new Map<string, BreakerRecord>();

  private record(provider: string): BreakerRecord {
    let rec = this.records.get(provider);
    if (!rec) {
      rec = { state: 'closed', consecutiveFailures: 0, openedAt: 0, probing: false };
      this.records.set(provider, rec);
    }
    return rec;
  }

  /** Whether a call to `provider` may be attempted right now. */
  canAttempt(provider: string): boolean {
    const rec = this.record(provider);

    if (rec.state === 'closed') return true;

    if (rec.state === 'open') {
      if (Date.now() - rec.openedAt >= OPEN_DURATION_MS) {
        // Time to probe. Only one probe at a time.
        if (rec.probing) return false;
        rec.state = 'half-open';
        rec.probing = true;
        return true;
      }
      return false;
    }

    // half-open: the in-flight probe owns the slot.
    return false;
  }

  recordSuccess(provider: string): void {
    const rec = this.record(provider);
    rec.state = 'closed';
    rec.consecutiveFailures = 0;
    rec.probing = false;
    rec.openedAt = 0;
  }

  recordFailure(provider: string): void {
    const rec = this.record(provider);
    rec.probing = false;
    rec.consecutiveFailures++;

    if (rec.state === 'half-open' || rec.consecutiveFailures >= FAILURE_THRESHOLD) {
      if (rec.state !== 'open') {
        logger.warn('Circuit breaker opened', {
          provider,
          consecutiveFailures: rec.consecutiveFailures,
        });
      }
      rec.state = 'open';
      rec.openedAt = Date.now();
    }
  }

  state(provider: string): BreakerState {
    const rec = this.records.get(provider);
    if (!rec) return 'closed';
    // Report an expired open breaker as half-open so callers see the pending probe.
    if (rec.state === 'open' && Date.now() - rec.openedAt >= OPEN_DURATION_MS) {
      return 'half-open';
    }
    return rec.state;
  }

  reset(): void {
    this.records.clear();
  }
}

export const circuitBreaker = new CircuitBreaker();

/** Whether a failure should be retried, and how long to wait. */
export function classifyFailure(error: unknown): {
  retryable: boolean;
  delayMs: number;
} {
  if (error instanceof ProviderError) {
    // Respect an upstream Retry-After over our own backoff.
    if (error.retryAfterSeconds !== undefined) {
      return { retryable: error.retryable, delayMs: error.retryAfterSeconds * 1000 };
    }
    return { retryable: error.retryable, delayMs: 0 };
  }

  // A non-ProviderError reaching here is a bug or a transport failure; both are
  // worth one retry, but the delay is computed by the caller.
  if (error instanceof Error) return { retryable: true, delayMs: 0 };

  return { retryable: false, delayMs: 0 };
}

/**
 * Full-jitter backoff.
 *
 * Full jitter (uniform in [base/2, base]) is preferred over equal jitter here because
 * it decorrelates concurrent retries most effectively — the failure mode we most want
 * to avoid is N parallel n>1 sub-jobs retrying in lockstep.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): number {
  const exponential = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
}

/** Sleep helper that cannot outlive the supplied deadline. */
export function sleep(ms: number, deadline?: number): Promise<void> {
  const capped = deadline === undefined ? ms : Math.max(0, Math.min(ms, deadline - Date.now()));
  return new Promise((resolve) => setTimeout(resolve, capped));
}

export { DEFAULT_RETRY, FAILURE_THRESHOLD, OPEN_DURATION_MS };
