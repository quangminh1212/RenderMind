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

// In-memory store for generation results (production: use Redis)
const generationStore = new Map<string, GenerateResponse>();

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

    logger.info(`Initialized ${this.backends.size} backend(s)`);
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const id = generateId('gen');
    const startTime = Date.now();

    // Check cache
    const cacheKey = buildCacheKey(
      request.prompt,
      request.width,
      request.height,
      request.backend,
      request.seed,
    );

    const cached = await cacheService.get<GenerateResponse>(cacheKey);
    if (cached) {
      logger.info(`Cache hit for ${id}`);
      return { ...cached, id, metadata: { ...cached.metadata!, cached: true } };
    }

    // Select backend
    const backend = this.selectBackend(request.backend, request.model);
    if (!backend) {
      const errorResponse: GenerateResponse = {
        id,
        status: 'failed',
        error: `No available backend for "${request.backend}"`,
        created_at: new Date().toISOString(),
      };
      generationStore.set(id, errorResponse);
      return errorResponse;
    }

    // Store pending
    const pendingResponse: GenerateResponse = {
      id,
      status: 'processing',
      created_at: new Date().toISOString(),
    };
    generationStore.set(id, pendingResponse);

    try {
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

      // Update store
      generationStore.set(id, response);

      // Cache the result
      await cacheService.set(cacheKey, response);

      // Deliver webhook if URL provided
      if (request.webhook_url) {
        webhookService.deliver(request.webhook_url, response);
      }

      return response;
    } catch (error) {
      const errorResponse: GenerateResponse = {
        id,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        created_at: new Date().toISOString(),
      };

      generationStore.set(id, errorResponse);

      if (request.webhook_url) {
        webhookService.deliver(request.webhook_url, errorResponse);
      }

      return errorResponse;
    }
  }

  getStatus(id: string): GenerateResponse | null {
    return generationStore.get(id) || null;
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

  private selectBackend(
    preferred: string,
    model?: string,
  ): BaseBackend | null {
    // If specific backend requested
    if (preferred !== 'auto') {
      return this.backends.get(preferred) || null;
    }

    // Auto-select: first available by priority
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
