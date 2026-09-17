import { Router, Request, Response, NextFunction } from 'express';
import { GenerateRequestSchema } from '../../types/api.types';
import { backendService } from '../../services/backend.service';
import { validate } from '../../middleware/validate';

const router = Router();

/**
 * @openapi
 * /api/v1/generate:
 *   post:
 *     tags: [Generation]
 *     summary: Generate a single image
 *     description: Generate an image from a text prompt using a selected or auto-detected backend
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [prompt]
 *             properties:
 *               prompt:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 4000
 *                 description: Text prompt for image generation
 *                 example: "A futuristic city at sunset, cyberpunk style"
 *               negative_prompt:
 *                 type: string
 *                 maxLength: 4000
 *                 description: Things to avoid in the image
 *               width:
 *                 type: integer
 *                 minimum: 64
 *                 maximum: 4096
 *                 default: 1024
 *               height:
 *                 type: integer
 *                 minimum: 64
 *                 maximum: 4096
 *                 default: 1024
 *               backend:
 *                 type: string
 *                 enum: [auto, stability, openai, replicate, custom]
 *                 default: auto
 *               steps:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 150
 *                 default: 30
 *               cfg_scale:
 *                 type: number
 *                 minimum: 1
 *                 maximum: 30
 *                 default: 7.5
 *               seed:
 *                 type: integer
 *                 minimum: 0
 *                 description: Random seed for reproducibility
 *               webhook_url:
 *                 type: string
 *                 format: uri
 *                 description: URL to receive webhook on completion
 *               model:
 *                 type: string
 *                 description: Specific model to use within the backend
 *     responses:
 *       200:
 *         description: Image generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GenerateResponse'
 *       400:
 *         description: Validation error
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal server error
 */
router.post('/', validate(GenerateRequestSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await backendService.generate(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
