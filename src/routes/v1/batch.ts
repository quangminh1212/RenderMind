import { Router, Request, Response, NextFunction } from 'express';
import { BatchRequestSchema, BatchResponse, GenerateResponse } from '../../types/api.types';
import { backendService } from '../../services/backend.service';
import { validate } from '../../middleware/validate';
import { generateId } from '../../utils/idGenerator';

const router = Router();

/**
 * @openapi
 * /api/v1/batch:
 *   post:
 *     tags: [Generation]
 *     summary: Generate multiple images in parallel
 *     description: Submit multiple prompts for parallel image generation
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [prompts]
 *             properties:
 *               prompts:
 *                 type: array
 *                 items:
 *                   type: string
 *                 minItems: 1
 *                 maxItems: 20
 *                 description: Array of text prompts (1-20)
 *               options:
 *                 type: object
 *                 properties:
 *                   width:
 *                     type: integer
 *                     default: 1024
 *                   height:
 *                     type: integer
 *                     default: 1024
 *                   backend:
 *                     type: string
 *                     default: auto
 *                   parallel:
 *                     type: integer
 *                     minimum: 1
 *                     maximum: 10
 *                     default: 3
 *     responses:
 *       200:
 *         description: Batch generation started
 *       400:
 *         description: Validation error
 */
router.post(
  '/',
  validate(BatchRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { prompts, options } = req.body;
      const batchId = generateId('batch');

      const results: GenerateResponse[] = [];
      const parallel = options.parallel || 3;

      // Process in chunks
      for (let i = 0; i < prompts.length; i += parallel) {
        const chunk = prompts.slice(i, i + parallel);
        const chunkResults = await Promise.all(
          chunk.map((prompt: string) =>
            backendService.generate({
              prompt,
              width: options.width,
              height: options.height,
              backend: options.backend,
              steps: options.steps,
              cfg_scale: options.cfg_scale,
              seed: options.seed,
            }),
          ),
        );
        results.push(...chunkResults);
      }

      const completed = results.filter((r) => r.status === 'completed').length;
      const failed = results.filter((r) => r.status === 'failed').length;

      const response: BatchResponse = {
        id: batchId,
        status: completed === results.length ? 'completed' : failed > 0 ? 'failed' : 'completed',
        total: results.length,
        completed,
        failed,
        results,
        created_at: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
