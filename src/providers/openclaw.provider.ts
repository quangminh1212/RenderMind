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
 * Provider for any endpoint that speaks the openclaw `/images/generations` protocol.
 *
 * Naming note: this project calls this provider `openclaw`. It talks to
 * `POST {baseUrl}/images/generations` — the same protocol openclaw's image API exposes —
 * and is used for api.openai.com, Azure openclaw, LM Studio, LocalAI, or a self-hosted
 * image service. See docs/providers.md.
 *
 * Capability fidelity: the previous implementation silently rewrote the caller's
 * requested size to the nearest DALL·E 3 bucket. Here the supported sizes are *declared*
 * in the descriptor and the matcher records any substitution, so the caller is told.
 */

/** DALL·E 3 accepts only these three discrete sizes. */
const DALLE3_SIZES = [
  { width: 1024, height: 1024 },
  { width: 1024, height: 1792 },
  { width: 1792, height: 1024 },
];

/** DALL·E 2 accepts squares and one landscape/portrait pair. */
const DALLE2_SIZES = [
  { width: 256, height: 256 },
  { width: 512, height: 512 },
  { width: 1024, height: 1024 },
  { width: 1024, height: 1792 },
  { width: 1792, height: 1024 },
];

/** gpt-image-1 accepts these three. */
const GPT_IMAGE_SIZES = [
  { width: 1024, height: 1024 },
  { width: 1024, height: 1536 },
  { width: 1536, height: 1024 },
];

/**
 * Model families we know enough about to declare exact capabilities for.
 *
 * Extends ModelDescriptor, so the `id` field comes from there rather than being
 * redeclared (which TypeScript rejects as a duplicate).
 */
interface KnownModel extends ModelDescriptor {
  /** Whether this model rejects an explicit `n` greater than 1. */
  singleImageOnly: boolean;
}

const KNOWN_MODELS: Record<string, KnownModel> = {
  'dall-e-3': {
    id: 'dall-e-3',
    aspectRatios: ['1:1', '16:9', '9:16'],
    sizes: { kind: 'discrete', sizes: DALLE3_SIZES },
    qualityLevels: ['standard', 'high'],
    outputFormats: ['png', 'jpeg'],
    costPerImageUsd: 0.04,
    singleImageOnly: true,
  },
  'dall-e-2': {
    id: 'dall-e-2',
    aspectRatios: ['1:1'],
    sizes: { kind: 'discrete', sizes: DALLE2_SIZES },
    qualityLevels: ['standard'],
    outputFormats: ['png'],
    costPerImageUsd: 0.02,
    singleImageOnly: false,
  },
  'gpt-image-1': {
    id: 'gpt-image-1',
    aspectRatios: ['1:1', '3:2', '2:3'],
    sizes: { kind: 'discrete', sizes: GPT_IMAGE_SIZES },
    qualityLevels: ['draft', 'standard', 'high'],
    outputFormats: ['png', 'jpeg', 'webp'],
    costPerImageUsd: 0.04,
    singleImageOnly: false,
  },
};

export interface OpenclawProviderConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  /** Additional model ids the endpoint accepts, beyond the known set. */
  extraModels?: string[];
}

export class OpenclawProvider implements ImageProvider {
  readonly name = 'openclaw';
  readonly displayName = 'openclaw-compatible image API';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly extraModels: string[];

  constructor(config: OpenclawProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.defaultModel = config.defaultModel;
    this.extraModels = config.extraModels ?? [];
  }

  isAvailable(): boolean {
    // A base URL without a key previously advertised as "available", was picked by the
    // matcher, and then 401'd upstream. Requiring the key makes the failure honest.
    return this.apiKey.length > 0;
  }

  getCapabilities(): CapabilityDescriptor {
    const models: ModelDescriptor[] = [
      ...Object.values(KNOWN_MODELS).map(({ singleImageOnly: _s, ...model }) => model),
      // Unknown models on an openclaw-compatible endpoint are assumed to accept
      // arbitrary sizes, so we must not constrain them to DALL·E's buckets.
      ...this.extraModels
        .filter((id) => !KNOWN_MODELS[id])
        .map((id) => ({
          id,
          aspectRatios: [],
          sizes: { kind: 'range' as const, min: 64, max: 4096, multiple: 8 },
          qualityLevels: [],
          outputFormats: ['png' as const],
        })),
    ];

    return {
      provider: this.name,
      displayName: this.displayName,
      models,
      features: {
        negativePrompt: false, // folded into the prompt, not native
        seed: true,
        steps: false,
        guidanceScale: false,
        quality: true,
        style: true,
        batch: false,
        imageToImage: true,
        inpainting: false,
        revisedPrompt: true,
        nativeBase64: true,
        nativeUrl: true,
      },
      limits: {
        maxBatch: 10,
        maxPromptChars: 32000,
        maxReferenceImages: 1,
        timeoutMs: 120000,
      },
      concurrency: 8,
      p50LatencyMs: 12000,
      status: this.isAvailable() ? 'available' : 'unavailable',
    };
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const model = request.model ?? this.defaultModel;
    const started = Date.now();

    const payload = this.buildPayload(request, model);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(this.getCapabilities().limits.timeoutMs),
        body: JSON.stringify(payload),
      });
    } catch (error) {
      // A transport failure has no status: treat as retryable.
      throw new ProviderError({
        provider: this.name,
        message: `Upstream request failed: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }

    if (!response.ok) {
      throw await this.toProviderError(response);
    }

    const body = (await response.json()) as {
      data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
      created?: number;
    };

    const items = body.data ?? [];
    if (items.length === 0) {
      throw new ProviderError({
        provider: this.name,
        message: 'Upstream returned no image data',
        // A well-formed 200 with no images is an upstream defect, not the caller's.
        status: 502,
      });
    }

    const images: GeneratedImage[] = items.map((item) => ({
      base64: item.b64_json,
      url: item.url,
      mime: 'image/png',
      revisedPrompt: item.revised_prompt,
    }));

    logger.info('openclaw provider generated images', {
      provider: this.name,
      model,
      count: images.length,
      elapsedMs: Date.now() - started,
    });

    return {
      images,
      provider: this.name,
      model,
      timings: { queueMs: 0, providerMs: Date.now() - started, totalMs: Date.now() - started },
      cached: false,
      adaptations: {},
    };
  }

  /** Translate a canonical request into this provider's wire format. */
  private buildPayload(request: ImageGenerationRequest, model: string): Record<string, unknown> {
    const known = KNOWN_MODELS[model];

    // Negative prompts have no native field here, so they are folded into the prompt
    // text. The matcher already treats this provider as negativePrompt:false, so the
    // engine will not believe a negative prompt was honoured.
    const prompt = request.negativePrompt
      ? `${request.prompt}\n\nAvoid: ${request.negativePrompt}`
      : request.prompt;

    const payload: Record<string, unknown> = { model, prompt };

    if (known) {
      // Known models take a discrete size string.
      payload.n = known.singleImageOnly ? 1 : request.count;
      payload.size = this.resolveSizeString(request, known);
      if (request.quality) {
        payload.quality = request.quality === 'high' ? 'hd' : 'standard';
      }
      if (request.style) payload.style = request.style;
      // gpt-image-1 always returns base64 and rejects response_format.
      if (model !== 'gpt-image-1') payload.response_format = 'b64_json';
    } else {
      // Unknown openclaw-compatible models: pass explicit dimensions.
      payload.n = request.count;
      if (request.size) {
        payload.width = request.size.width;
        payload.height = request.size.height;
      }
      payload.response_format = 'b64_json';
    }

    return payload;
  }

  /** Map the request onto one of the model's allowed size strings. */
  private resolveSizeString(request: ImageGenerationRequest, model: KnownModel): string {
    const sizes = model.sizes.kind === 'discrete' ? model.sizes.sizes : DALLE3_SIZES;
    if (request.size) {
      const exact = sizes.find(
        (s) => s.width === request.size!.width && s.height === request.size!.height,
      );
      if (exact) return `${exact.width}x${exact.height}`;
    }
    const first = sizes[0];
    return `${first.width}x${first.height}`;
  }

  /**
   * Convert a non-2xx response into a typed ProviderError that preserves the upstream
   * status, error code and Retry-After, so the engine can retry correctly and the
   * adapter can report an honest status instead of a blanket 502.
   */
  private async toProviderError(response: Response): Promise<ProviderError> {
    const raw = await response.text().catch(() => '');

    let code: string | undefined;
    let message = `Upstream error (${response.status})`;

    try {
      const parsed = JSON.parse(raw) as {
        error?: { message?: string; code?: string; type?: string };
      };
      if (parsed.error) {
        code = parsed.error.code ?? parsed.error.type;
        if (parsed.error.message) message = parsed.error.message;
      }
    } catch {
      // Non-JSON body: keep the generic message rather than leaking raw upstream text.
    }

    // Retry-After may be seconds or an HTTP date; we only honour the numeric form.
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
