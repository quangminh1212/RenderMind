import { ImageGenerationOptions, ImageGenerationResult } from '../types/backend.types';
import { GenerateRequest, GenerateResponse, BackendInfo } from '../types/api.types';
import { BaseBackend } from './backends/base.backend';
import { StabilityBackend } from './backends/stability.backend';
import { OpenAIBackend } from './backends/openclaw.backend';
import { ReplicateBackend } from './backends/replicate.backend';
import { cacheService } from './cache.service';
import { webhookService } from './webhook.service';
import { getConfig } from '../config';
import { generateId } from '../utils/idGenerator';
import { buildCacheKey } from '../utils/imageUtils';
import { logger } from '../utils/logger';

const GENERATION_STORE_PREFIX = 'gen:';
const GENERATION_STORE_TTL = 86400; // 24 hours

export class BackendService {
  private backends: Map<string, BaseBackend> = new Map();

  constructor() {
    this.initBackends();
  }

  private initBackends(): void {
    const config = getConfig();

    if (config.backends.stability.enabled) {
      this.backends.set(
        'stability',
        new StabilityBackend(config.backends.stability.apiKey, config.backends.stability.apiHost),
      );
    }

    if (config.backends.openclaw.enabled) {
      this.backends.set('openclaw', new OpenAIBackend(config.backends.openclaw.apiKey));
    }

    if (config.backends.replicate.enabled) {
      this.backends.set('replicate', new ReplicateBackend(config.backends.replicate.apiToken));
    }

    logger.info(`Initialized ${this.backends.size} backend(s)`, {
      backends: Array.from(this.backends.keys()),
    });
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const id = generateId('gen');
    const startTime = Date.now();

    // Check cache (include model in key to avoid collisions)
    const cacheKey = buildCacheKey(
      request.prompt,
      request.width,
      request.height,
      request.backend,
      request.seed,
      request.model,
    );

    const cached = await cacheService.get<GenerateResponse>(cacheKey);
    if (cached) {
      logger.info('Cache hit', { id, cacheKey: cacheKey.substring(0, 40) });
      return { ...cached, id, metadata: { ...cached.metadata!, cached: true } };
    }

    // Select backend
    const backend = this.selectBackend(request.backend, request.model);
    if (!backend) {
      const errorResponse: GenerateResponse = {
        id,
        status: 'failed',
        error: `No available backend for "${request.backend}". Configure at least one backend API key.`,
        created_at: new Date().toISOString(),
      };
      await this.storeGeneration(id, errorResponse);
      return errorResponse;
    }

    // Store pending
    const pendingResponse: GenerateResponse = {
      id,
      status: 'processing',
      created_at: new Date().toISOString(),
    };
    await this.storeGeneration(id, pendingResponse);

    // Generate with retry
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          logger.info('Retrying generation', { id, attempt, backend: backend.name });
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }

        const options: ImageGenerationOptions = {
          prompt: request.prompt,
          negative_prompt: request.negative_prompt,
          width: request.width,
          height: request.height,
          steps: request.steps,
          cfg_scale: request.cfg_scale,
          seed: request.seed,
          model: request.model,
        };

        const result = await backend.generate(options);
        const generationTime = Date.now() - startTime;

        const response: GenerateResponse = {
          id,
          status: 'completed',
          image_url: result.image_url,
          image_base64: result.image_base64,
          metadata: {
            ...result.metadata,
            generation_time_ms: generationTime,
          },
          created_at: new Date().toISOString(),
        };

        await this.storeGeneration(id, response);
        await cacheService.set(cacheKey, response);

        if (request.webhook_url) {
          webhookService.deliver(request.webhook_url, response).catch(() => {});
        }

        logger.info('Generation completed', {
          id,
          backend: backend.name,
          time_ms: generationTime,
          attempt: attempt + 1,
        });

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn('Generation attempt failed', {
          id,
          attempt: attempt + 1,
          error: lastError.message,
        });
      }
    }

    // All retries exhausted
    const errorResponse: GenerateResponse = {
      id,
      status: 'failed',
      error: 'Generation failed after multiple attempts',
      created_at: new Date().toISOString(),
    };

    await this.storeGeneration(id, errorResponse);

    if (request.webhook_url) {
      webhookService.deliver(request.webhook_url, errorResponse).catch(() => {});
    }

    logger.error('Generation failed permanently', {
      id,
      backend: backend.name,
      error: lastError?.message,
    });

    return errorResponse;
  }

  async getStatus(id: string): Promise<GenerateResponse | null> {
    return cacheService.get<GenerateResponse>(`${GENERATION_STORE_PREFIX}${id}`);
  }

  getBackends(): BackendInfo[] {
    const backends: BackendInfo[] = [
      {
        name: 'stability',
        display_name: 'Stable Diffusion',
        status: this.backends.has('stability') ? 'available' : 'unavailable',
        models: ['stable-diffusion-xl-1024-v1-0', 'stable-diffusion-v1-6'],
      },
      {
        name: 'openclaw',
        display_name: 'DALL-E 3',
        status: this.backends.has('openclaw') ? 'available' : 'unavailable',
        models: ['dall-e-3'],
      },
      {
        name: 'replicate',
        display_name: 'Flux (Replicate)',
        status: this.backends.has('replicate') ? 'available' : 'unavailable',
        models: ['black-forest-labs/flux-1.1-pro', 'black-forest-labs/flux-schnell'],
      },
    ];

    return backends;
  }

  private async storeGeneration(id: string, data: GenerateResponse): Promise<void> {
    await cacheService.set(`${GENERATION_STORE_PREFIX}${id}`, data, GENERATION_STORE_TTL);
  }

  private selectBackend(preferred: string, model?: string): BaseBackend | null {
    if (preferred !== 'auto') {
      return this.backends.get(preferred) || null;
    }

    const priority = ['stability', 'openclaw', 'replicate'];
    for (const name of priority) {
      const backend = this.backends.get(name);
      if (backend && backend.isAvailable()) {
        return backend;
      }
    }

    return null;
  }
}

export const backendService = new BackendService();
