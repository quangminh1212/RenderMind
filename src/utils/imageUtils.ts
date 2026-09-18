import { createHash } from 'crypto';
import type { ImageGenerationRequest } from '../types/canonical.types';

/**
 * Cache key derivation.
 *
 * The previous implementation built the key from a hand-picked argument list
 * (`prompt|width|height|backend|seed|model`) and omitted `negative_prompt`, `steps` and
 * `cfg_scale`. Two requests differing only in those fields collided, so the second was
 * served the first's image — a live correctness bug, now pinned by regression tests.
 *
 * The fix is structural rather than additive: hash the *entire* normalized request. Any
 * field added in future is therefore covered by construction, so this class of bug
 * cannot return. The `v2:` prefix guarantees no key poisoned by the old scheme is ever
 * read back after an upgrade.
 */

const KEY_PREFIX = 'v2:img:';

/**
 * Build a content-addressed cache key for a canonical request.
 *
 * Deliberately excluded from the hash because they do not affect the produced pixels:
 *   - `metadata`   — caller bookkeeping (user id, trace id)
 *   - `callbackUrl`— where the result is delivered, not what is generated
 *   - `output.delivery` — base64 vs url is a transport concern; the image is identical
 *
 * `output.format` IS included: png and jpeg of the same scene are different bytes.
 */
export function buildCacheKey(request: ImageGenerationRequest): string {
  const normalized = {
    prompt: request.prompt,
    negativePrompt: request.negativePrompt ?? null,
    count: request.count,
    size: request.size ?? null,
    aspect: request.aspect ?? null,
    quality: request.quality ?? null,
    steps: request.steps ?? null,
    guidanceScale: request.guidanceScale ?? null,
    seed: request.seed ?? null,
    model: request.model ?? null,
    provider: request.provider ?? 'auto',
    style: request.style ?? null,
    format: request.output.format,
    // Reference images participate: an img2img call is not the same as a txt2img one.
    refs:
      request.referenceImages?.map((r) =>
        createHash('sha256').update(r.data).digest('hex').slice(0, 16),
      ) ?? null,
    hasMask: request.mask
      ? createHash('sha256').update(request.mask.data).digest('hex').slice(0, 16)
      : null,
  };

  const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 32);

  return `${KEY_PREFIX}${hash}`;
}

/**
 * Whether a cache key was produced by the pre-fix scheme.
 *
 * Used to skip poisoned entries without needing to flush Redis on deploy.
 */
export function isLegacyCacheKey(key: string): boolean {
  return !key.startsWith(KEY_PREFIX);
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
}
