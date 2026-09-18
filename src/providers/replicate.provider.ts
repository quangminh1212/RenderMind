import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  GeneratedImage,
} from '../types/canonical.types';
import type { CapabilityDescriptor, ModelDescriptor } from '../types/capability.types';
import type { ImageProvider } from './provider.interface';
import { ProviderError } from '../engine/errors';
import { logger } from '../utils/logger';

/**
 * Replicate (Flux) provider.
 *
 * Two fixes over the previous implementation, both flagged by the audit:
 *
 *  1. **Model reference.** `POST /v1/predictions` expects a *version hash* in `version:`.
 *     The old code sent an owner/name model id (e.g. `black-forest-labs/flux-schnell`)
 *     there. For name-form models the correct endpoint is
 *     `POST /v1/models/{owner}/{name}/predictions`, which is what we now use. A hash-form
 *     id still goes to `/v1/predictions`.
 *     NOTE: this is corrected by construction against the documented API shape, but has
 *     NOT been verified against a live Replicate token — see docs/providers.md.
 *
 *  2. **Polling.** The old loop slept a fixed 1000ms before every poll and had no
 *     backoff, so it burned ~60 requests per generation. We now poll immediately and
 *     back off, honouring `Retry-After` when Replicate sends it.
 */

/** Flux models accept arbitrary sizes; 8px multiples up to 2048 is a safe superset. */
const FLUX_SIZES = { kind: 'range' as const, min: 64, max: 2048, multiple: 8 };

const MODELS: ModelDescriptor[] = [
  {
    id: 'black-forest-labs/flux-schnell',
    aspectRatios: [],
    sizes: FLUX_SIZES,
    qualityLevels: ['draft', 'standard'],
    outputFormats: ['png', 'webp'],
    costPerImageUsd: 0.003,
  },
  {
    id: 'black-forest-labs/flux-1.1-pro',
    aspectRatios: [],
    sizes: FLUX_SIZES,
    qualityLevels: ['standard', 'high'],
    outputFormats: ['png', 'jpeg', 'webp'],
    costPerImageUsd: 0.04,
  },
];

/** Models that take a step count, and their sane bounds. */
const STEPS_BY_QUALITY: Record<string, number> = {
  draft: 2, // schnell is a 1-4 step distilled model
  standard: 4,
  high: 28, // pro-tier
};

export interface ReplicateProviderConfig {
  apiToken: string;
}

export class ReplicateProvider implements ImageProvider {
  readonly name = 'replicate';
  readonly displayName = 'Replicate (Flux)';

  private readonly apiToken: string;
  private readonly baseUrl = 'https://api.replicate.com/v1';

  constructor(config: ReplicateProviderConfig) {
    this.apiToken = config.apiToken;
  }

  isAvailable(): boolean {
    return this.apiToken.length > 0;
  }

  getCapabilities(): CapabilityDescriptor {
    return {
      provider: this.name,
      displayName: this.displayName,
      models: MODELS,
      features: {
        negativePrompt: true,
        seed: true,
        steps: true,
        guidanceScale: true,
        quality: true,
        style: false,
        batch: false,
        imageToImage: true,
        inpainting: true,
        revisedPrompt: false,
        nativeBase64: false,
        // Replicate returns CDN URLs; the engine inlines them when b64_json is wanted.
        nativeUrl: true,
      },
      limits: {
        maxBatch: 1,
        maxPromptChars: 4000,
        maxReferenceImages: 4,
        timeoutMs: 300000, // pro-tier models can be slow
      },
      concurrency: 2,
      p50LatencyMs: 20000,
      status: this.isAvailable() ? 'available' : 'unavailable',
    };
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const model = request.model ?? 'black-forest-labs/flux-schnell';
    const started = Date.now();

    const prediction = await this.createPrediction(model, request);
    const output = await this.awaitPrediction(prediction.id, model);

    const urls = Array.isArray(output) ? output : [output];
    const images: GeneratedImage[] = urls
      .filter((u): u is string => typeof u === 'string' && u.length > 0)
      .map((url) => ({ url, mime: 'image/png' }));

    if (images.length === 0) {
      throw new ProviderError({
        provider: this.name,
        message: 'Replicate prediction succeeded but produced no output',
        status: 502,
      });
    }

    logger.info('Replicate provider generated images', {
      provider: this.name,
      model,
      count: images.length,
      elapsedMs: Date.now() - started,
    });

    return {
      images,
      provider: this.name,
      model,
      seedUsed: request.seed,
      timings: { queueMs: 0, providerMs: Date.now() - started, totalMs: Date.now() - started },
      cached: false,
      adaptations: {},
    };
  }

  /**
   * Create a prediction on the correct endpoint for the model reference form.
   *
   * Replicate's `/v1/predictions` takes a version *hash*. An `owner/name` model id must
   * instead be posted to `/v1/models/{owner}/{name}/predictions`. Routing by shape is
   * what fixes the old bug where a model name was sent as a version hash.
   */
  private async createPrediction(
    model: string,
    request: ImageGenerationRequest,
  ): Promise<{ id: string }> {
    const isNameForm = model.includes('/');
    const url = isNameForm
      ? `${this.baseUrl}/models/${model}/predictions`
      : `${this.baseUrl}/predictions`;

    const body: Record<string, unknown> = {
      input: this.buildInput(request),
    };
    // Only the hash endpoint takes an explicit `version`.
    if (!isNameForm) body.version = model;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiToken}`,
          // Ask Replicate to wait briefly so fast models skip a poll round-trip.
          Prefer: 'wait=5',
        },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ProviderError({
        provider: this.name,
        message: `Upstream request failed: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }

    if (!response.ok) {
      throw await this.toProviderError(response);
    }

    const created = (await response.json()) as { id?: string };
    if (!created.id) {
      throw new ProviderError({
        provider: this.name,
        message: 'Replicate did not return a prediction id',
        status: 502,
      });
    }

    return { id: created.id };
  }

  private buildInput(request: ImageGenerationRequest): Record<string, unknown> {
    const input: Record<string, unknown> = {
      prompt: request.prompt,
      num_outputs: 1,
    };

    if (request.negativePrompt) input.negative_prompt = request.negativePrompt;
    if (request.size) {
      input.width = request.size.width;
      input.height = request.size.height;
    }
    if (request.aspect) input.aspect_ratio = request.aspect;
    if (request.seed !== undefined) input.seed = request.seed;
    if (request.guidanceScale !== undefined) input.guidance_scale = request.guidanceScale;

    if (request.steps !== undefined) {
      input.num_inference_steps = request.steps;
    } else if (request.quality) {
      const steps = STEPS_BY_QUALITY[request.quality];
      if (steps !== undefined) input.num_inference_steps = steps;
    }

    if (request.output.format) input.output_format = request.output.format;
    if (request.referenceImages?.[0]) {
      input.image = `data:${request.referenceImages[0].mime};base64,${request.referenceImages[0].data}`;
    }

    return input;
  }

  /**
   * Poll until the prediction reaches a terminal state.
   *
   * Polls immediately (the `Prefer: wait` header often means it is already done), then
   * backs off exponentially with jitter, honouring `Retry-After` when present.
   */
  private async awaitPrediction(
    id: string,
    model: string,
    deadlineMs = this.getCapabilities().limits.timeoutMs,
  ): Promise<string | string[]> {
    const deadline = Date.now() + deadlineMs;
    let delay = 250;

    for (;;) {
      const response = await fetch(`${this.baseUrl}/predictions/${id}`, {
        headers: { Authorization: `Bearer ${this.apiToken}` },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw await this.toProviderError(response);
      }

      const prediction = (await response.json()) as {
        status: string;
        output?: string | string[];
        error?: string;
      };

      if (prediction.status === 'succeeded') {
        if (!prediction.output) {
          throw new ProviderError({
            provider: this.name,
            message: 'Replicate succeeded with empty output',
            status: 502,
          });
        }
        return prediction.output;
      }

      if (prediction.status === 'failed' || prediction.status === 'canceled') {
        throw new ProviderError({
          provider: this.name,
          message: `Replicate prediction ${prediction.status}: ${prediction.error ?? 'no detail'}`,
          status: 502,
          code: prediction.status,
        });
      }

      if (Date.now() >= deadline) {
        throw new ProviderError({
          provider: this.name,
          message: `Replicate prediction timed out after ${deadlineMs}ms`,
          status: 504,
          code: 'prediction_timeout',
        });
      }

      const retryAfter = response.headers.get('retry-after');
      const waitMs =
        retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : this.jitter(delay);

      await new Promise((r) => setTimeout(r, Math.min(waitMs, Math.max(0, deadline - Date.now()))));
      delay = Math.min(delay * 2, 5000);
    }
  }

  /** Full jitter, so concurrent polls do not synchronise into a thundering herd. */
  private jitter(baseMs: number): number {
    return Math.floor(baseMs / 2 + Math.random() * (baseMs / 2));
  }

  private async toProviderError(response: Response): Promise<ProviderError> {
    const raw = await response.text().catch(() => '');
    let message = `Replicate error (${response.status})`;
    let code: string | undefined;

    try {
      const parsed = JSON.parse(raw) as { detail?: string; title?: string };
      if (parsed.detail) message = parsed.detail;
      code = parsed.title;
    } catch {
      // Non-JSON body.
    }

    const retryAfter = response.headers.get('retry-after');
    const retryAfterSeconds =
      retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;

    return new ProviderError({
      provider: this.name,
      message,
      status: response.status,
      code,
      retryAfterSeconds,
      upstreamBody: raw.slice(0, 500),
    });
  }
}
