import { Router, Request, Response, NextFunction } from 'express';
import { getEngine } from '../../engine';

import { generationRepository, type GenerationState } from '../../engine/generation.repository';
import {
  AllProvidersUnavailableError,
  NoProviderAvailableError,
  ProviderError,
  UnsupportedCapabilityError,
} from '../../engine/errors';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import type { ImageGenerationRequest } from '../../types/canonical.types';

/**
 * RenderMind's native generation endpoint.
 *
 * This is the fully-featured surface: unlike the protocol bridges it exposes provider
 * selection, generation hints (steps, guidance) and asynchronous callbacks.
 */
const router = Router();

/**
 * @openapi
 * /api/v1/generate:
 *   post:
 *     tags: [Generation]
 *     summary: Generate images from a text prompt
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [prompt]
 *             properties:
 *               prompt: { type: string }
 *               negative_prompt: { type: string }
 *               width: { type: integer, default: 1024 }
 *               height: { type: integer, default: 1024 }
 *               count: { type: integer, default: 1, maximum: 10 }
 *               provider: { type: string }
 *               model: { type: string }
 *               seed: { type: integer }
 *               steps: { type: integer }
 *               cfg_scale: { type: number }
 *               response_format: { type: string, enum: [b64_json, url] }
 *               webhook_url: { type: string, format: uri }
 *     responses:
 *       200:
 *         description: Images generated
 *       400:
 *         description: Invalid request or unsupported capability
 *       502:
 *         description: Upstream provider failure
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Record<string, unknown>;

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      throw new AppError('prompt is required', 400, 'invalid_request_error');
    }

    const count = clampInt(body.count ?? body.n ?? 1, 1, 10);
    const width = clampInt(body.width ?? 1024, 64, 4096);
    const height = clampInt(body.height ?? 1024, 64, 4096);

    const request: ImageGenerationRequest = {
      prompt,
      negativePrompt: typeof body.negative_prompt === 'string' ? body.negative_prompt : undefined,
      count,
      size: { width, height },
      aspect: null,
      quality: null,
      steps: typeof body.steps === 'number' ? body.steps : undefined,
      guidanceScale: typeof body.cfg_scale === 'number' ? body.cfg_scale : undefined,
      seed: typeof body.seed === 'number' ? body.seed : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      style: typeof body.style === 'string' ? body.style : undefined,
      output: {
        format: 'png',
        delivery: body.response_format === 'url' ? 'url' : 'base64',
      },
      callbackUrl: typeof body.webhook_url === 'string' ? body.webhook_url : undefined,
      metadata: { source: 'native' },
    };

    const { result } = await getEngine().generation.generate(request);

    // Record the result so GET /api/v1/status/:id works. The previous implementation
    // wrote a 'processing' value that no code path ever updated, so the endpoint could
    // only ever report a terminal state or 404.
    const id = req.generationId ?? `gen_${Date.now().toString(36)}`;
    const state: GenerationState = result.images.length > 0 ? 'succeeded' : 'failed';

    await generationRepository.create({
      id,
      state,
      request: { prompt, count, provider: request.provider, model: result.model },
      images: result.images.map((image) => ({
        url: image.url,
        base64: image.base64,
        mime: image.mime,
        revisedPrompt: image.revisedPrompt,
      })),
      errors: [],
      provider: result.provider,
      model: result.model,
      adaptations: result.adaptations as Record<string, unknown>,
      attempts: 1,
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: 0,
    });

    res.json({
      id,
      status: state,
      images: result.images.map((image) => ({
        url: image.url,
        // Only inline base64 when the caller asked for it, to avoid multi-MB responses.
        ...(request.output.delivery === 'base64' && image.base64 ? { base64: image.base64 } : {}),
        mime: image.mime,
        ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
      })),
      // Backwards-compatible single-image fields for existing clients.
      image_url: result.images[0]?.url,
      image_base64: request.output.delivery === 'base64' ? result.images[0]?.base64 : undefined,
      metadata: {
        provider: result.provider,
        model: result.model,
        generation_time_ms: result.timings.providerMs,
        cached: result.cached,
        ...(Object.keys(result.adaptations).length > 0 ? { adaptations: result.adaptations } : {}),
      },
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    next(toHttpError(error));
  }
});

/** Convert an engine error into an AppError whose status reflects the real cause. */
function toHttpError(error: unknown): Error {
  if (error instanceof UnsupportedCapabilityError) {
    logger.warn('Unsupported capability requested', { details: error.details });
    return new AppError(error.message, 400, 'unsupported_capability');
  }

  if (error instanceof NoProviderAvailableError) {
    return new AppError(error.message, 503, 'no_provider_configured');
  }

  if (error instanceof AllProvidersUnavailableError) {
    return new AppError(error.message, 503, 'all_providers_unavailable');
  }

  if (error instanceof ProviderError) {
    const status = error.isClientError ? 400 : error.status === 504 ? 504 : 502;
    return new AppError(error.message, status, error.code ?? 'provider_error');
  }

  return error instanceof Error ? error : new Error(String(error));
}

function clampInt(value: unknown, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export default router;
