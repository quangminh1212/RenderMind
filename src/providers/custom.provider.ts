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
 * Generic HTTP provider for user-supplied image endpoints.
 *
 * Wired up from the `CUSTOM_BACKENDS` env var. The audit found this class implemented
 * but never instantiated — `CUSTOM_BACKENDS` appeared nowhere in `src/`, while the
 * README advertised it as a working backend. It is now reachable.
 *
 * Fixes over the previous implementation:
 *  - Throws when the response contains no extractable image, instead of returning a
 *    `completed` result with no pixels, which the caller could not detect.
 *  - Sends a typed ProviderError so upstream status survives to the client.
 *  - Declares its capabilities, so the matcher can route to it deliberately.
 */

export interface CustomProviderConfig {
  /** Stable name, used as the client-facing `backend` value. */
  name: string;
  /** Endpoint that accepts a POST with the generation payload. */
  url: string;
  /** Optional bearer token. */
  apiKey?: string;
  headers?: Record<string, string>;
  /** Model ids this endpoint accepts. */
  models?: string[];
  /** Optional JSON template with {{placeholders}}, for non-standard payloads. */
  bodyTemplate?: string;
}

export class CustomProvider implements ImageProvider {
  readonly name: string;
  readonly displayName: string;

  private readonly config: CustomProviderConfig;

  constructor(config: CustomProviderConfig) {
    this.name = config.name;
    this.displayName = `${config.name} (custom HTTP)`;
    this.config = config;
  }

  isAvailable(): boolean {
    return Boolean(this.config.url);
  }

  getCapabilities(): CapabilityDescriptor {
    const models: ModelDescriptor[] = (this.config.models ?? ['custom']).map((id) => ({
      id,
      aspectRatios: [],
      // A custom endpoint's constraints are unknown; assume it accepts what we send.
      sizes: { kind: 'range' as const, min: 64, max: 4096, multiple: 8 },
      qualityLevels: [],
      outputFormats: ['png' as const],
    }));

    return {
      provider: this.name,
      displayName: this.displayName,
      models,
      features: {
        negativePrompt: true,
        seed: true,
        steps: true,
        guidanceScale: true,
        quality: false,
        style: false,
        batch: false,
        imageToImage: true,
        inpainting: false,
        revisedPrompt: false,
        nativeBase64: true,
        nativeUrl: true,
      },
      limits: {
        maxBatch: 1,
        maxPromptChars: 4000,
        maxReferenceImages: 1,
        timeoutMs: 120000,
      },
      concurrency: 4,
      status: this.isAvailable() ? 'available' : 'unavailable',
    };
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const started = Date.now();
    const model = request.model ?? this.config.models?.[0] ?? 'custom';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

    const payload = this.config.bodyTemplate
      ? this.renderTemplate(this.config.bodyTemplate, request, model)
      : this.buildDefaultPayload(request, model);

    let response: Response;
    try {
      response = await fetch(this.config.url, {
        method: 'POST',
        headers,
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
      const raw = await response.text().catch(() => '');
      const retryAfter = response.headers.get('retry-after');
      throw new ProviderError({
        provider: this.name,
        message: `Custom backend error (${response.status})`,
        status: response.status,
        retryAfterSeconds: retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined,
        upstreamBody: raw.slice(0, 500),
      });
    }

    const data = (await response.json()) as {
      image_url?: string;
      image_base64?: string;
      output?: string;
      images?: Array<{ url?: string; base64?: string; b64_json?: string }>;
      data?: Array<{ url?: string; b64_json?: string }>;
    };

    const images = this.extractImages(data);

    // Previously this returned a `completed` result with no image at all.
    if (images.length === 0) {
      throw new ProviderError({
        provider: this.name,
        message: 'Custom backend returned no recognizable image payload',
        status: 502,
        code: 'no_image_in_response',
      });
    }

    logger.info('Custom provider generated images', {
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

  /** Recognise the common shapes a custom image service might return. */
  private extractImages(data: {
    image_url?: string;
    image_base64?: string;
    output?: string;
    images?: Array<{ url?: string; base64?: string; b64_json?: string }>;
    data?: Array<{ url?: string; b64_json?: string }>;
  }): GeneratedImage[] {
    const images: GeneratedImage[] = [];

    if (data.image_base64) images.push({ base64: data.image_base64, mime: 'image/png' });
    if (data.image_url) images.push({ url: data.image_url, mime: 'image/png' });
    if (data.output) images.push({ url: data.output, mime: 'image/png' });

    for (const item of data.images ?? []) {
      const base64 = item.base64 ?? item.b64_json;
      if (base64) images.push({ base64, mime: 'image/png' });
      else if (item.url) images.push({ url: item.url, mime: 'image/png' });
    }

    for (const item of data.data ?? []) {
      if (item.b64_json) images.push({ base64: item.b64_json, mime: 'image/png' });
      else if (item.url) images.push({ url: item.url, mime: 'image/png' });
    }

    return images;
  }

  private buildDefaultPayload(
    request: ImageGenerationRequest,
    model: string,
  ): Record<string, unknown> {
    return {
      prompt: request.prompt,
      negative_prompt: request.negativePrompt,
      width: request.size?.width,
      height: request.size?.height,
      steps: request.steps,
      cfg_scale: request.guidanceScale,
      seed: request.seed,
      model,
      n: request.count,
    };
  }

  /** Substitute {{placeholders}} in a user-supplied body template. */
  private renderTemplate(
    template: string,
    request: ImageGenerationRequest,
    model: string,
  ): unknown {
    const values: Record<string, string> = {
      prompt: request.prompt,
      negative_prompt: request.negativePrompt ?? '',
      width: String(request.size?.width ?? 1024),
      height: String(request.size?.height ?? 1024),
      steps: String(request.steps ?? 30),
      cfg_scale: String(request.guidanceScale ?? 7.5),
      seed: String(request.seed ?? ''),
      model,
      n: String(request.count),
    };

    const rendered = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
      // JSON-escape so a prompt containing quotes cannot break the payload.
      JSON.stringify(values[key] ?? '').slice(1, -1),
    );

    return JSON.parse(rendered);
  }
}
