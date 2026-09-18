import { Router, Request, Response } from 'express';
import { getEngine } from '../../engine';
import { getConfig } from '../../config';
import { circuitBreaker } from '../../platform/http.client';

/**
 * Provider discovery for the native API.
 *
 * Reports what the engine can actually route to, derived from the same capability
 * descriptors the matcher uses — so this endpoint cannot claim a provider exists that
 * routing would not select.
 */
const router = Router();

/**
 * @openapi
 * /api/v1/backends:
 *   get:
 *     tags: [Info]
 *     summary: List configured image providers and their capabilities
 *     responses:
 *       200:
 *         description: Provider list with capabilities
 */
router.get('/', (_req: Request, res: Response) => {
  const config = getConfig();
  const descriptors = getEngine().registry.capabilityDescriptors();

  res.json({
    providers: descriptors.map((descriptor) => ({
      name: descriptor.provider,
      display_name: descriptor.displayName,
      status: descriptor.status,
      circuit_breaker: circuitBreaker.state(descriptor.provider),
      models: descriptor.models.map((model) => model.id),
      features: descriptor.features,
      limits: descriptor.limits,
      concurrency: descriptor.concurrency,
    })),
    count: descriptors.length,
    // Retained for clients written against the original response shape.
    backends: descriptors.map((descriptor) => ({
      name: descriptor.provider,
      display_name: descriptor.displayName,
      status: descriptor.status === 'available' ? 'available' : 'unavailable',
      models: descriptor.models.map((model) => model.id),
    })),
    config: {
      // Whether the compatibility bridges are enabled, and in which mode.
      anthropic_image_block_mode: config.protocols.anthropicImageBlockMode,
      openai_response_metadata: config.protocols.openaiResponseMetadata,
    },
  });
});

export default router;
