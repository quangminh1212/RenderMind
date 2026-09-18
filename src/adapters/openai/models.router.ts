import { Router, Request, Response } from 'express';
import { getEngine } from '../../engine';

/**
 * `GET /v1/models` — model discovery.
 *
 * openclaw-compatible tooling (LiteLLM, Open WebUI, Continue) probes this endpoint to
 * enumerate available models. Its absence meant those clients received the native 404
 * body and failed to enumerate anything.
 *
 * The data comes from the capability descriptors, so this endpoint cannot drift from
 * what the engine will actually route to.
 */
const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const descriptors = getEngine().registry.capabilityDescriptors();

  const data = descriptors.flatMap((descriptor) =>
    descriptor.models.map((model) => ({
      id: model.id,
      object: 'model' as const,
      created: 0,
      owned_by: descriptor.provider,
      // Non-standard but useful, and ignored by tolerant clients.
      provider: descriptor.provider,
    })),
  );

  res.json({ object: 'list', data });
});

export default router;
