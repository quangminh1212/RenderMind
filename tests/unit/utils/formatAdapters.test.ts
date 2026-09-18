import { describe, it, expect } from 'vitest';
import {
  toOpenAIImagesResponse,
  toAnthropicMessagesResponse,
  toAnthropicError,
  toOpenAIError,
  anthropicErrorTypeFor,
  satisfiesFormat,
  estimateTokens,
  IMAGE_TOOL_NAME,
} from '../../../src/utils/formatAdapters';
import type { ImageGenerationResult } from '../../../src/types/canonical.types';

/**
 * Unit tests for the response builders.
 *
 * These pin the protocol contracts that the audit found violated:
 *   - a `b64_json` request must never silently receive a `url`
 *   - the Anthropic response must not contain an `image` block by default (there is no
 *     such member in the response ContentBlock union)
 *   - usage must not be fabricated as zeros
 *   - the Anthropic error taxonomy must be complete (402/409/504/529 included)
 */

const result = (over: Partial<ImageGenerationResult> = {}): ImageGenerationResult => ({
  images: [{ base64: 'QUJD', mime: 'image/png' }],
  provider: 'fake',
  model: 'fake-model',
  timings: { queueMs: 0, providerMs: 100, totalMs: 110 },
  cached: false,
  adaptations: {},
  ...over,
});

const openaiOptions = {
  format: 'b64_json' as const,
  created: 1_700_000_000,
  generationId: 'gen_abc',
  includeMetadata: false,
};

describe('toOpenAIImagesResponse', () => {
  it('returns b64_json when base64 is available', () => {
    const out = toOpenAIImagesResponse(result(), openaiOptions);
    expect(out.data[0].b64_json).toBe('QUJD');
    expect(out.created).toBe(1_700_000_000);
  });

  it('uses a single `created` timestamp for the whole response', () => {
    const out = toOpenAIImagesResponse(
      result({
        images: [
          { base64: 'A', mime: 'image/png' },
          { base64: 'B', mime: 'image/png' },
        ],
      }),
      openaiOptions,
    );
    expect(out.created).toBe(1_700_000_000);
    expect(out.data).toHaveLength(2);
  });

  it('omits the non-standard metadata block by default', () => {
    const out = toOpenAIImagesResponse(result(), openaiOptions);
    expect(out._rendermind).toBeUndefined();
  });

  it('includes metadata only when explicitly enabled', () => {
    const out = toOpenAIImagesResponse(result(), { ...openaiOptions, includeMetadata: true });
    expect(out._rendermind?.provider).toBe('fake');
    expect(out._rendermind?.id).toBe('gen_abc');
  });

  it('surfaces revised_prompt when the provider rewrote the prompt', () => {
    const out = toOpenAIImagesResponse(
      result({ images: [{ base64: 'QUJD', mime: 'image/png', revisedPrompt: 'A red apple' }] }),
      openaiOptions,
    );
    expect(out.data[0].revised_prompt).toBe('A red apple');
  });

  it('emits url when url delivery is requested', () => {
    const out = toOpenAIImagesResponse(
      result({ images: [{ url: 'https://x/y.png', mime: 'image/png' }] }),
      { ...openaiOptions, format: 'url' },
    );
    expect(out.data[0].url).toBe('https://x/y.png');
    expect(out.data[0].b64_json).toBeUndefined();
  });

  it('does NOT substitute a url for a requested b64_json', () => {
    const out = toOpenAIImagesResponse(
      result({ images: [{ url: 'https://x/y.png', mime: 'image/png' }] }),
      openaiOptions,
    );
    // The previous implementation silently returned {url} here, breaking
    // Buffer.from(data[0].b64_json) for every strict client.
    expect(out.data[0].b64_json).toBeUndefined();
    expect(out.data[0].url).toBeUndefined();
  });

  it('produces a usable data URI when a url is requested from a base64-only result', () => {
    const out = toOpenAIImagesResponse(result(), { ...openaiOptions, format: 'url' });
    expect(out.data[0].url).toMatch(/^data:image\/png;base64,QUJD$/);
  });
});

describe('satisfiesFormat', () => {
  it('is false when fewer images were produced than requested', () => {
    expect(satisfiesFormat(result(), 'b64_json', 3)).toBe(false);
  });

  it('is false for b64_json when only a url is available', () => {
    expect(
      satisfiesFormat(
        result({ images: [{ url: 'https://x/y.png', mime: 'image/png' }] }),
        'b64_json',
        1,
      ),
    ).toBe(false);
  });

  it('is true when the format is deliverable', () => {
    expect(satisfiesFormat(result(), 'b64_json', 1)).toBe(true);
  });
});

describe('toAnthropicMessagesResponse', () => {
  const anthropicOptions = {
    model: 'rendermind-bridge',
    prompt: 'a red apple',
    generationId: 'gen_abc123',
    imageBlockMode: 'off' as const,
  };

  it('emits only content block types legal in an Anthropic response', () => {
    const out = toAnthropicMessagesResponse(result(), anthropicOptions);
    const legal = ['text', 'tool_use', 'thinking', 'redacted_thinking'];
    for (const block of out.content) {
      expect(legal).toContain(block.type);
    }
  });

  it('uses tool_use by default, with stop_reason tool_use', () => {
    const out = toAnthropicMessagesResponse(result(), anthropicOptions);

    const toolUse = out.content.find((b) => b.type === 'tool_use');
    expect(toolUse).toBeDefined();
    expect((toolUse as any).name).toBe(IMAGE_TOOL_NAME);
    expect((toolUse as any).id).toMatch(/^toolu_/);
    expect(out.stop_reason).toBe('tool_use');
  });

  it('formats the message id in Anthropic style', () => {
    const out = toAnthropicMessagesResponse(result(), anthropicOptions);
    expect(out.id).toBe('msg_abc123');
  });

  it('reports non-zero estimated usage instead of fabricated zeros', () => {
    const out = toAnthropicMessagesResponse(result(), anthropicOptions);
    expect(out.usage.input_tokens).toBeGreaterThan(0);
    expect(out.usage.output_tokens).toBeGreaterThan(0);
  });

  it('emits an image block only in extension mode', () => {
    const out = toAnthropicMessagesResponse(result(), {
      ...anthropicOptions,
      imageBlockMode: 'extension',
    });

    const imageBlock = out.content.find((b) => b.type === 'image');
    expect(imageBlock).toBeDefined();
    expect((imageBlock as any).source.data).toBe('QUJD');
    expect((imageBlock as any).source.media_type).toBe('image/png');
    // The non-spec response is not a tool call.
    expect(out.stop_reason).toBe('end_turn');
  });

  it('never emits an image block when the extension is off', () => {
    const out = toAnthropicMessagesResponse(result(), anthropicOptions);
    expect(out.content.some((b) => b.type === 'image')).toBe(false);
  });
});

describe('estimateTokens', () => {
  it('approximates ~4 characters per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('')).toBe(1);
  });
});

describe('error envelopes', () => {
  it('maps the Anthropic error taxonomy exactly', () => {
    // Each of these is a real Anthropic error type. The previous implementation
    // collapsed everything >= 500 to api_error and could not express 529 at all.
    expect(anthropicErrorTypeFor(400)).toBe('invalid_request_error');
    expect(anthropicErrorTypeFor(401)).toBe('authentication_error');
    expect(anthropicErrorTypeFor(402)).toBe('billing_error');
    expect(anthropicErrorTypeFor(403)).toBe('permission_error');
    expect(anthropicErrorTypeFor(404)).toBe('not_found_error');
    expect(anthropicErrorTypeFor(409)).toBe('conflict_error');
    expect(anthropicErrorTypeFor(413)).toBe('request_too_large');
    expect(anthropicErrorTypeFor(429)).toBe('rate_limit_error');
    expect(anthropicErrorTypeFor(504)).toBe('timeout_error');
    expect(anthropicErrorTypeFor(529)).toBe('overloaded_error');
    expect(anthropicErrorTypeFor(500)).toBe('api_error');
  });

  it('builds an Anthropic error body with request_id', () => {
    const body = toAnthropicError('boom', 401, 'req_123');
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
    expect(body.request_id).toBe('req_123');
  });

  it('returns 401 for an invalid key, not 403', () => {
    // Anthropic treats an invalid credential as 401; the previous code returned 403.
    const body = toAnthropicError('Invalid API key', 401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('builds the openclaw error envelope', () => {
    const body = toOpenAIError('bad prompt', 400, 'prompt', 'invalid_request_error');
    expect(body.error.message).toBe('bad prompt');
    expect(body.error.param).toBe('prompt');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error).toHaveProperty('code');
  });

  it('maps openclaw error types by status', () => {
    expect(toOpenAIError('x', 401).error.type).toBe('authentication_error');
    expect(toOpenAIError('x', 429).error.type).toBe('rate_limit_error');
    expect(toOpenAIError('x', 500).error.type).toBe('server_error');
    expect(toOpenAIError('x', 400).error.type).toBe('invalid_request_error');
  });
});

describe('status mapping for upstream failures', () => {
  it('maps an upstream transport failure to api_error, not a bare 500', () => {
    // A ProviderError with no HTTP status means DNS/socket/timeout: the upstream is at
    // fault, so this must not be reported as a 500 from our own server.
    expect(anthropicErrorTypeFor(502)).toBe('api_error');
    expect(anthropicErrorTypeFor(500)).toBe('api_error');
    expect(anthropicErrorTypeFor(529)).toBe('overloaded_error');
  });

  it('keeps a caller-attributable failure as invalid_request_error', () => {
    expect(anthropicErrorTypeFor(400)).toBe('invalid_request_error');
    expect(anthropicErrorTypeFor(404)).toBe('not_found_error');
  });
});
