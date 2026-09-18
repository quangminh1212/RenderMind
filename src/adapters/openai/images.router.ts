import { Router, Request, Response } from 'express';
import { getEngine } from '../../engine';
import { getConfig } from '../../config';
import { toOpenAIImagesResponse, toOpenAIError, satisfiesFormat } from '../../utils/formatAdapters';
import {
  AllProvidersUnavailableError,
  NoProviderAvailableError,
  ProviderError,
  UnsupportedCapabilityError,
} from '../../engine/errors';
import { translateOpenAIImagesRequest, OpenAIImagesRequestSchema } from './schemas';
import { logger } from '../../utils/logger';

/**
 * openclaw-compatible image generation endpoint.
 *
 * A drop-in surface for any client speaking `POST /v1/images/generations`. Requests are
 * translated into canonical form and routed through the engine, so the caller's
 * `response_format`, `n` and `size` are honoured rather than approximated.
 *
 * Fixes carried over from the audit:
 *   - `n>1` is dispatched concurrently with distinct seeds, not as n identical serial
 *     calls; a partial failure is reported instead of being silently dropped.
 *   - Errors use the openclaw envelope, not the native one.
 *   - `b64_json` never degrades into a `url`.
 *   - Upstream status codes map to honest client statuses instead of a blanket 502.
 */
const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const parsed = OpenAIImagesRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    const first = parsed.error.errors[0];
    res
      .status(400)
      .json(
        toOpenAIError(
          parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          400,
          first?.path.join('.') ?? null,
          'invalid_request_error',
        ),
      );
    return;
  }

  const translated = translateOpenAIImagesRequest(parsed.data);
  if (!translated.ok) {
    res
      .status(400)
      .json(toOpenAIError(translated.message, 400, translated.param, 'invalid_request_error'));
    return;
  }

  const request = translated.request;
  const config = getConfig();

  try {
    const { result } = await getEngine().generation.generate(request);

    const format = request.output.delivery === 'url' ? 'url' : 'b64_json';

    // Refuse to violate the requested format: a caller asking for b64_json must not be
    // handed a url, because `Buffer.from(data[0].b64_json)` would then throw.
    if (!satisfiesFormat(result, format, request.count)) {
      logger.error('Generated result does not satisfy the requested response_format', {
        format,
        requested: request.count,
        produced: result.images.length,
      });
      res
        .status(502)
        .json(
          toOpenAIError(
            `Provider could not deliver ${request.count} image(s) as ${format}`,
            502,
            'response_format',
            'invalid_response_format',
          ),
        );
      return;
    }

    res.json(
      toOpenAIImagesResponse(result, {
        format,
        created: Math.floor(Date.now() / 1000),
        generationId: req.generationId ?? 'gen_unknown',
        includeMetadata: config.protocols.openaiResponseMetadata,
      }),
    );
  } catch (error) {
    sendProtocolError(res, error, req);
  }
});

/**
 * Map an engine failure onto the openclaw error envelope.
 *
 * A capability gap or an unknown backend is the caller's mistake (400). An exhausted
 * upstream is a 502. Conflating the two — as the old code did — meant a typo in
 * `backend` surfaced as `server_error`.
 */
export function sendProtocolError(res: Response, error: unknown, req?: Request): void {
  const requestId = req?.headers['x-request-id'] as string | undefined;

  if (error instanceof UnsupportedCapabilityError) {
    res.status(400).json(toOpenAIError(error.message, 400, null, 'unsupported_capability'));
    return;
  }

  if (error instanceof NoProviderAvailableError) {
    res.status(500).json(toOpenAIError(error.message, 500, null, 'no_provider_configured'));
    return;
  }

  if (error instanceof AllProvidersUnavailableError) {
    // Transient upstream outage: 503 with Retry-After, so a client backs off rather
    // than treating this as a permanent failure.
    res.setHeader('Retry-After', '30');
    res.status(503).json(toOpenAIError(error.message, 503, null, 'server_error'));
    return;
  }

  if (error instanceof ProviderError) {
    // Preserve the upstream's own semantics where they are meaningful to the caller.
    const status =
      error.status === 429 ? 429 : error.isClientError ? 400 : error.status === 504 ? 504 : 502;

    if (error.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
    }

    logger.warn('Provider error surfaced to client', {
      requestId,
      provider: error.provider,
      upstreamStatus: error.status,
      code: error.code,
    });

    res.status(status).json(toOpenAIError(error.message, status, null, error.code));
    return;
  }

  logger.error('Unexpected error in images endpoint', {
    requestId,
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json(toOpenAIError('An unexpected error occurred', 500, null, 'server_error'));
}

export default router;
