import { Router, Request, Response, NextFunction } from 'express';
import { generationRepository } from '../../engine/generation.repository';
import { AppError } from '../../middleware/errorHandler';

/**
 * Generation status lookup.
 *
 * Backed by the generation repository, which keeps an in-memory tier as well as Redis.
 * The previous implementation read only from Redis while Redis was an optional
 * dependency, so with Redis absent, generation returned a completed image inline and
 * this endpoint then 404'd for the very id it had just returned.
 */
const router = Router();

/**
 * @openapi
 * /api/v1/status/{id}:
 *   get:
 *     tags: [Generation]
 *     summary: Get the status of a previous generation
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Generation record
 *       404:
 *         description: Generation not found
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const record = await generationRepository.get(req.params.id);

    if (!record) {
      throw new AppError('Generation not found', 404, 'not_found');
    }

    res.json({
      id: record.id,
      status: record.state,
      provider: record.provider,
      model: record.model,
      images: record.images.map((image) => ({
        url: image.url,
        mime: image.mime,
        ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
      })),
      errors: record.errors,
      ...(record.adaptations && Object.keys(record.adaptations).length > 0
        ? { adaptations: record.adaptations }
        : {}),
      ...(record.webhook ? { webhook: record.webhook } : {}),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
