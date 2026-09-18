import { Router, Request, Response } from 'express';
import { getEngine } from '../../engine';
import { getConfig } from '../../config';
import {
  toAnthropicMessagesResponse,
  toAnthropicError,
  anthropicErrorTypeFor,
  imageToolDeclaration,
} from '../../utils/formatAdapters';
import {
  AllProvidersUnavailableError,
  NoProviderAvailableError,
  ProviderError,
  UnsupportedCapabilityError,
} from '../../engine/errors';
import {
  AnthropicMessagesRequestSchema,
  extractImageRequest,
  estimateMessageTokens,
  type AnthropicMessagesRequest,
} from './prompt.extractor';
import { streamMessage } from './streaming';
import { logger } from '../../utils/logger';

/**
 * Anthropic Claude Messages-compatible endpoint.
 *
 * A Claude or coding-agent client can call RenderMind as if it were the Messages API and
 * receive a generated image. The response is a valid Anthropic `message`.
 *
 * Contract notes (see docs/protocols/anthropic-messages.md for the full divergence list):
 *   - The default response carries a `tool_use` block for the `generate_image` tool.
 *     This is spec-valid; the Anthropic *response* ContentBlock union has no `image`
 *     member, so an image block is available only as an opt-in extension.
 *   - `stream: true` produces a real SSE stream (see streaming.ts).
 *   - Errors use the Anthropic envelope with `request_id`, and 529 for overload.
 */
const router = Router();

/** Wrap a handler so thrown errors become protocol-shaped responses. */
function sendAnthropicError(res: Response, error: unknown, req: Request): void {
  const requestId = (req.headers['x-request-id'] as string) ?? undefined;

  if (error instanceof UnsupportedCapabilityError) {
    res.status(400).json(toAnthropicError(error.message, 400, requestId));
    return;
  }

  if (error instanceof NoProviderAvailableError) {
    // A deployment problem, not the caller's: 500 with a clear message.
    res.status(500).json(toAnthropicError(error.message, 500, requestId));
    return;
  }

  if (error instanceof AllProvidersUnavailableError) {
    // Transient upstream outage. Anthropic uses 529 for this, never 503.
    res.setHeader('Retry-After', '30');
    res.status(529).json(toAnthropicError(error.message, 529, requestId));
    return;
  }

  if (error instanceof ProviderError) {
    // Preserve meaningful upstream semantics rather than flattening everything to 500.
    let status: number;
    if (error.status === 429) status = 429;
    else if (error.status === 529) status = 529;
    else if (error.isClientError) status = 400;
    else if (error.status === 504) status = 504;
    else status = 500;

    if (error.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
    }

    logger.warn('Anthropic bridge provider error', {
      requestId,
      provider: error.provider,
      upstreamStatus: error.status,
      code: error.code,
    });

    res.status(status).json(toAnthropicError(error.message, status, requestId));
    return;
  }

  logger.error('Anthropic bridge unexpected error', {
    requestId,
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json(toAnthropicError('An unexpected error occurred', 500, requestId));
}

/**
 * @openapi
 * /v1/messages:
 *   post:
 *     tags: [Anthropic-compatible]
 *     summary: Anthropic Messages-compatible image generation
 *     description: >
 *       Accepts an Anthropic Messages request and returns a generated image as a
 *       `tool_use` content block for the `generate_image` tool. Supports `stream: true`
 *       with real SSE events.
 *     responses:
 *       200:
 *         description: A message containing the generated image reference
 *       400:
 *         description: Invalid request (Anthropic error envelope)
 *       401:
 *         description: Authentication error
 *       429:
 *         description: Rate limited
 *       529:
 *         description: Upstream overloaded
 */
router.post('/', async (req: Request, res: Response) => {
  const parsed = AnthropicMessagesRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    const requestId = (req.headers['x-request-id'] as string) ?? undefined;
    const message = parsed.error.errors
      .map((e) => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .join('; ');
    res.status(400).json(toAnthropicError(message, 400, requestId));
    return;
  }

  const body = parsed.data;
  const config = getConfig();

  const extraction = extractImageRequest(body);
  if (!extraction.ok) {
    res
      .status(400)
      .json(toAnthropicError(extraction.message, 400, req.headers['x-request-id'] as string));
    return;
  }

  if (body.stream) {
    // Anthropic sends the message_start event before generation completes, but image
    // generation is not incremental, so we generate first and stream the result. The
    // client still receives a well-formed event sequence.
    try {
      const { result } = await getEngine().generation.generate(extraction.request);
      const message = toAnthropicMessagesResponse(result, {
        model: body.model,
        prompt: extraction.request.prompt,
        generationId: req.generationId ?? 'gen_unknown',
        imageBlockMode: config.protocols.anthropicImageBlockMode,
      });
      streamMessage(res, message);
    } catch (error) {
      // A failure before any bytes are written can still be a clean error response.
      if (!res.headersSent) {
        sendAnthropicError(res, error, req);
        return;
      }
      logger.error('Streaming failed after headers were sent', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.end();
    }
    return;
  }

  try {
    const { result } = await getEngine().generation.generate(extraction.request);

    const message = toAnthropicMessagesResponse(result, {
      model: body.model,
      prompt: extraction.request.prompt,
      generationId: req.generationId ?? 'gen_unknown',
      imageBlockMode: config.protocols.anthropicImageBlockMode,
    });

    res.json(message);
  } catch (error) {
    sendAnthropicError(res, error, req);
  }
});

/**
 * `POST /v1/messages/count_tokens`.
 *
 * A documented Anthropic endpoint that Claude Code calls. Its absence meant clients
 * received the native 404 body instead of the expected shape.
 */
router.post('/count_tokens', (req: Request, res: Response) => {
  const parsed = AnthropicMessagesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json(
        toAnthropicError(
          parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          400,
          req.headers['x-request-id'] as string,
        ),
      );
    return;
  }

  res.json({ input_tokens: estimateMessageTokens(parsed.data as AnthropicMessagesRequest) });
});

/** Expose the tool contract so clients can declare it in `tools[]`. */
router.get('/tools', (_req: Request, res: Response) => {
  res.json({ tools: [imageToolDeclaration()] });
});

export { anthropicErrorTypeFor };
export default router;
