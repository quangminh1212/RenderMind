import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  planPrompt,
  parsePlannedPrompt,
  composePrompt,
  buildPromptPlanner,
} from '../../../src/providers/prompt.planner';
import type { ImageGenerationRequest } from '../../../src/types/canonical.types';

/**
 * Prompt-planner tests.
 *
 * The planner is the only place in the native path where an upstream's *words* become part of
 * the request sent to the image endpoint, so these tests pin three things and nothing else:
 *
 *   1. **What is sent** — a fixed, JSON-only instruction, at temperature 0, with the caller's
 *      constraints listed so the model is told which parts are inviolable.
 *   2. **What is parsed** — tolerant of packaging, strict about content, and never producing a
 *      prompt the planner did not actually author.
 *   3. **What is preserved** — negative, style and aspect survive even when the planner
 *      omits them, because an expansion that drops "no text" has made the image worse.
 *
 * A fourth property is asserted below `planPrompt`: it never throws. That is the invariant the
 * native provider relies on when it falls back to the original prompt.
 */

function req(over: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    prompt: 'a fox in the snow',
    count: 1,
    size: null,
    aspect: null,
    quality: null,
    output: { format: 'png', delivery: 'base64' },
    ...over,
  };
}

function plannerConfig(over: Partial<Parameters<typeof planPrompt>[0]> = {}) {
  return {
    apiKey: 'planner-key',
    baseUrl: 'https://gateway.example.com/v1',
    model: 'planner-model',
    ...over,
  };
}

/** A chat-completions reply carrying `text` as the assistant message content. */
function chatResponse(text: string, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content: text } }] }),
    text: async () => text,
  } as unknown as Response;
}

/** The JSON body of the nth fetch call. */
function sentBody(mock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  return JSON.parse((mock.mock.calls[call][1] as { body: string }).body);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── parsePlannedPrompt: what is accepted ────────────────────

describe('parsePlannedPrompt', () => {
  it('reads the authored prompt from a strict JSON object', () => {
    const out = parsePlannedPrompt(
      '{"prompt":"a red fox trotting through deep powder snow at golden hour"}',
      req(),
    );
    expect(out).toContain('a red fox trotting through deep powder snow at golden hour');
  });

  it('accepts JSON wrapped in a markdown fence', () => {
    // Packaging is presentation; a model that fenced its JSON still answered the question.
    const out = parsePlannedPrompt('```json\n{"prompt":"a fox in snow, low angle"}\n```', req());
    expect(out).toContain('a fox in snow, low angle');
  });

  it('accepts a content-part reply, joining text parts', () => {
    // Parts are joined with a newline. A split inside a JSON *string* would inject a control
    // character and rightly fail to parse, so the fixture splits between fields — which is
    // where a real gateway chunks a streamed reply.
    const out = parsePlannedPrompt(
      [
        { type: 'text', text: '{"prompt":"a fox in snow",' },
        { type: 'text', text: '"style":"ink"}' },
      ],
      req(),
    );
    expect(out).toContain('a fox in snow');
    expect(out).toContain('Style: ink');
  });

  it('accepts the camelCase spelling of every field', () => {
    const out = parsePlannedPrompt(
      '{"prompt":"a fox","negative":"text","style":"oil painting","aspectRatio":"16:9"}',
      req(),
    );
    expect(out).toContain('Avoid: text');
    expect(out).toContain('Style: oil painting');
    expect(out).toContain('Aspect ratio: 16:9');
  });
});

// ─── parsePlannedPrompt: what is refused ─────────────────────

describe('parsePlannedPrompt refusal', () => {
  it('returns null when there is no usable prompt field', () => {
    expect(parsePlannedPrompt('{"negative":"text"}', req())).toBeNull();
  });

  it('returns null on a non-JSON reply', () => {
    expect(parsePlannedPrompt('Here is your prompt: a fox in the snow', req())).toBeNull();
  });

  it('returns null on an empty reply', () => {
    expect(parsePlannedPrompt('', req())).toBeNull();
    expect(parsePlannedPrompt(null, req())).toBeNull();
    expect(parsePlannedPrompt(undefined, req())).toBeNull();
  });

  it('returns null when the planner echoed the refusal sentinel', () => {
    // A planner that declined has not expanded anything. The caller's prompt is used and
    // genuine moderation stays at the image endpoint.
    expect(parsePlannedPrompt('{"prompt":"NO_IMAGE"}', req())).toBeNull();
    expect(parsePlannedPrompt('{"prompt":"  no_image  "}', req())).toBeNull();
  });

  it('reads the first JSON object even when the reply wraps it in an array', () => {
    // Tolerance is deliberate: the parser locates the first `{` .. last `}` region, so an
    // array-wrapped object still yields its fields. Only a reply with no object at all is
    // refused.
    expect(parsePlannedPrompt('[{"prompt":"a fox"}]', req())).toContain('a fox');
  });
});

// ─── parsePlannedPrompt: constraint preservation ─────────────

describe('parsePlannedPrompt preserves caller constraints', () => {
  it('re-applies the request negative prompt when the planner drops it', () => {
    const out = parsePlannedPrompt(
      '{"prompt":"a detailed fox in snow"}',
      req({
        negativePrompt: 'text, watermark',
      }),
    );
    expect(out).toContain('a detailed fox in snow');
    expect(out).toContain('Avoid: text, watermark');
  });

  it('prefers the planner negative when it supplied one', () => {
    const out = parsePlannedPrompt(
      '{"prompt":"a fox","negative":"blurry, low detail"}',
      req({ negativePrompt: 'text' }),
    );
    expect(out).toContain('Avoid: blurry, low detail');
    expect(out).not.toContain('Avoid: text');
  });

  it('re-applies style and aspect from the request when the planner omits them', () => {
    const out = parsePlannedPrompt(
      '{"prompt":"a fox in snow"}',
      req({ style: 'watercolour', aspect: '16:9' }),
    );
    expect(out).toContain('Style: watercolour');
    expect(out).toContain('Aspect ratio: 16:9');
  });

  it('bounds a pathologically long expansion', () => {
    const out = parsePlannedPrompt(`{"prompt":"${'x'.repeat(5000)}"}`, req());
    // The authored subject is clipped, so a verbose planner cannot push the prompt past the
    // native endpoint's budget.
    expect(out!.length).toBeLessThan(5000);
  });

  it('collapses whitespace in the authored prompt', () => {
    const out = parsePlannedPrompt('{"prompt":"a   fox\\nin\\nsnow"}', req());
    expect(out).toContain('a fox in snow');
  });
});

// ─── composePrompt ───────────────────────────────────────────

describe('composePrompt', () => {
  it('emits only the subject when nothing else is present', () => {
    expect(composePrompt({ subject: 'a fox' })).toBe('a fox');
  });

  it('appends style, aspect and negative in a fixed order', () => {
    expect(
      composePrompt({ subject: 'a fox', style: 'ink', aspectRatio: '1:1', negative: 'text' }),
    ).toBe('a fox\nStyle: ink\nAspect ratio: 1:1\nAvoid: text');
  });

  it('ignores blank optional parts', () => {
    expect(composePrompt({ subject: 'a fox', style: '  ', negative: '' })).toBe('a fox');
  });
});

// ─── planPrompt: the network call ────────────────────────────

describe('planPrompt', () => {
  it('sends a JSON-only, temperature-0 planning turn to the chat endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('{"prompt":"a rich fox prompt"}'));
    vi.stubGlobal('fetch', fetchMock);

    const out = await planPrompt(plannerConfig(), req({ negativePrompt: 'text' }));

    expect(out).toContain('a rich fox prompt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example.com/v1/chat/completions');

    const body = sentBody(fetchMock);
    expect(body.model).toBe('planner-model');
    expect(body.temperature).toBe(0);

    const messages = body.messages as Array<{ role: string; content: string }>;
    // The system turn demands JSON and forbids judging the request.
    expect(messages[0].content).toContain('exactly one JSON object');
    expect(messages[0].content).toContain('Do not judge');
    // The user turn names the constraint the planner must carry through.
    expect(messages[1].content).toContain('Must avoid: text');
  });

  it('defaults the base URL trailing slash away', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('{"prompt":"a fox"}'));
    vi.stubGlobal('fetch', fetchMock);

    await planPrompt(plannerConfig({ baseUrl: 'https://gateway.example.com/v1///' }), req());

    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example.com/v1/chat/completions');
  });

  it('returns the original-compatible null when the endpoint errors', async () => {
    // The caller contract: null means "use the original prompt", never "throw".
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('boom', { status: 500 })));
    await expect(planPrompt(plannerConfig(), req())).resolves.toBeNull();
  });

  it('never throws when the network itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(planPrompt(plannerConfig(), req())).resolves.toBeNull();
  });

  it('never throws when the body is not valid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      } as unknown as Response),
    );
    await expect(planPrompt(plannerConfig(), req())).resolves.toBeNull();
  });

  it('does nothing, and makes no call, without a key', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await planPrompt(plannerConfig({ apiKey: '' }), req())).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing, and makes no call, without a model', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await planPrompt(plannerConfig({ model: '' }), req())).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honours an explicit token budget', async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatResponse('{"prompt":"a fox"}'));
    vi.stubGlobal('fetch', fetchMock);

    await planPrompt(plannerConfig({ maxTokens: 123 }), req());
    expect(sentBody(fetchMock).max_tokens).toBe(123);
  });
});

// ─── buildPromptPlanner ──────────────────────────────────────

describe('buildPromptPlanner', () => {
  it('returns undefined when no config is supplied', () => {
    expect(buildPromptPlanner(undefined)).toBeUndefined();
  });

  it('returns undefined for a half-configured planner', () => {
    expect(buildPromptPlanner(plannerConfig({ apiKey: '' }))).toBeUndefined();
    expect(buildPromptPlanner(plannerConfig({ model: '' }))).toBeUndefined();
  });

  it('returns a bound planner that plans the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(chatResponse('{"prompt":"expanded"}')));
    const planner = buildPromptPlanner(plannerConfig());
    expect(planner).toBeDefined();
    await expect(planner!(req())).resolves.toContain('expanded');
  });
});
