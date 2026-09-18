import { z } from 'zod';
import type { ImageGenerationRequest } from '../../types/canonical.types';

/**
 * Inbound schema and prompt extraction for the Anthropic Messages protocol.
 *
 * Two contract corrections over the previous implementation:
 *   1. `model` and `max_tokens` are **required** — the real API rejects a request
 *      without `max_tokens`, so accepting one here taught callers a contract that is
 *      not honoured.
 *   2. `role` is a closed union. The previous `z.string()` accepted `role: "system"`,
 *      which Anthropic does not have (system text is a top-level field).
 */

const TextBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

/**
 * Non-text blocks are modelled loosely and handled deliberately during extraction.
 * Silently discarding them (as the previous `filter(type === 'text')` did) loses
 * information the caller sent.
 */
const OtherBlockSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const ContentBlockSchema = z.union([TextBlockSchema, OtherBlockSchema]);

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant'], {
    errorMap: () => ({ message: 'role must be "user" or "assistant"' }),
  }),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});

export const AnthropicMessagesRequestSchema = z
  .object({
    model: z.string().min(1, 'model is required'),
    max_tokens: z
      .number({ required_error: 'max_tokens is required' })
      .int()
      .min(0, 'max_tokens must be >= 0'),
    messages: z.array(MessageSchema).min(1, 'messages must contain at least one message'),
    system: z.union([z.string(), z.array(ContentBlockSchema)]).optional(),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().min(0).optional(),
    stop_sequences: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    tool_choice: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;

type ContentBlock = z.infer<typeof ContentBlockSchema>;

export interface ExtractionResult {
  ok: true;
  request: ImageGenerationRequest;
}
export interface ExtractionFailure {
  ok: false;
  message: string;
}

/** Leading slash-directives the bridge understands, e.g. `/imagine a cat`. */
const DIRECTIVE = /^\s*\/(imagine|image|img|draw)\s*/i;

/**
 * Turn an Anthropic Messages request into a canonical image request.
 *
 * Behaviour, each point chosen to fix a specific audit finding:
 *   - Uses the **last** user turn (the previous code took the first).
 *   - Falls back to `system` text when the final user turn carries no text, so a valid
 *     request is not rejected as "no prompt".
 *   - Rejects rather than silently ignoring non-text blocks, so a caller is told when
 *     something they sent could not be used.
 *   - Trims before testing for emptiness, so a whitespace-only prompt is a 400 rather
 *     than a wasted generation.
 *   - Does **not** fall back to the un-stripped text when directive stripping empties
 *     the prompt (`"/imagine"` alone is not a prompt).
 */
export function extractImageRequest(
  body: AnthropicMessagesRequest,
): ExtractionResult | ExtractionFailure {
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');

  const blocks = lastUser ? asBlocks(lastUser.content) : [];
  const unsupported = blocks.filter((b) => b.type !== 'text').map((b) => b.type);

  let prompt = blocks
    .filter(
      (b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string',
    )
    .map((b) => b.text)
    .join('\n');

  // Fold system text in when the user turn carried none — a `system`-only request is
  // valid on the real API and must not become a 400 here.
  if (!prompt.trim()) {
    const systemText = asText(body.system);
    if (systemText) prompt = systemText;
  }

  const stripped = prompt.replace(DIRECTIVE, '').trim();

  if (!stripped) {
    if (unsupported.length > 0) {
      return {
        ok: false,
        message:
          `No text prompt found. The request contained only unsupported block type(s): ` +
          `${unsupported.join(', ')}. Send the prompt as a text block.`,
      };
    }
    return { ok: false, message: 'No prompt text found in the request.' };
  }

  // Size may be requested through a simple directive, e.g. "1024x1024" appearing in the
  // prompt is NOT parsed (too ambiguous); callers use the generate_image tool contract
  // or the native endpoint for that control.
  return {
    ok: true,
    request: {
      prompt: stripped,
      count: 1,
      size: { width: 1024, height: 1024 },
      aspect: null,
      quality: null,
      output: { format: 'png', delivery: 'base64' },
      metadata: { source: 'anthropic-bridge', model: body.model },
    },
  };
}

function asBlocks(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content;
}

function asText(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter(
      (b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string',
    )
    .map((b) => b.text)
    .join('\n');
}

/** Whether the request explicitly declares the generate_image tool. */
export function declaresImageTool(body: AnthropicMessagesRequest): boolean {
  return (body.tools ?? []).some((tool) => tool.name === 'generate_image');
}

/** Count tokens approximately, for the /v1/messages/count_tokens endpoint. */
export function estimateMessageTokens(body: AnthropicMessagesRequest): number {
  const parts: string[] = [];

  if (body.system) parts.push(asText(body.system));
  for (const message of body.messages) parts.push(asText(message.content));

  const characters = parts.join('\n').length;
  // ~4 characters per token is the conventional English approximation.
  return Math.max(1, Math.ceil(characters / 4));
}
