import type {
  AppliedAdaptations,
  GeneratedImage,
  ImageGenerationRequest,
  ImageGenerationResult,
} from '../types/canonical.types';
import type { GenerationPlan } from '../types/capability.types';
import type { ProviderRegistry, ProviderStrategy } from '../providers/provider.registry';
import { allowsProvider } from '../providers/provider.registry';
import type { ImageProvider } from '../providers/provider.interface';
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

/**
 * Distinct compositional directions for a fan-out.
 *
 * Why this exists: `count: 3` used to mean three calls with the same prompt, and the chat
 * provider declares `seed: false` — it cannot send a seed upstream at all, so the "vary the
 * seed" branch below was a no-op and three callers got three copies of one drawing. A
 * seed the provider cannot honour is not variation; it is the appearance of it.
 *
 * Stating the intended difference in words is what a text model can actually act on. The
 * directions are deliberately distinct *kinds* of change — composition, mood, palette,
 * viewpoint, scale, lighting — rather than three paraphrases of one idea, because asking for
 * "a slightly different version" reliably yields the same picture again.
 *
 * A pinned seed still varies the prompt. The seed cannot be honoured and the caller asked
 * for N images; returning N identical results would be a worse answer than returning N that
 * differ. The engine discloses the fan-out in `AppliedAdaptations` either way.
 */
const VARIATION_DIRECTIONS = [
  'Emphasize a different composition and framing than the other variants.',
  'Take a different approach to mood, colour palette and lighting than the other variants.',
  'Choose a distinctly different viewpoint, angle and level of detail than the other variants.',
  'Vary the scale and density of the elements, and the arrangement of the background.',
  'Explore a different visual style and rendering technique for the same subject.',
  'Reframe the subject with different negative space and a different sense of depth.',
];

/**
 * Prefix a prompt with a distinct direction for one sub-job of a fan-out.
 *
 * A single request is left byte-identical: there is nothing to distinguish it from, and
 * rewriting the prompt would change the behaviour of the overwhelmingly common case.
 *
 * @param prompt the caller's prompt, unchanged for `count === 1`
 * @param index  zero-based sub-job index
 * @param count  the caller's requested image count
 */
export function varyPrompt(prompt: string, index: number, count: number): string {
  if (count <= 1) return prompt;

  const direction = VARIATION_DIRECTIONS[index % VARIATION_DIRECTIONS.length];
  return `Variant ${index + 1} of ${count}. ${direction}\n\nSubject: ${prompt}`;
}

/** Wall-clock ceiling for a single sub-job across every attempt in its plan. */

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
  /**
   * Which provider class this deployment is willing to route to.
   *
   * Held here rather than baked into the registry so the registry stays a plain container
   * and the routing policy is visible at the one place that resolves a plan.
   */
  private readonly strategy: ProviderStrategy;

  constructor(
    registry: ProviderRegistry,
    options: GenerationServiceOptions & { strategy?: ProviderStrategy },
  ) {
    this.registry = registry;
    this.semaphore = new Semaphore(options.maxConcurrency);
    this.strategy = options.strategy ?? 'auto';
  }

  /** Expose queue depth for readiness/observability. */
  get queueStats(): { available: number; queued: number } {
    return this.semaphore.stats;
  }

  /**
   * Providers this deployment is willing and able to route to.
   *
   * The one place that answers "who can serve a request at all", so the readiness probe,
   * the empty-registry check and the plan resolution cannot disagree about it.
   */
  routableProviders(): ImageProvider[] {
    return this.registry
      .available()
      .filter((provider) => allowsProvider(this.strategy, provider.name));
  }

  /**
   * Generate one or more images for a canonical request.
   *
   * Resolves the plan once, then fans out `count` sub-jobs across the plan's attempts
   * respecting the global concurrency cap.
   */
  async generate(request: ImageGenerationRequest): Promise<GenerationOutcome> {
    const startTime = Date.now();

    // "Routable" is not the same as "available": a provider may be perfectly healthy but
    // forbidden by PROVIDER_STRATEGY, and reporting it as configured would advertise a
    // service whose every generation fails with a capability gap.
    if (this.routableProviders().length === 0) {
      throw new NoProviderAvailableError();
    }

    // Breakers take providers out of rotation before a call is wasted on them.
    //
    // The strategy filter is applied to the *descriptors* rather than here, so that
    // "which providers may serve this request" is answered in one place and the matcher
    // keeps its pure (request × descriptors) contract.
    const registered = this.registry.capabilityDescriptors(this.strategy);
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

    // ── Fan out, or ask for the batch natively ─────────────────
    // One sub-job per requested image is only correct for a provider that cannot take a
    // batch. The winner is known here, so honouring its declaration is what makes
    // `features.batch: true` mean something: a native endpoint receiving `n: 3` produces
    // three images in one call, whereas fanning out would make three calls and defeat the
    // capability the matcher just selected it for.
    const winnerDescriptor = descriptors.find((d) => d.provider === winner.provider);
    const nativeBatch = winnerDescriptor?.features.batch === true;

    const subJobs = nativeBatch ? [0] : Array.from({ length: request.count }, (_, index) => index);

    // How many images the *request* wants, which is both the variation base for a fan-out
    // and the `n` a native batch is asked for.
    //
    // Kept separate from `producedByThisJob` on purpose: a fan-out sub-job produces one
    // image but must still be told it is variant 2 of 3, or every sub-job computes the same
    // "variant 1 of 1" prompt and the distinct-direction machinery silently collapses into
    // three identical requests. That regression is exactly what a batch-variation test
    // exists to catch, and passing the per-job count here would reintroduce it.
    // Native image APIs already create distinct samples from one `n` request. The
    // language-model-only fan-out needs the variation prefix, but an image model would
    // otherwise be asked to draw the words "Variant 1 of N" into the picture.
    const variationBase = nativeBatch ? 1 : request.count;

    const settled = await Promise.all(
      subJobs.map((index) =>
        this.runSubJob(request, plan, index, nativeBatch ? request.count : 1, variationBase),
      ),
    );

    const images: GeneratedImage[] = settled.flatMap((s) => s.images);
    const anyCached = settled.some((s) => s.cached);
    const providerMs = Date.now() - startTime;

    // The provider that actually served the request, which may not be the plan's first
    // attempt: a terminal failure fails over to a later attempt, and reporting the
    // winner's name would tell the caller the wrong provider produced the image.
    const served = settled[0] ?? { provider: winner.provider, model: winner.model };

    // Honour the requested delivery format, inlining URLs when base64 was asked for.
    const materialized = await materializeImages(images, request, served.provider);

    const adaptations: AppliedAdaptations = { ...plan.adaptations };
    if (adaptations.fannedOutFromCount && request.count > 1) {
      // Disclosed honestly. The previous note claimed a distinct seed guaranteed variation,
      // which was untrue for an upstream that cannot accept a seed at all — the images came
      // back identical and the caller was told they would differ.
      adaptations.notes = [
        ...(adaptations.notes ?? []),
        request.seed === undefined
          ? 'each image was asked for with a distinct compositional direction to ' +
            'guarantee variation'
          : 'each image was asked for with a distinct compositional direction; the pinned ' +
            'seed was varied per image because the upstream cannot honour a seed',
      ];
    }

    return {
      result: {
        images: materialized,
        provider: served.provider,
        model: served.model,
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
    producedByThisJob: number,
    variationBase: number,
  ): Promise<{ images: GeneratedImage[]; cached: boolean; provider: string; model: string }> {
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
      // A plan attempt for a provider the strategy forbids should be unreachable — the
      // descriptors were already filtered — but resolving it through the same predicate
      // keeps the two from drifting if a plan is ever built from unfiltered descriptors.
      if (!provider || !allowsProvider(this.strategy, provider.name)) continue;

      // How many images this attempt should ask for, and how the prompt is varied.
      //
      // `producedByThisJob` is the `n` sent upstream: 1 per fan-out sub-job, or the whole
      // count for a native batch. `variationBase` is how many variants exist in total, and
      // is what makes each fan-out sub-job a *different* request; it is 1 for a native
      // batch, which is why the batch's prompt is left alone — an image model handed
      // "Variant 1 of 3. Emphasize a different composition…" draws the words.
      const subRequest: ImageGenerationRequest = {
        ...request,
        count: producedByThisJob,
        provider: attempt.provider,
        model: attempt.model,
        // Vary the seed only when the caller did not pin one, so an explicit seed
        // remains reproducible.
        seed: request.seed === undefined ? undefined : request.seed + index,
        prompt: varyPrompt(request.prompt, index, variationBase),
      };

      // Bounded retry of this provider, then fail over to the next plan attempt.
      for (let tryIndex = 0; tryIndex < MAX_ATTEMPTS_PER_PROVIDER; tryIndex++) {
        const release = await this.semaphore.acquire();
        try {
          const result = await provider.generate(subRequest);
          circuitBreaker.recordSuccess(attempt.provider);
          return {
            images: result.images,
            cached: result.cached,
            provider: attempt.provider,
            model: attempt.model,
          };
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
