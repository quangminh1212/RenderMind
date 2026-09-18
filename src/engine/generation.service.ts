import type {
  AppliedAdaptations,
  GeneratedImage,
  ImageGenerationRequest,
  ImageGenerationResult,
} from '../types/canonical.types';
import type { GenerationPlan } from '../types/capability.types';
import type { ProviderRegistry } from '../providers/provider.registry';
import { buildPlan } from './capability.matcher';
import { materializeImages } from '../platform/artifact.store';
import {
  AllProvidersUnavailableError,
  NoProviderAvailableError,
  ProviderError,
  UnsupportedCapabilityError,
} from './errors';
import { backoffDelay, circuitBreaker, classifyFailure, sleep } from '../platform/http.client';
import { logger } from '../utils/logger';

/**
 * Generation orchestration.
 *
 * Owns the path from a canonical request to a completed result:
 *   plan → dispatch (with bounded concurrency) → adapt → materialize → disclose.
 *
 * Failover is *plan-driven*: the matcher emits an ordered list of attempts, and this
 * service walks it. That is deliberately different from the previous behaviour, which
 * picked one backend and retried the same one three times with a fixed delay —
 * including on terminal 4xx errors that could never succeed.
 */

export interface GenerationOutcome {
  result: ImageGenerationResult;
  plan: GenerationPlan;
}

export interface GenerationServiceOptions {
  /** Global cap on concurrent upstream calls, across all requests. */
  maxConcurrency: number;
}

/** How many times a single provider is tried before failing over to the next attempt. */
const MAX_ATTEMPTS_PER_PROVIDER = 2;

/** Upper bound on a retry wait, so an upstream Retry-After cannot stall a request. */
const MAX_RETRY_WAIT_MS = 5000;

/**
 * Wall-clock ceiling for a single sub-job across every attempt in its plan.
 *
 * Without this, a provider that keeps returning a retryable failure with a Retry-After
 * can hold a request open far longer than any caller would tolerate — with 3 plan
 * attempts, each retried, each honouring a 5s Retry-After, a request could stall for
 * ~30s before reporting a failure that was knowable much earlier. Once the deadline
 * passes, remaining attempts are abandoned and the last real error is reported.
 */
const SUB_JOB_DEADLINE_MS = 20000;

/** A simple counting semaphore, so total in-flight calls stay bounded. */
export class Semaphore {
  private available: number;
  private readonly waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }

    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      // Hand the permit directly to the next waiter.
      next();
      return;
    }
    this.available++;
  }

  /** Diagnostics for /health and tests. */
  get stats(): { available: number; queued: number } {
    return { available: this.available, queued: this.waiting.length };
  }
}

export class GenerationService {
  private readonly semaphore: Semaphore;
  private readonly registry: ProviderRegistry;

  constructor(registry: ProviderRegistry, options: GenerationServiceOptions) {
    this.registry = registry;
    this.semaphore = new Semaphore(options.maxConcurrency);
  }

  /** Expose queue depth for readiness/observability. */
  get queueStats(): { available: number; queued: number } {
    return this.semaphore.stats;
  }

  /**
   * Generate one or more images for a canonical request.
   *
   * Resolves the plan once, then fans out `count` sub-jobs across the plan's attempts
   * respecting the global concurrency cap.
   */
  async generate(request: ImageGenerationRequest): Promise<GenerationOutcome> {
    const startTime = Date.now();

    if (this.registry.available().length === 0) {
      throw new NoProviderAvailableError();
    }

    // Breakers take providers out of rotation before a call is wasted on them.
    const registered = this.registry.capabilityDescriptors();
    const descriptors = registered.map((d) => ({
      ...d,
      status: circuitBreaker.canAttempt(d.provider) ? d.status : ('unavailable' as const),
    }));

    // Distinguish "nothing configured can serve this" (a capability gap, 400) from
    // "every provider is currently tripped" (a transient upstream outage, 503).
    // Collapsing the two produced a misleading generic failure once breakers opened.
    if (registered.length > 0 && descriptors.every((d) => d.status === 'unavailable')) {
      throw new AllProvidersUnavailableError(registered.map((d) => d.provider));
    }

    const plan = buildPlan(request, descriptors);
    const winner = plan.attempts[0];

    logger.info('Generation plan resolved', {
      provider: winner.provider,
      model: winner.model,
      count: request.count,
      failoverDepth: plan.attempts.length,
      adaptations: Object.keys(plan.adaptations),
    });

    const provider = this.registry.get(winner.provider);
    if (!provider) {
      throw new NoProviderAvailableError(`Provider "${winner.provider}" is no longer registered`);
    }

    // ── Fan out ────────────────────────────────────────────────
    // Distinct seeds per sub-job when the caller did not pin one, so n>1 produces
    // n *different* images rather than the same image n times (the old behaviour).
    const subJobs = Array.from({ length: request.count }, (_, index) => index);

    const settled = await Promise.all(subJobs.map((index) => this.runSubJob(request, plan, index)));

    const images: GeneratedImage[] = settled.flatMap((s) => s.images);
    const anyCached = settled.some((s) => s.cached);
    const providerMs = Date.now() - startTime;

    // Honour the requested delivery format, inlining URLs when base64 was asked for.
    const materialized = await materializeImages(images, request, winner.provider);

    const adaptations: AppliedAdaptations = { ...plan.adaptations };
    if (adaptations.fannedOutFromCount && request.count > 1 && !request.seed) {
      adaptations.notes = [
        ...(adaptations.notes ?? []),
        'each image used a distinct seed to guarantee variation',
      ];
    }

    return {
      result: {
        images: materialized,
        provider: winner.provider,
        model: winner.model,
        seedUsed: request.seed,
        timings: { queueMs: 0, providerMs, totalMs: Date.now() - startTime },
        cached: anyCached,
        adaptations,
      },
      plan,
    };
  }

  /**
   * Run a single image through the plan's attempts, with per-attempt retry.
   *
   * Walks the plan on terminal failure so a dead provider fails over rather than
   * failing the whole request.
   */
  private async runSubJob(
    request: ImageGenerationRequest,
    plan: GenerationPlan,
    index: number,
  ): Promise<{ images: GeneratedImage[]; cached: boolean }> {
    let lastError: unknown;
    const deadline = Date.now() + SUB_JOB_DEADLINE_MS;

    for (const attempt of plan.attempts) {
      // Stop burning attempts once the sub-job has run out of time.
      if (Date.now() >= deadline) {
        logger.warn('Sub-job deadline reached; abandoning remaining attempts', {
          provider: attempt.provider,
        });
        break;
      }

      if (!circuitBreaker.canAttempt(attempt.provider)) {
        logger.warn('Skipping attempt: circuit breaker open', { provider: attempt.provider });
        continue;
      }

      const provider = this.registry.get(attempt.provider);
      if (!provider) continue;

      // One sub-job produces exactly one image; the fan-out supplies the count.
      const subRequest: ImageGenerationRequest = {
        ...request,
        count: 1,
        provider: attempt.provider,
        model: attempt.model,
        // Vary the seed only when the caller did not pin one, so an explicit seed
        // remains reproducible.
        seed: request.seed === undefined ? undefined : request.seed + index,
      };

      // Bounded retry of this provider, then fail over to the next plan attempt.
      for (let tryIndex = 0; tryIndex < MAX_ATTEMPTS_PER_PROVIDER; tryIndex++) {
        const release = await this.semaphore.acquire();
        try {
          const result = await provider.generate(subRequest);
          circuitBreaker.recordSuccess(attempt.provider);
          return { images: result.images, cached: result.cached };
        } catch (error) {
          lastError = error;
          const { retryable, delayMs } = classifyFailure(error);

          circuitBreaker.recordFailure(attempt.provider);

          logger.warn('Generation attempt failed', {
            provider: attempt.provider,
            tryIndex,
            retryable,
            status: error instanceof ProviderError ? error.status : undefined,
            error: error instanceof Error ? error.message : String(error),
          });

          // Terminal failures (4xx) belong to the caller and cannot succeed on retry,
          // so move straight to the next attempt in the plan rather than burning quota.
          if (!retryable) break;

          // An upstream Retry-After can be arbitrarily large; cap the wait so a request
          // is never held open indefinitely for a single provider, and never sleep past
          // the sub-job's own deadline.
          const budget = Math.max(0, deadline - Date.now());
          const waitMs = Math.min(delayMs || backoffDelay(tryIndex), MAX_RETRY_WAIT_MS, budget);
          if (waitMs > 0) await sleep(waitMs);
        } finally {
          release();
        }
      }
    }

    // Every attempt failed. Report honestly rather than returning fewer images.
    throw lastError instanceof Error
      ? lastError
      : new ProviderError({
          provider: plan.attempts[0]?.provider ?? 'unknown',
          message: 'All generation attempts failed',
        });
  }
}

export { UnsupportedCapabilityError };
