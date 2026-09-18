import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { getEngine } from '../../engine';
import { getConfig } from '../../config';
import {
  NoProviderAvailableError,
  ProviderError,
  UnsupportedCapabilityError,
} from '../../engine/errors';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { randomBytes } from 'crypto';
import type { ImageGenerationRequest } from '../../types/canonical.types';

/**
 * Batch generation.
 *
 * Fixes from the audit:
 *   - Status was computed with a ternary that could not express partial success, so 19
 *     of 20 succeeding was reported as `failed`. Batch status now has its own vocabulary
 *     (`completed | partial | failed`) derived from the counts.
 *   - A throwing item aborted the remaining chunks and silently truncated `results`.
 *   - Concurrency was determined by client input with no global bound, and each item
 *     could itself retry — a 20-prompt batch could issue dozens of concurrent upstream
 *     calls. Chunk size is now clamped by the configured engine concurrency.
 */
const router = Router();

const BatchRequestSchema = z.object({
  prompts: z.array(z.string().min(1).max(4000)).min(1).max(20),
  options: z
    .object({
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      steps: z.number().int().min(1).max(150).optional(),
      cfg_scale: z.number().min(1).max(30).optional(),
      seed: z.number().int().min(0).optional(),
      quality: z.enum(['draft', 'standard', 'high']).optional(),
      response_format: z.enum(['b64_json', 'url']).optional(),
    })
    .optional()
    .default({}),
});

export type BatchStatus = 'completed' | 'partial' | 'failed';

/**
 * Derive the batch status from its counts.
 *
 * Explicit three-way logic rather than a nested ternary: the previous expression's final
 * branch was unreachable by construction, so it read as if it handled a case that no
 * input could reach.
 */
export function deriveBatchStatus(completed: number, failed: number): BatchStatus {
  if (failed === 0 && completed > 0) return 'completed';
  if (completed === 0) return 'failed';
  return 'partial';
}

router.post(
  '/',
  validate(BatchRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof BatchRequestSchema>;
      const { prompts, options } = body;
      const config = getConfig();
      const batchId = `batch_${randomBytes(8).toString('hex')}`;

      // Never let client input exceed the process-wide generation budget.
      const concurrency = Math.max(
        1,
        Math.min(options.steps ? prompts.length : 3, config.engine.maxConcurrency),
      );

      const results: Array<Record<string, unknown>> = [];

      for (let i = 0; i < prompts.length; i += concurrency) {
        const chunk = prompts.slice(i, i + concurrency);

        const settled = await Promise.all(
          chunk.map(async (prompt, offset) => {
            const index = i + offset;
            const request: ImageGenerationRequest = {
              prompt,
              count: 1,
              size: {
                width: options.width ?? 1024,
                height: options.height ?? 1024,
              },
              aspect: null,
              quality: options.quality ?? null,
              steps: options.steps,
              guidanceScale: options.cfg_scale,
              seed: options.seed,
              model: options.model,
              provider: options.provider,
              output: {
                format: 'png',
                delivery: options.response_format === 'url' ? 'url' : 'base64',
              },
              metadata: { source: 'native-batch', batchId },
            };

            try {
              const { result } = await getEngine().generation.generate(request);
              return {
                index,
                prompt,
                status: 'completed' as const,
                images: result.images.map((image) => ({
                  url: image.url,
                  ...(options.response_format !== 'url' && image.base64
                    ? { base64: image.base64 }
                    : {}),
                  mime: image.mime,
                })),
                metadata: {
                  provider: result.provider,
                  model: result.model,
                  generation_time_ms: result.timings.providerMs,
                },
              };
            } catch (error) {
              // Per-item catch: one failure must not abort the remaining chunks.
              const message =
                error instanceof UnsupportedCapabilityError ||
                error instanceof NoProviderAvailableError ||
                error instanceof ProviderError
                  ? error.message
                  : error instanceof Error
                    ? error.message
                    : String(error);

              logger.warn('Batch item failed', { batchId, index, error: message });

              return { index, prompt, status: 'failed' as const, error: message };
            }
          }),
        );

        results.push(...settled);
      }

      const completed = results.filter((r) => r.status === 'completed').length;
      const failed = results.filter((r) => r.status === 'failed').length;

      res.json({
        id: batchId,
        status: deriveBatchStatus(completed, failed),
        total: results.length,
        completed,
        failed,
        results,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof UnsupportedCapabilityError) {
        next(new AppError(error.message, 400, 'unsupported_capability'));
        return;
      }
      if (error instanceof NoProviderAvailableError) {
        next(new AppError(error.message, 503, 'no_provider_configured'));
        return;
      }
      next(error);
    }
  },
);

export default router;
