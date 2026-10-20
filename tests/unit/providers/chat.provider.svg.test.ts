import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChatProvider, SYSTEM_INSTRUCTION } from '../../../src/providers/chat.provider';
import { ProviderError } from '../../../src/engine/errors';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * SVG end-to-end tests for the chat provider.
 *
 * The chat provider is where a text-only model's reply becomes an image artifact, so this
 * suite pins the acceptance criterion the whole feature rests on: **a text-only SVG
 * response reaches a valid image payload**, while prose and unsafe SVG remain truthful
 * terminal errors.
 *
 * Kept separate from `chat.provider.test.ts` because the subject is different. That suite
 * covers the four raster shapes and the wire protocol; this one covers the vector path and
 * the rasterization contract. Splitting them keeps each suite readable as one story.
 */

/** A drawing the gate accepts, in the shape the instruction asks for. */
export const VALID_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" fill="#3366cc"/>' +
  '<circle cx="32" cy="32" r="16" fill="#ffcc00"/>' +
  '</svg>';

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

function provider(over: Partial<ConstructorParameters<typeof ChatProvider>[0]> = {}) {
  return new ChatProvider({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'default-model',
    visionModel: 'vision-model',
    ...over,
  });
}

/** Build a fetch Response stub. */
function jsonResponse(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** Serve one content string from a stubbed upstream. */
function serveContent(content: string) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(jsonResponse({ choices: [{ message: { content } }] }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Whether a base64 payload decodes to bytes that begin with the PNG signature. */
function isPng(base64: string | undefined): boolean {
  if (!base64) return false;
  const bytes = Buffer.from(base64, 'base64');
  return (
    bytes.byteLength > 16 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes.toString('latin1', 12, 16) === 'IHDR'
  );
}

vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

// ─── The acceptance criterion ────────────────────────────────

describe('ChatProvider.generate — a text-only SVG reply becomes a real image', () => {
  it('rasterizes model SVG to a PNG with valid magic bytes', async () => {
    serveContent(VALID_SVG);

    const result = await provider().generate(req());
    const image = result.images[0];

    expect(image.mime).toBe('image/png');
    // This is the acceptance criterion: PNG magic bytes for default output.
    expect(isPng(image.base64)).toBe(true);
    // The vector source travels with it, so the artifact stays reproducible.
    expect(image.svg).toBe(VALID_SVG);
    expect(result.provider).toBe('chat');
  });

  it('returns image/svg+xml with the document when the caller asks for svg', async () => {
    serveContent(VALID_SVG);

    const result = await provider().generate(
      req({ output: { format: 'svg', delivery: 'base64' } }),
    );

    expect(result.images[0].mime).toBe('image/svg+xml');
    expect(result.images[0].svg).toBe(VALID_SVG);
    // No raster is delivered, so a client cannot mistake the document for a bitmap.
    expect(result.images[0].base64).toBeFalsy();
  });

  it('does not mislabel PNG bytes as JPEG for an SVG fallback', async () => {
    serveContent(VALID_SVG);

    await expect(
      provider().generate(req({ output: { format: 'jpeg', delivery: 'base64' } })),
    ).rejects.toMatchObject({
      code: 'unsupported_output',
      retryable: false,
    });
  });

  it('reports honest dimensions from the document', async () => {
    serveContent(VALID_SVG);

    const result = await provider().generate(req());
    expect(result.images[0].width).toBe(64);
    expect(result.images[0].height).toBe(64);
  });

  it('honours an explicitly requested size', async () => {
    serveContent(VALID_SVG);

    const result = await provider().generate(req({ size: { width: 256, height: 256 } }));
    expect(result.images[0].width).toBe(256);
    expect(result.images[0].height).toBe(256);
  });

  it('preserves the aspect ratio when only a width is requested', async () => {
    serveContent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150">' +
        '<rect width="300" height="150" fill="#123456"/></svg>',
    );

    const result = await provider().generate(req({ size: { width: 600, height: 600 } }));
    expect(result.images[0].width).toBe(600);
    expect(result.images[0].height).toBe(300);
  });

  it('serves SVG wrapped in a markdown code fence, the common model habit', async () => {
    serveContent('```svg\n' + VALID_SVG + '\n```');

    const result = await provider().generate(req());
    expect(isPng(result.images[0].base64)).toBe(true);
  });

  it('serves an unlabelled code fence too', async () => {
    serveContent('```\n' + VALID_SVG + '\n```');

    const result = await provider().generate(req());
    expect(isPng(result.images[0].base64)).toBe(true);
  });

  it('decodes a base64 SVG data URI', async () => {
    const encoded = Buffer.from(VALID_SVG, 'utf8').toString('base64');
    serveContent(`Here: ![image](data:image/svg+xml;base64,${encoded})`);

    const result = await provider().generate(req());
    expect(isPng(result.images[0].base64)).toBe(true);
  });

  it('prefers the drawing over a URL the model narrated alongside it', async () => {
    // Provenance is not authorship. The SVG is what the model was asked to produce.
    serveContent(`${VALID_SVG}\n\nYou could also try https://example.com/cat.png`);

    const result = await provider().generate(req());
    expect(result.images[0].mime).toBe('image/png');
    expect(result.images[0].url).toBeUndefined();
    expect(isPng(result.images[0].base64)).toBe(true);
  });

  it('takes the substantial drawing when a model emits a stub then the real one', async () => {
    const stub =
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">' +
      '<rect width="8" height="8"/></svg>';
    serveContent(`${stub}\n\n${VALID_SVG}`);

    const result = await provider().generate(req());
    expect(result.images[0].svg).toBe(VALID_SVG);
  });

  it('keeps a directly-returned raster untouched', async () => {
    serveContent('![i](data:image/png;base64,QUJD)');

    const result = await provider().generate(req());
    expect(result.images[0].mime).toBe('image/png');
    expect(result.images[0].base64).toBe('QUJD');
    // It did not come from our instruction, so there is no vector source to report.
    expect(result.images[0].svg).toBeUndefined();
  });

  it('still reads the raster shapes published before the SVG change', async () => {
    serveContent('{"b64_json":"QUJDRA=="}');

    const result = await provider().generate(req());
    expect(result.images[0].base64).toBe('QUJDRA==');
  });
});

// ─── Truthful refusal ────────────────────────────────────────

describe('ChatProvider.generate — refusals stay terminal and honest', () => {
  it('repairs one prose-only reply before surfacing a terminal refusal', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: 'I cannot generate images directly.' } }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: VALID_SVG } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.images[0].mime).toBe('image/png');
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(retryBody.messages.at(-1).content).toMatch(/complete self-contained SVG/i);
  });

  it('reports prose as a terminal unsupported_output', async () => {
    serveContent('I am unable to draw that, but here is a description of a cat.');

    await expect(provider().generate(req())).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'unsupported_output',
      retryable: false,
    });
  });

  it('reports the NO_IMAGE sentinel as a terminal unsupported_output', async () => {
    serveContent('NO_IMAGE');

    await expect(provider().generate(req())).rejects.toMatchObject({
      code: 'unsupported_output',
      retryable: false,
    });
  });

  it('refuses a script-bearing SVG rather than delivering an executable document', async () => {
    serveContent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
        '<script>alert(1)</script><rect width="64" height="64"/></svg>',
    );

    const error = await provider()
      .generate(req())
      .catch((e: unknown) => e as ProviderError);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('unsupported_output');
    expect(error.retryable).toBe(false);
    // The reason names the defect, so an operator can act on it.
    expect(error.message).toMatch(/svg_unsafe_element/);
  });

  it('refuses an event handler on the root element', async () => {
    serveContent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" onload="alert(1)">' +
        '<rect width="64" height="64"/></svg>',
    );

    await expect(provider().generate(req())).rejects.toMatchObject({
      code: 'unsupported_output',
      retryable: false,
    });
  });

  it('refuses an external reference', async () => {
    serveContent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
        '<image href="https://evil.example.com/x.png" width="64" height="64"/></svg>',
    );

    await expect(provider().generate(req())).rejects.toMatchObject({
      code: 'unsupported_output',
    });
  });

  it('refuses a geometry-free placeholder and says why', async () => {
    serveContent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
        '<title>A cat sitting on a fence</title></svg>',
    );

    const error = await provider()
      .generate(req())
      .catch((e: unknown) => e as ProviderError);

    expect(error.message).toMatch(/svg_no_geometry/);
  });

  it('refuses a document wrapped in an XML prologue with no drawing', async () => {
    serveContent(
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>',
    );

    await expect(provider().generate(req())).rejects.toMatchObject({
      code: 'unsupported_output',
    });
  });

  it('refuses a truncated document without falling back to prose', async () => {
    serveContent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64"');

    const error = await provider()
      .generate(req())
      .catch((e: unknown) => e as ProviderError);

    expect(error.code).toBe('unsupported_output');
    expect(error.message).toMatch(/svg_malformed/);
  });

  it('never silently substitutes a different artifact for a refusal', async () => {
    // The engine's core rule: a refusal is reported, not worked around.
    serveContent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
        '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject>' +
        '<rect width="64" height="64"/></svg>',
    );

    const result = await provider()
      .generate(req())
      .then(() => 'delivered')
      .catch(() => 'refused');

    expect(result).toBe('refused');
  });
});

// ─── Resource bounds ─────────────────────────────────────────

describe('ChatProvider.generate — resource bounds', () => {
  it('clamps a document that declares an enormous canvas', async () => {
    // A model-authored viewBox is a number the model chose, not a size request. Rendering
    // it at its own scale would try to allocate tens of gigabytes from one prompt.
    serveContent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000" ' +
        'viewBox="0 0 100000 100000"><rect width="100000" height="100000" fill="#123456"/></svg>',
    );

    const result = await provider().generate(req());
    expect(result.images[0].width).toBe(4096);
    expect(result.images[0].height).toBe(4096);
    expect(isPng(result.images[0].base64)).toBe(true);
  });

  it('refuses an SVG payload over the byte limit', async () => {
    serveContent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
        `<rect width="64" height="64" data-pad="${'x'.repeat(3 * 1024 * 1024)}"/></svg>`,
    );

    await expect(provider().generate(req())).rejects.toMatchObject({
      code: 'unsupported_output',
    });
  });
});

// ─── The instruction is the mechanism ────────────────────────

describe('SYSTEM_INSTRUCTION', () => {
  it('asks for exactly one self-contained SVG document', () => {
    expect(SYSTEM_INSTRUCTION).toContain('one self-contained SVG document');
    expect(SYSTEM_INSTRUCTION).toContain('http://www.w3.org/2000/svg');
  });

  it('names the prohibited constructs the validator also refuses', () => {
    // The instruction and the gate must agree, or a model that obeys the prompt is refused
    // by the code. Each prohibition here has a matching check in platform/svg.
    expect(SYSTEM_INSTRUCTION).toMatch(/no <script>/);
    expect(SYSTEM_INSTRUCTION).toMatch(/event attributes/);
    expect(SYSTEM_INSTRUCTION).toMatch(/no <foreignObject>/);
    expect(SYSTEM_INSTRUCTION).toMatch(/no DOCTYPE/);
    expect(SYSTEM_INSTRUCTION).toMatch(/no external URLs/);
    expect(SYSTEM_INSTRUCTION).toMatch(/data: URLs/);
  });

  it('forbids prose, explanation and code fences', () => {
    expect(SYSTEM_INSTRUCTION).toMatch(/Do not describe the image/);
    expect(SYSTEM_INSTRUCTION).toMatch(/do not explain your choices/);
    expect(SYSTEM_INSTRUCTION).toMatch(/code fence/);
  });

  it('gives an explicit escape hatch rather than inviting an invented URL', () => {
    expect(SYSTEM_INSTRUCTION).toContain('NO_IMAGE');
    // The old instruction asked for a data URI and got invented URLs. This one must not
    // suggest a URL is an acceptable answer.
    expect(SYSTEM_INSTRUCTION).not.toMatch(/markdown image/);
  });
});
