import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChatProvider, SYSTEM_INSTRUCTION } from '../../../src/providers/chat.provider';
import {
  SCENE_SYSTEM_INSTRUCTION,
  buildSceneInstruction,
  SCENE_LAYER_BUDGET,
  SCENE_SHAPE_BUDGET,
} from '../../../src/providers/prompt.builder';
import { ProviderError } from '../../../src/engine/errors';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';
import { validateSvg } from '../../../src/platform/svg';

/**
 * Scene-mode tests for the chat provider — the `CHAT_RENDER_MODE=scene` path.
 *
 * The feature's promise is narrow and worth pinning precisely: in scene mode the model is
 * asked for a **JSON scene**, the reply is compiled by `compileTextScene`, and the resulting
 * validated document travels the *same* delivery path as an SVG-mode drawing. So this suite
 * asserts four things the mode actually promises:
 *
 *   1. the **request payload** asks for a scene and forbids SVG/pixels;
 *   2. a valid scene is delivered as **PNG** by default and as **SVG** when asked;
 *   3. an invalid scene earns **one bounded repair**, and a second failure is **terminal**;
 *   4. the default (`svg`) mode is **unchanged** — the same upstream instruction as before.
 *
 * The upstream is a stubbed `fetch`, so nothing between the model reply and the delivered
 * artifact is mocked behaviour.
 */

/** A scene that compiles: two layers, typed geometry, no markup anywhere. */
function validScene(): Record<string, unknown> {
  return {
    title: 'Apple on blue',
    canvas: { width: 64, height: 64, background: '#ffffff' },
    layers: [
      {
        id: 'bg',
        name: 'Background',
        shapes: [{ kind: 'rect', x: 0, y: 0, width: 64, height: 64, fill: '#3366cc' }],
      },
      {
        id: 'fruit',
        name: 'Fruit',
        shapes: [{ kind: 'circle', cx: 32, cy: 32, r: 16, fill: '#ff0000' }],
      },
    ],
  };
}

/** A scene-shaped object the gate must refuse: an undeclared geometry kind. */
function invalidScene(): Record<string, unknown> {
  return {
    canvas: { width: 64, height: 64 },
    layers: [{ id: 'a', name: 'A', shapes: [{ kind: 'star', points: 5 }] }],
  };
}

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
    renderMode: 'scene',
    ...over,
  });
}

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

/** Serve a sequence of content strings, one per upstream call, from a stubbed fetch. */
function serveSequence(contents: unknown[]) {
  const fetchMock = vi.fn();
  for (const content of contents) {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content } }] }));
  }
  // Any call beyond the scripted sequence repeats the last reply, so an unbounded repair
  // loop would be caught by the call-count assertions rather than hanging on a rejected mock.
  fetchMock.mockResolvedValue(
    jsonResponse({ choices: [{ message: { content: contents[contents.length - 1] } }] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

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

/** The JSON body sent on the nth upstream call. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[call][1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

// ─── The scene request payload ───────────────────────────────

describe('ChatProvider scene mode — the request asks for a scene, not markup', () => {
  it('sends the scene system instruction and a scene user turn', async () => {
    const fetchMock = serveSequence([JSON.stringify(validScene())]);

    await provider().generate(req({ size: { width: 128, height: 128 } }));

    const body = bodyOf(fetchMock, 0);
    const messages = body.messages as Array<{ role: string; content: unknown }>;

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(SCENE_SYSTEM_INSTRUCTION);
    // The instruction asks for a JSON scene and forbids emitting markup. It may *mention*
    // SVG (a `path` shape's `d` is SVG path data), so assert the ask rather than a substring.
    expect(SCENE_SYSTEM_INSTRUCTION).toMatch(/JSON object/);
    expect(SCENE_SYSTEM_INSTRUCTION).toMatch(/Never output SVG markup/i);
    expect(SCENE_SYSTEM_INSTRUCTION).toMatch(/\bdata\b/i);
    expect(SCENE_SYSTEM_INSTRUCTION).not.toMatch(/begin with <svg/i);

    const user = messages[messages.length - 1];
    expect(user.role).toBe('user');
    expect(String(user.content)).toContain('a red apple');
    expect(String(user.content)).toMatch(/JSON/);
    // The caller's dimensions are folded into the scene turn.
    expect(String(user.content)).toContain('128x128');
  });

  it('names a hard layer and shape budget in the instruction', () => {
    expect(SCENE_SYSTEM_INSTRUCTION).toContain(String(SCENE_LAYER_BUDGET));
    expect(SCENE_SYSTEM_INSTRUCTION).toContain(String(SCENE_SHAPE_BUDGET));
    // The example schema must spell out every shape kind the gate accepts.
    for (const kind of ['rect', 'circle', 'ellipse', 'line', 'polygon', 'path']) {
      expect(SCENE_SYSTEM_INSTRUCTION).toContain(kind);
    }
  });

  it('builds a scene user turn that folds size, negative and seed like the SVG turn', () => {
    const turn = buildSceneInstruction(
      req({
        size: { width: 320, height: 200 },
        aspect: '16:9',
        negativePrompt: 'no text',
        seed: 7,
        count: 1,
      }),
    );

    expect(turn).toContain('a red apple');
    expect(turn).toContain('320x200');
    expect(turn).toContain('16:9');
    expect(turn).toContain('no text');
    expect(turn).toContain('7');
  });
});

// ─── Delivery: png and svg ───────────────────────────────────

describe('ChatProvider scene mode — a valid scene is delivered through the normal path', () => {
  it('rasterizes the compiled scene to a PNG by default', async () => {
    serveSequence([JSON.stringify(validScene())]);

    const result = await provider().generate(req());
    const image = result.images[0];

    expect(image.mime).toBe('image/png');
    expect(isPng(image.base64)).toBe(true);
    // The source document is retained, as it is for the SVG path.
    expect(validateSvg(image.svg!).ok).toBe(true);
  });

  it('delivers the compiled document unchanged when format is svg', async () => {
    serveSequence([JSON.stringify(validScene())]);

    const result = await provider().generate(
      req({ output: { format: 'svg', delivery: 'base64' } }),
    );
    const image = result.images[0];

    expect(image.mime).toBe('image/svg+xml');
    expect(validateSvg(image.svg!).ok).toBe(true);
    // The delivered document is the compiler's final frame, not a model artifact.
    expect(image.svg).toContain('<svg');
    expect(image.width).toBe(64);
    expect(image.height).toBe(64);
  });

  it('accepts a scene wrapped in prose or a fence, because the compiler locates it', async () => {
    serveSequence(['Here is the scene:\n```json\n' + JSON.stringify(validScene()) + '\n```']);

    const result = await provider().generate(
      req({ output: { format: 'svg', delivery: 'base64' } }),
    );

    expect(result.images[0].mime).toBe('image/svg+xml');
  });
});

// ─── Repair and terminal failure ─────────────────────────────

describe('ChatProvider scene mode — one bounded repair, then a truthful failure', () => {
  it('repairs an unusable scene once and delivers the corrected one', async () => {
    const fetchMock = serveSequence([JSON.stringify(invalidScene()), JSON.stringify(validScene())]);

    const result = await provider().generate(
      req({ output: { format: 'svg', delivery: 'base64' } }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second call carries the repair turn, not the whole standing instruction again.
    const repaired = bodyOf(fetchMock, 1);
    const messages = repaired.messages as Array<{ role: string; content: unknown }>;
    const last = String(messages[messages.length - 1].content);
    expect(last).toMatch(/JSON object/);
    expect(last).not.toContain('a red apple');
    expect(result.images[0].mime).toBe('image/svg+xml');
  });

  it('fails terminally with unsupported_output when the repair is also unusable', async () => {
    const fetchMock = serveSequence([
      JSON.stringify(invalidScene()),
      JSON.stringify(invalidScene()),
    ]);

    await expect(
      provider().generate(req({ output: { format: 'svg', delivery: 'base64' } })),
    ).rejects.toMatchObject({ code: 'unsupported_output', retryable: false });

    // Exactly one initial call plus one repair: the loop is bounded at two upstream calls.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails terminally on a prose reply, naming the compiler stage and code', async () => {
    serveSequence(['I cannot draw that.']);

    const error = await provider()
      .generate(req())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('unsupported_output');
    // The message carries the compiler's fixed vocabulary, never the model's reply.
    expect((error as ProviderError).message).toMatch(/extract|scene_payload_prose/);
    expect((error as ProviderError).message).not.toContain('I cannot draw that.');
  });

  it('treats an explicit NO_IMAGE refusal as terminal without a repair turn', async () => {
    const fetchMock = serveSequence(['NO_IMAGE']);

    await expect(provider().generate(req())).rejects.toMatchObject({
      code: 'unsupported_output',
      retryable: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never logs the model reply or the prompt on a scene failure', async () => {
    const secret = 'SECRET-MODEL-REPLY-' + 'a'.repeat(40);
    serveSequence([`prose around ${secret}`]);

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await provider()
      .generate(req())
      .catch(() => undefined);

    const logged = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('a red apple');
  });
});

// ─── Backwards compatibility: the default mode is unchanged ───

describe('ChatProvider default render mode — svg behaviour is byte-identical', () => {
  it('uses the SVG system instruction when renderMode is omitted', async () => {
    const fetchMock = serveSequence(['prose']);
    const p = provider({ renderMode: undefined });

    await p.generate(req()).catch(() => undefined);

    const body = bodyOf(fetchMock, 0);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0].content).toBe(SYSTEM_INSTRUCTION);
  });

  it('uses the SVG system instruction when renderMode is svg', async () => {
    const fetchMock = serveSequence(['prose']);
    const p = provider({ renderMode: 'svg' });

    await p.generate(req()).catch(() => undefined);

    const body = bodyOf(fetchMock, 0);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0].content).toBe(SYSTEM_INSTRUCTION);
  });

  it('still extracts a raw SVG reply in the default mode (scene compiler untouched)', async () => {
    const SVG =
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<rect width="64" height="64" fill="#3366cc"/></svg>';
    serveSequence([SVG]);

    const result = await provider({ renderMode: 'svg' }).generate(
      req({ output: { format: 'svg', delivery: 'base64' } }),
    );

    expect(result.images[0].mime).toBe('image/svg+xml');
    expect(result.images[0].svg).toBe(SVG);
  });
});
