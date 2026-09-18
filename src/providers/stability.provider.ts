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
 * Stability AI (Stable Diffusion) provider.
 *
 * Stability's SDXL endpoints accept arbitrary width/height in multiples of 64, so the
 * descriptor declares a `range` rather than discrete sizes — the matcher can then accept
 * most caller sizes verbatim instead of substituting them.
 */

/** SDXL models accept 64..2048 in multiples of 64. */
const SDXL_SIZES = { kind: 'range' as const, min: 64, max: 2048, multiple: 64 };

const MODELS: ModelDescriptor[] = [
  {
    id: 'stable-diffusion-xl-1024-v1-0',
    aspectRatios: [],
    sizes: SDXL_SIZES,
    qualityLevels: ['draft', 'standard', 'high'],
    outputFormats: ['png', 'jpeg', 'webp'],
    costPerImageUsd: 0.004,
  },
  {
    id: 'stable-diffusion-v1-6',
    aspectRatios: [],
    sizes: { kind: 'range', min: 64, max: 1024, multiple: 64 },
    qualityLevels: ['draft', 'standard', 'high'],
    outputFormats: ['png'],
    costPerImageUsd: 0.002,
  },
  {
    id: 'stable-image-ultra-v1',
    aspectRatios: [],
    sizes: SDXL_SIZES,
    qualityLevels: ['standard', 'high'],
    outputFormats: ['png', 'jpeg', 'webp'],
    costPerImageUsd: 0.08,
  },
];

/** Step counts implied by each quality level, for models that take explicit steps. */
const STEPS_BY_QUALITY: Record<string, number> = {
  draft: 20,
  standard: 30,
  high: 50,
};

export interface StabilityProviderConfig {
  apiKey: string;
  apiHost?: string;
}

export class StabilityProvider implements ImageProvider {
  readonly name = 'stability';
  readonly displayName = 'Stability AI (Stable Diffusion)';

  private readonly apiKey: string;
  private readonly apiHost: string;

  constructor(config: StabilityProviderConfig) {
    this.apiKey = config.apiKey;
    this.apiHost = (config.apiHost ?? 'https://api.stability.ai').replace(/\/+$/, '');
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  getCapabilities(): CapabilityDescriptor {
    return {
      provider: this.name,
      displayName: this.displayName,
      models: MODELS,
      features: {
        negativePrompt: true, // native: a text prompt with negative weight
        seed: true,
        steps: true,
        guidanceScale: true,
        quality: true,
        style: false,
        batch: false,
        imageToImage: true,
        inpainting: true,
        revisedPrompt: false,
        nativeBase64: true,
        nativeUrl: false,
      },
      limits: {
        maxBatch: 10,
        maxPromptChars: 2000,
        maxNegativePromptChars: 2000,
        maxReferenceImages: 1,
        timeoutMs: 90000,
      },
      concurrency: 4,
      p50LatencyMs: 6000,
      status: this.isAvailable() ? 'available' : 'unavailable',
    };
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const model = request.model ?? 'stable-diffusion-xl-1024-v1-0';
    const started = Date.now();

    const width = request.size?.width ?? 1024;
    const height = request.size?.height ?? 1024;
    const seed = request.seed ?? Math.floor(Math.random() * 4294967295);

    const payload: Record<string, unknown> = {
      text_prompts: [
        { text: request.prompt, weight: 1 },
        ...(request.negativePrompt ? [{ text: request.negativePrompt, weight: -1 }] : []),
      ],
      cfg_scale: request.guidanceScale ?? 7.5,
      width,
      height,
      steps: request.steps ?? STEPS_BY_QUALITY[request.quality ?? 'standard'] ?? 30,
      seed,
      samples: request.count,
    };

    let response: Response;
    try {
      response = await fetch(`${this.apiHost}/v1/generation/${model}/text-to-image`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(this.getCapabilities().limits.timeoutMs),
        body: JSON.stringify(payload),
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

    const data = (await response.json()) as { artifacts?: Array<{ base64: string }> };
    const artifacts = data.artifacts ?? [];

    if (artifacts.length === 0) {
      throw new ProviderError({
        provider: this.name,
        message: 'Stability returned no image artifacts',
        status: 502,
      });
    }

    const images: GeneratedImage[] = artifacts.map((a) => ({
      base64: a.base64,
      mime: 'image/png',
      width,
      height,
    }));

    logger.info('Stability provider generated images', {
      provider: this.name,
      model,
      count: images.length,
      elapsedMs: Date.now() - started,
    });

    return {
      images,
      provider: this.name,
      model,
      seedUsed: seed,
      timings: { queueMs: 0, providerMs: Date.now() - started, totalMs: Date.now() - started },
      cached: false,
      adaptations: {},
    };
  }

  private async toProviderError(response: Response): Promise<ProviderError> {
    const raw = await response.text().catch(() => '');
    let message = `Stability error (${response.status})`;
    let code: string | undefined;

    try {
      const parsed = JSON.parse(raw) as { message?: string; name?: string; id?: string };
      if (parsed.message) message = parsed.message;
      code = parsed.name ?? parsed.id;
    } catch {
      // Non-JSON body; keep the generic message.
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
