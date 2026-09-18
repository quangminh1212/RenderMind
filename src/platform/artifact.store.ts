import type { GeneratedImage, ImageFormat, ImageGenerationRequest } from '../types/canonical.types';
import { ProviderError } from '../engine/errors';
import { logger } from '../utils/logger';

/**
 * Image artifact handling.
 *
 * Why this exists: providers differ in how they hand back pixels. Stability and the
 * openclaw provider return base64; Replicate returns CDN URLs. An openclaw client asking
 * for `response_format: 'b64_json'` must still receive base64 even when the only provider
 * available is Replicate — and the previous implementation instead silently returned a
 * `{url}` for a `b64_json` request, breaking `Buffer.from(data[0].b64_json)` callers.
 *
 * So this inlines URLs when base64 is required, or reports an honest error when it
 * cannot, rather than violating the requested format.
 */

/** Guard against a provider pointing us at an enormous or hostile resource. */
const MAX_INLINE_BYTES = 25 * 1024 * 1024;

const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Fetch a remote image and return it as base64.
 *
 * @throws ProviderError when the image cannot be retrieved, so the engine reports a
 *         truthful failure instead of substituting a different response format.
 */
export async function inlineAsBase64(
  url: string,
  provider: string,
  timeoutMs = 30000,
): Promise<{ base64: string; mime: string }> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ProviderError({
      provider,
      message: `Failed to fetch generated image from provider URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
      status: 502,
      code: 'artifact_fetch_failed',
      cause: error,
    });
  }

  if (!response.ok) {
    throw new ProviderError({
      provider,
      message: `Provider image URL returned ${response.status}`,
      status: 502,
      code: 'artifact_fetch_failed',
    });
  }

  // Reject before buffering when the server advertises an oversized body.
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_INLINE_BYTES) {
    throw new ProviderError({
      provider,
      message: `Generated image is too large to inline (${declaredLength} bytes)`,
      status: 502,
      code: 'artifact_too_large',
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_INLINE_BYTES) {
    throw new ProviderError({
      provider,
      message: `Generated image is too large to inline (${buffer.byteLength} bytes)`,
      status: 502,
      code: 'artifact_too_large',
    });
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
  const mime = contentType?.startsWith('image/') ? contentType : 'image/png';

  return { base64: buffer.toString('base64'), mime };
}

/**
 * Ensure every image can be delivered in the format the caller asked for.
 *
 * - `delivery: 'base64'` — every image gains `base64`; URL-only images are inlined.
 * - `delivery: 'url'`    — every image gains `url`; base64-only providers keep their
 *                          base64 payload and the adapter surfaces it as a data URI.
 *
 * Images that cannot be converted raise rather than being silently dropped: a caller
 * who asked for three images must be told if only two could be produced.
 */
export async function materializeImages(
  images: GeneratedImage[],
  request: ImageGenerationRequest,
  provider: string,
): Promise<GeneratedImage[]> {
  if (request.output.delivery !== 'base64') return images;

  const materialized: GeneratedImage[] = [];

  for (const image of images) {
    if (image.base64) {
      materialized.push({ ...image, mime: image.mime || MIME_BY_FORMAT[request.output.format] });
      continue;
    }

    if (image.url) {
      const inlined = await inlineAsBase64(image.url, provider);
      materialized.push({ ...image, base64: inlined.base64, mime: inlined.mime });
      continue;
    }

    // Neither payload present: this provider returned an empty result.
    logger.warn('Provider returned an image with neither base64 nor url', { provider });
  }

  return materialized;
}

/** Build a data URI for a base64 payload. */
export function toDataUri(base64: string, mime: string): string {
  return `data:${mime};base64,${base64}`;
}

/** Strip a data-URI prefix if present, returning the raw base64 and its mime. */
export function stripDataUri(value: string): { base64: string; mime?: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(value);
  if (match) return { base64: match[2], mime: match[1] };
  return { base64: value };
}
