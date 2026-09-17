import { Router, Request, Response, NextFunction } from 'express';
import { backendService } from '../../services/backend.service';
import { AppError } from '../../middleware/errorHandler';

const router = Router();

/**
 * @openapi
 * /api/v1/status/{id}:
 *   get:
 *     tags: [Generation]
 *     summary: Get generation status
 *     description: Check the status of an image generation request
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Generation ID
 *     responses:
 *       200:
 *         description: Generation status
 *       404:
 *         description: Generation not found
 */
router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const result = backendService.getStatus(id);

    if (!result) {
      throw new AppError('Generation not found', 404);
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
