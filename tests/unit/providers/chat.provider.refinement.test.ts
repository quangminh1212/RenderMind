import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChatProvider, parseReview } from '../../../src/providers/chat.provider';
import { ProviderError } from '../../../src/engine/errors';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * Vision-refinement tests for the chat provider.
 *
 * The feature under test is opt-in and multiplies upstream calls, so the properties pinned
 * here are the ones that decide whether it is safe to turn on:
 *
 *   1. **Off by default, in the strong sense.** With no rounds configured, the provider makes
 *      exactly the one call it made before this setting existed. A regression here would
 *      silently double every deployment's upstream spend.
 *   2. **One round is two calls, made in the right order with the right bodies.** A review of
 *      the *rendered* drawing, then a revision by the drawing model.
 *   3. **Unusable review output stops the pass.** A reviewer that answers with prose, or with
 *      a verdict it did not commit to, must not cause a revision — the alternative is
 *      revising a drawing on the strength of text we did not understand.
 *   4. **The last valid drawing survives every failure.** Review fails, revision fails, the
 *      revision is refused by the SVG gate, the loop is somehow re-run: the caller still gets
 *      the image that was already correct, and is told how many rounds actually completed.
 *   5. **Secrets and raw payloads stay out of messages and errors.**
 */

/** A drawing the gate accepts. */
const VALID_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" fill="#3366cc"/>' +
  '<circle cx="32" cy="32" r="16" fill="#ffcc00"/>' +
  '</svg>';

/** A different drawing, so a revision is distinguishable from what it replaced. */
const REVISED_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" fill="#ffffff"/>' +
  '<ellipse cx="32" cy="32" rx="20" ry="12" fill="#cc0000"/>' +
  '</svg>';

const ACCEPT_JSON = JSON.stringify({
  verdict: 'accept',
  summary: 'Matches the request.',
  issues: [],
  suggestions: [],
});

const REVISE_JSON = JSON.stringify({
  verdict: 'revise',
  summary: 'The subject is the wrong colour.',
  issues: ['the apple is blue, not red'],
  suggestions: ['fill the fruit with red'],
});

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

/** A provider with the refinement rounds switched on and a vision model named. */
function provider(over: Partial<ConstructorParameters<typeof ChatProvider>[0]> = {}) {
  return new ChatProvider({
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'default-model',
    visionModel: 'vision-model',
    visionModelConfigured: true,
    visionRefinementRounds: 1,
    ...over,
  });
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => init.headers?.[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** A reply carrying `content` from the chat model. */
function reply(content: string) {
  return jsonResponse({ choices: [{ message: { content } }] });
}

/** A reply carrying tool-call scaffolding but no text content. */
function replyWithoutContent() {
  return jsonResponse({
    choices: [{ message: { tool_calls: [{ id: 'call_1', type: 'function' }] } }],
  });
}

/** An upstream error envelope. */
function upstreamError(status: number, code: string, message: string) {
  return jsonResponse({ error: { message, code } }, { status });
}

/** Parse the outgoing payload of the Nth fetch call. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string);
}

/** The rendered PNG attached to a review request, as base64. */
function attachedPng(body: Record<string, unknown>): string {
  const parts = (body.messages as Array<Record<string, unknown>>)[1].content as Array<
    Record<string, unknown>
  >;
  const url = (parts[0].image_url as { url: string }).url;
  return url.replace(/^data:image\/png;base64,/, '');
}

function isPng(base64: string): boolean {
  const bytes = Buffer.from(base64, 'base64');
  return (
    bytes.byteLength > 16 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

// ─── Off by default ──────────────────────────────────────────

describe('chat provider — refinement is off unless it is asked for', () => {
  it('makes exactly one call when no rounds are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(VALID_SVG));
    vi.stubGlobal('fetch', fetchMock);

    // A vision model *is* configured here, which is the interesting case: the vision model
    // exists for /vision, and that must not by itself switch the refinement pass on.
    const bare = new ChatProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'default-model',
      visionModel: 'vision-model',
      visionModelConfigured: true,
    });

    const result = await bare.generate(req());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.images[0].mime).toBe('image/png');
  });

  it('treats a zero round count as off', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(VALID_SVG));
    vi.stubGlobal('fetch', fetchMock);

    await provider({ visionRefinementRounds: 0 }).generate(req());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('stays off when no vision model was explicitly configured', async () => {
    // Sending pixels to a model whose image support was never verified is the exact guess
    // the capability descriptor refuses to make; the refinement pass must not make it either.
    const fetchMock = vi.fn().mockResolvedValue(reply(VALID_SVG));
    vi.stubGlobal('fetch', fetchMock);

    const unverified = new ChatProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'text-only-model',
      visionRefinementRounds: 3,
    });

    await unverified.generate(req());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('runs at most five rounds, however many are configured', async () => {
    // The config schema already refuses a value above five at startup. This pins the same
    // bound inside the class, because a provider constructed directly never met the schema.
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { messages: Array<{ content: unknown }> };
      // The review turn is the one whose system prompt names the reviewer.
      const isReview = String(body.messages[0].content).includes('visual quality reviewer');
      return reply(isReview ? REVISE_JSON : VALID_SVG);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider({ visionRefinementRounds: 10_000 }).generate(req());

    // Five rounds, never more: 1 drawing + 5 x (review + revision).
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(result.images[0].svg).toBe(VALID_SVG);
  });
});

// ─── One round: review, then revise ──────────────────────────

describe('chat provider — one review + revision round', () => {
  it('review then revise: three calls, with the expected models and messages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(reply(REVISE_JSON))
      .mockResolvedValueOnce(reply(REVISED_SVG));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('https://api.example.com/v1/chat/completions');
    }

    // ── Call 1: the original drawing request ──
    const drawing = bodyOf(fetchMock, 0);
    expect(drawing.model).toBe('default-model');
    expect(drawing.messages[0].content).toMatch(/image generation backend/);

    // ── Call 2: the review, by the vision model ──
    const review = bodyOf(fetchMock, 1);
    expect(review.model).toBe('vision-model');
    expect(review.temperature).toBe(0);
    const reviewParts = (review.messages as Array<Record<string, unknown>>)[1].content as Array<
      Record<string, unknown>
    >;
    expect(reviewParts[0]).toMatchObject({ type: 'image_url' });
    // The *rendered* drawing is attached — pixels, not the source document.
    expect((reviewParts[0].image_url as { url: string }).url).toMatch(/^data:image\/png;base64,/);
    expect(isPng(attachedPng(review))).toBe(true);
    // The instruction asks for the strict JSON shape and names the subject under review.
    expect(reviewParts[1].text).toMatch(/a red apple/);
    expect(reviewParts[1].text as string).toMatch(/JSON/);
    expect((review.messages as Array<Record<string, unknown>>)[0].content).toMatch(
      /visual quality reviewer/,
    );

    // ── Call 3: the revision, by the drawing model ──
    const revision = bodyOf(fetchMock, 2);
    expect(revision.model).toBe('default-model');
    const revisionMessages = revision.messages as Array<Record<string, unknown>>;
    // The original specification is still present, so the revision is an edit of it rather
    // than a fresh prompt that happens to reuse a word.
    expect(revisionMessages[0].content).toMatch(/image generation backend/);
    // No two user turns in a row: the message list stays a legal conversation.
    for (let i = 1; i < revisionMessages.length; i++) {
      expect(revisionMessages[i].role === 'user' && revisionMessages[i - 1].role === 'user').toBe(
        false,
      );
    }
    const revisionTurn = revisionMessages.at(-1)!.content as string;
    expect(revisionTurn).toMatch(/vision model/);
    expect(revisionTurn).toMatch(/the apple is blue, not red/);
    expect(revisionTurn).toMatch(/fill the fruit with red/);
    // The document under revision is carried back, so the model edits rather than re-draws.
    expect(revisionTurn).toContain(VALID_SVG);

    // ── The revised drawing is what is delivered ──
    expect(result.images[0].svg).toBe(REVISED_SVG);
    expect(result.images[0].mime).toBe('image/png');
    expect(result.model).toBe('default-model');
  });

  it('delivers the revised document when the caller asked for svg', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(reply(REVISE_JSON))
      .mockResolvedValueOnce(reply(REVISED_SVG));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(
      req({ output: { format: 'svg', delivery: 'base64' } }),
    );

    expect(result.images[0].svg).toBe(REVISED_SVG);
    expect(result.images[0].mime).toBe('image/svg+xml');
  });

  it('rasterizes the review attachment at the requested size', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(reply(REVISE_JSON))
      .mockResolvedValueOnce(reply(REVISED_SVG));
    vi.stubGlobal('fetch', fetchMock);

    await provider().generate(req({ size: { width: 256, height: 256 } }));

    const bytes = Buffer.from(attachedPng(bodyOf(fetchMock, 1)), 'base64');
    // IHDR carries the dimensions big-endian at bytes 16..24 of a PNG.
    expect(bytes.readUInt32BE(16)).toBe(256);
  });

  it('runs several rounds when the reviewer keeps asking for changes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(reply(REVISE_JSON))
      .mockResolvedValueOnce(reply(REVISED_SVG))
      .mockResolvedValueOnce(reply(REVISE_JSON))
      .mockResolvedValueOnce(reply(REVISED_SVG));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider({ visionRefinementRounds: 2 }).generate(req());

    // 1 drawing + (review + revision) x 2
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.images[0].svg).toBe(REVISED_SVG);
    // Each review is of the drawing that exists at that point, not of the original.
    const secondReview = bodyOf(fetchMock, 3);
    expect((secondReview.messages as Array<Record<string, unknown>>)[0].content).toMatch(
      /visual quality reviewer/,
    );
  });

  it('stops early when the reviewer accepts the drawing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(reply(ACCEPT_JSON));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider({ visionRefinementRounds: 3 }).generate(req());

    // A drawing that has been judged satisfactory is not re-reviewed: two calls, no revision.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.images[0].svg).toBe(VALID_SVG);
  });
});

// ─── Malformed review output ─────────────────────────────────

describe('chat provider — an unusable review never rewrites the drawing', () => {
  /** Every one of these replies means "we do not know what the reviewer thought". */
  const UNUSABLE: Array<[string, string]> = [
    ['plain prose instead of JSON', 'The image looks reasonable to me, though the apple is blue.'],
    ['empty content', ''],
    ['a JSON array rather than an object', '[{"verdict":"revise","issues":["x"]}]'],
    ['truncated JSON', '{"verdict":"revise","issues":['],
    ['no verdict field', '{"summary":"looks fine","issues":[],"suggestions":[]}'],
    ['an unknown verdict', '{"verdict":"maybe","issues":["blue apple"]}'],
    ['revise with nothing to act on', '{"verdict":"revise","summary":"not right","issues":[]}'],
    ['a reply with no text content at all', ''],
  ];

  for (const [name, content] of UNUSABLE) {
    it(`keeps the original drawing for ${name}`, async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(reply(VALID_SVG))
        .mockResolvedValueOnce(replyWithoutContent())
        .mockResolvedValueOnce(reply(content));
      vi.stubGlobal('fetch', fetchMock);

      const result = await provider().generate(req());

      // Two calls: the drawing, then the review. No revision is attempted, because there is
      // no critique to revise against.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.images[0].svg).toBe(VALID_SVG);
      expect(result.images[0].mime).toBe('image/png');
    });
  }

  it('accepts a fenced or prefaced JSON object, the common formatting habit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(reply('Here is my review:\n```json\n' + REVISE_JSON + '\n```'))
      .mockResolvedValueOnce(reply(REVISED_SVG));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.images[0].svg).toBe(REVISED_SVG);
  });

  it('does not revise on a critique whose verdict contradicts its own instructions', async () => {
    // An "accept" that also lists issues is contradictory. Accepting the verdict stops the
    // loop, which is the conservative reading: nothing is rewritten without a clear ask.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(
        reply('{"verdict":"accept","summary":"fine","issues":["but the apple is blue"]}'),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.images[0].svg).toBe(VALID_SVG);
  });
});

// ─── Failures preserve the last valid image ──────────────────

describe('chat provider — refinement failures preserve the last valid image', () => {
  it('keeps the drawing when the review call errors upstream', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(upstreamError(400, 'content_policy', 'image rejected'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req());

    expect(result.images[0].svg).toBe(VALID_SVG);
    expect(result.images[0].mime).toBe('image/png');
  });

  it('keeps the drawing when the review call fails at the transport level', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req());
    expect(result.images[0].svg).toBe(VALID_SVG);
  });

  it('keeps the drawing when the revision call errors upstream', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(reply(REVISE_JSON))
      .mockResolvedValueOnce(upstreamError(429, 'rate_limited', 'slow down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req());
    expect(result.images[0].svg).toBe(VALID_SVG);
  });

  it('keeps the drawing when the revision returns prose', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(reply(REVISE_JSON))
      .mockResolvedValueOnce(reply('Sure! Here is my thinking about the revision...'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.images[0].svg).toBe(VALID_SVG);
  });

  it('keeps the drawing when the revision is refused by the SVG gate', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(reply(REVISE_JSON))
      .mockResolvedValueOnce(
        reply('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req());

    // A revision that would have shipped an executable document is discarded, and the
    // already-correct drawing is delivered rather than the round aborting the request.
    expect(result.images[0].svg).toBe(VALID_SVG);
    expect(result.images[0].mime).toBe('image/png');
  });

  it('stops a multi-round pass at the first failed round and keeps the last good drawing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(reply(REVISE_JSON))
      .mockResolvedValueOnce(reply(REVISED_SVG))
      .mockResolvedValueOnce(upstreamError(500, 'internal', 'boom'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider({ visionRefinementRounds: 3 }).generate(req());

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.images[0].svg).toBe(REVISED_SVG);
  });

  it('still reports a failed initial generation as terminal, without trying to refine', async () => {
    // The one failure the pass must never absorb. No image was produced, so there is nothing
    // to review, nothing to preserve, and no honest way to return success.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply('I cannot draw that.'))
      .mockResolvedValueOnce(reply('I still cannot draw that.'));
    vi.stubGlobal('fetch', fetchMock);

    const error = await provider()
      .generate(req())
      .catch((e: unknown) => e as ProviderError);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('unsupported_output');
    expect(error.retryable).toBe(false);
    // The format-repair turn only: no review, no revision.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not refine a raster the model returned directly', async () => {
    // There is no document text to hand back for revision, so rather than reconstruct one
    // the pass is skipped instead of guessing.
    const fetchMock = vi.fn().mockResolvedValueOnce(reply('![i](data:image/png;base64,QUJD)'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.images[0].base64).toBe('QUJD');
  });
});

// ─── Nothing secret or raw leaves the provider ───────────────

describe('chat provider — refinement messages stay clean', () => {
  it('never puts a credential or a raw upstream body into a review or revision message', async () => {
    // The review fails with a body that echoes a key-shaped string, which is exactly what an
    // upstream 401 body does in practice. The pass must swallow the failure *and* keep the
    // secret out of everything it sent — including the review turn that already went out.
    const secret = 'sk-live-abcdef123456';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(
        jsonResponse(`{"error":{"message":"invalid api key ${secret}"}}`, { status: 401 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().generate(req());

    // The drawing is delivered: a failed quality pass does not fail the generation.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.images[0].svg).toBe(VALID_SVG);
    expect(result.images[0].mime).toBe('image/png');

    // Nothing the provider sent carried the credential or the raw body.
    for (const call of fetchMock.mock.calls) {
      expect(call[1].body as string).not.toContain(secret);
    }
  });

  it('keeps the upstream error status and code, without echoing its raw body as the message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply('I cannot draw that.'))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { message: 'invalid api key', code: 'invalid_api_key' } },
          { status: 401 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const error = await provider()
      .generate(req())
      .catch((e: unknown) => e as ProviderError);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(401);
    expect(error.code).toBe('invalid_api_key');
    expect(error.message).toBe('invalid api key');
    // The raw body is kept for operators only, never as the client-facing message.
    expect(error.upstreamBody).toContain('invalid api key');
  });

  it('sends the review turn to the chat endpoint with the same bearer scheme', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(VALID_SVG))
      .mockResolvedValueOnce(reply(ACCEPT_JSON));
    vi.stubGlobal('fetch', fetchMock);

    await provider().generate(req());

    const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

// ─── parseReview is a pure gate ──────────────────────────────

describe('parseReview', () => {
  it('reads the documented shape', () => {
    const critique = parseReview(REVISE_JSON);
    expect(critique).toEqual({
      verdict: 'revise',
      summary: 'The subject is the wrong colour.',
      issues: ['the apple is blue, not red'],
      suggestions: ['fill the fruit with red'],
    });
  });

  it('reads the shape out of a content-part array', () => {
    expect(parseReview([{ type: 'text', text: REVISE_JSON }])?.verdict).toBe('revise');
  });

  it('accepts a bare string issue list', () => {
    const critique = parseReview('{"verdict":"revise","issues":"the apple is blue"}');
    expect(critique?.issues).toEqual(['the apple is blue']);
  });

  it('supplies a summary when the reviewer omitted one', () => {
    const accepted = parseReview('{"verdict":"accept"}');
    expect(accepted?.verdict).toBe('accept');
    expect(accepted?.summary).toBeTruthy();

    const revised = parseReview('{"verdict":"revise","issues":["blue apple"]}');
    expect(revised?.summary).toBeTruthy();
  });

  it('normalizes the boolean checklist emitted by the live GLM vision route', () => {
    const critique = parseReview(
      JSON.stringify({
        polished_illustration: true,
        clear_glass: true,
        fern_leaves: true,
        warm_light: true,
        balanced_composition: true,
        no_text: true,
      }),
    );

    expect(critique).toMatchObject({ verdict: 'accept', issues: [], suggestions: [] });
  });

  it('turns a failed GLM checklist criterion into an actionable revision', () => {
    const critique = parseReview(
      JSON.stringify({
        polished_illustration: false,
        clear_glass: true,
        fern_leaves: true,
        warm_light: true,
        balanced_composition: true,
        no_text: true,
      }),
    );

    expect(critique?.verdict).toBe('revise');
    expect(critique?.issues[0]).toMatch(/polished|detailed/i);
    expect(critique?.suggestions[0]).toMatch(/polished|detailed/i);
  });

  it('normalizes the numeric score and reason emitted by GLM for a detailed review', () => {
    const critique = parseReview(
      JSON.stringify({
        score: 5,
        reason: 'The subject is present, but the rendering is too flat and lacks detail.',
      }),
    );

    expect(critique?.verdict).toBe('revise');
    expect(critique?.issues[0]).toMatch(/flat|detail/i);
    expect(critique?.suggestions[0]).toMatch(/defect|reviewer/i);
  });

  it('normalizes GLM numeric reviews nested under evaluation', () => {
    const critique = parseReview(
      JSON.stringify({
        evaluation: {
          request_fulfilled: false,
          score: 0.35,
          reason: 'The plants are sparse and the glass has no convincing reflections.',
        },
        criteria_analysis: { lush_fern_leaves: 'missing' },
      }),
    );

    expect(critique).toMatchObject({
      verdict: 'revise',
      issues: ['The plants are sparse and the glass has no convincing reflections.'],
    });
  });

  it('caps how much a reviewer can contribute to the next prompt', () => {
    const critique = parseReview(
      JSON.stringify({
        verdict: 'revise',
        issues: Array.from({ length: 50 }, (_, i) => `issue ${i} ${'x'.repeat(2000)}`),
      }),
    );

    expect(critique!.issues.length).toBeLessThanOrEqual(6);
    for (const issue of critique!.issues) expect(issue.length).toBeLessThanOrEqual(401);
  });

  it('returns null rather than guessing', () => {
    expect(parseReview(null)).toBeNull();
    expect(parseReview(undefined)).toBeNull();
    expect(parseReview('')).toBeNull();
    expect(parseReview('no json here at all')).toBeNull();
    expect(parseReview('{"verdict":"revise"}')).toBeNull();
    expect(parseReview('{"verdict":"nonsense","issues":["x"]}')).toBeNull();
  });
});
