import { describe, it, expect, vi, afterEach } from 'vitest';
import { NativeImageProvider } from '../../../src/providers/image.provider';
import { buildNativePrompt } from '../../../src/providers/prompt.builder';
import type { PromptPlanner } from '../../../src/providers/prompt.planner';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * Prompt-planner integration with the native provider.
 *
 * The planner's own rules are pinned in `prompt.planner.test.ts`. This file pins the *seam*,
 * which is where the feature can hurt a request if it is wired wrong:
 *
 *   1. **Disabled == byte-identical.** With no planner, the payload is exactly
 *      `buildNativePrompt(request)` — asserted against the builder itself, not a copy of its
 *      output, so the two cannot drift.
 *   2. **A fan-out is never planned.** Above one image the engine has already varied the
 *      prompt; planning it again rewrites the variation direction and costs a call per image.
 *   3. **Failure is never fatal.** A planner that returns null — or throws against its
 *      contract — leaves the generation to proceed with the original prompt.
 */

function req(over: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    prompt: 'a red apple',
    count: 1,
    size: null,
    aspect: null,
    quality: null,
    output: { format: 'png', delivery: 'base64' },
    ...over,
  };
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** Build a fetch Response carrying one inline image. */
function imageResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ data: [{ b64_json: PNG_BASE64 }] }),
    text: async () => '',
  } as unknown as Response;
}

/** The parsed JSON body of the images-generations call. */
function imagePayload(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
}

function providerWith(planner?: PromptPlanner) {
  return new NativeImageProvider({
    apiKey: 'image-key',
    baseUrl: 'https://litellm.example.com/v1',
    model: 'dall-e-3',
    ...(planner ? { planner } : {}),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('NativeImageProvider prompt planner seam', () => {
  it('sends exactly buildNativePrompt when no planner is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const request = req({ negativePrompt: 'blurry', size: { width: 1024, height: 1024 } });
    await providerWith().generate(request);

    // Against the builder itself, so the disabled path cannot silently diverge from it.
    expect(imagePayload(fetchMock).prompt).toBe(buildNativePrompt(request));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the planner expansion when one is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const planner = vi.fn().mockResolvedValue('a lush, detailed expansion of the request');
    await providerWith(planner).generate(req());

    expect(planner).toHaveBeenCalledTimes(1);
    expect(imagePayload(fetchMock).prompt).toBe('a lush, detailed expansion of the request');
    // One fetch: the image call only. The planner here is a stub, not a real fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the original prompt when the planner returns null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const request = req();
    await providerWith(vi.fn().mockResolvedValue(null)).generate(request);

    expect(imagePayload(fetchMock).prompt).toBe(buildNativePrompt(request));
  });

  it('falls back, and does not fail, when the planner throws', async () => {
    // A planner that violates its "never throws" contract still must not break a generation.
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const request = req();
    const planner = vi.fn().mockRejectedValue(new Error('planner exploded'));
    const result = await providerWith(planner).generate(request);

    expect(result.images).toHaveLength(1);
    expect(imagePayload(fetchMock).prompt).toBe(buildNativePrompt(request));
  });

  it('does not plan a fan-out (count > 1)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const planner = vi.fn().mockResolvedValue('should never be used');
    const request = req({ count: 3 });
    await providerWith(planner).generate(request);

    // The engine has already varied this prompt per variant; the planner must stay out of it.
    expect(planner).not.toHaveBeenCalled();
    expect(imagePayload(fetchMock).prompt).toBe(buildNativePrompt(request));
  });

  it('still sends the response_format and n fields alongside a planned prompt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse());
    vi.stubGlobal('fetch', fetchMock);

    await providerWith(vi.fn().mockResolvedValue('expanded')).generate(req());

    const payload = imagePayload(fetchMock);
    expect(payload.response_format).toBe('b64_json');
    expect(payload.n).toBe(1);
    expect(payload.model).toBe('dall-e-3');
  });
});
