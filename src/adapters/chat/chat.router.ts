import { Router, Request, Response } from 'express';
import { getEngine } from '../../engine';
import { getConfig } from '../../config';
import { toChatResponse, toChatError } from '../../utils/formatAdapters';
import {
  AllProvidersUnavailableError,
  NoProviderAvailableError,
  ProviderError,
  UnsupportedCapabilityError,
} from '../../engine/errors';
import {
  ChatRequestSchema,
  VisionRequestSchema,
  translateChatRequest,
  type ChatRequest,
  type VisionRequest,
} from './schemas';
import { logger } from '../../utils/logger';

/**
 * The two public image endpoints.
 *
 * `/chat`   — a text prompt becomes an image.
 * `/vision` — a text prompt plus input images becomes an image.
 *
 * Both are thin: validate, translate to canonical, hand to the engine, format the
 * result. All routing, failover, retry and capability negotiation live in the engine, so
 * the two surfaces cannot drift apart in behaviour.
 *
 * Error mapping is shared with the previous surface (`sendGenerationError`) so a caller
 * gets the same status for the same cause regardless of which endpoint they used.
 */

const router = Router();

/** Build the shared handler for one surface. */
function handler(options: { withImages: boolean }) {
  return async (req: Request, res: Response): Promise<void> => {
    const schema = options.withImages ? VisionRequestSchema : ChatRequestSchema;
    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      const first = parsed.error.errors[0];
      res
        .status(400)
        .json(
          toChatError(
            parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
            400,
            first?.path.join('.') ?? null,
            'invalid_request_error',
          ),
        );
      return;
    }

    const translated = translateChatRequest(parsed.data as ChatRequest | VisionRequest, options);
    if (!translated.ok) {
      res
        .status(400)
        .json(toChatError(translated.message, 400, translated.param, 'invalid_request_error'));
      return;
    }

    try {
      const { result } = await getEngine().generation.generate(translated.request);

      res.json(
        toChatResponse(result, {
          delivery: translated.request.output.delivery,
          created: Math.floor(Date.now() / 1000),
          generationId: req.generationId ?? 'gen_unknown',
          includeMetadata: getConfig().protocols.openaiResponseMetadata,
        }),
      );
    } catch (error) {
      sendGenerationError(res, error, req);
    }
  };
}

/**
 * Map an engine failure onto this surface's error envelope.
 *
 * A capability gap is the caller's mistake (400). An unreachable upstream is a 502.
 * Every configured provider tripped is a transient 503. Conflating these was the class
 * of bug the engine was built to avoid, so the mapping is explicit rather than a range
 * check.
 */
export function sendGenerationError(res: Response, error: unknown, req?: Request): void {
  const requestId = req?.headers['x-request-id'] as string | undefined;

  if (error instanceof UnsupportedCapabilityError) {
    res.status(400).json(toChatError(error.message, 400, null, 'unsupported_capability'));
    return;
  }

  if (error instanceof NoProviderAvailableError) {
    res.status(503).json(toChatError(error.message, 503, null, 'no_provider_configured'));
    return;
  }

  if (error instanceof AllProvidersUnavailableError) {
    res.setHeader('Retry-After', '30');
    res.status(503).json(toChatError(error.message, 503, null, 'all_providers_unavailable'));
    return;
  }

  if (error instanceof ProviderError) {
    // A model that answered with text has not produced an image and never will on retry,
    // so it is reported as a distinct, actionable failure rather than a generic 502.
    const status =
      error.code === 'unsupported_output'
        ? 422
        : error.status === 429
          ? 429
          : error.isClientError
            ? 400
            : error.status === 504
              ? 504
              : 502;

    if (error.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
    }

    logger.warn('Generation error surfaced to client', {
      requestId,
      provider: error.provider,
      upstreamStatus: error.status,
      code: error.code,
    });

    res.status(status).json(toChatError(error.message, status, null, error.code));
    return;
  }

  logger.error('Unexpected error in generation endpoint', {
    requestId,
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json(toChatError('An unexpected error occurred', 500, null, 'server_error'));
}

/**
 * @openapi
 * /chat:
 *   post:
 *     tags: [Generation]
 *     summary: Generate an image from a text prompt using a chat-completions model
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [prompt]
 *             properties:
 *               prompt: { type: string }
 *               size: { type: string, example: "1024x1024" }
 *               count: { type: integer, maximum: 10 }
 *               response_format: { type: string, enum: [b64_json, url] }
 *     responses:
 *       200: { description: Image generated }
 *       400: { description: Invalid request }
 *       422: { description: Model returned text instead of an image }
 *       502: { description: Upstream failure }
 */
router.post('/chat', handler({ withImages: false }));

/**
 * @openapi
 * /vision:
 *   post:
 *     tags: [Generation]
 *     summary: Generate an image from a prompt plus input images
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [prompt, images]
 *             properties:
 *               prompt: { type: string }
 *               images:
 *                 type: array
 *                 items: { type: string }
 *                 description: data URIs or bare base64 payloads
 *     responses:
 *       200: { description: Image generated }
 *       400: { description: Invalid request }
 */
router.post('/vision', handler({ withImages: true }));

export default router;
