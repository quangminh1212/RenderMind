import type { ImageGenerationRequest } from '../types/canonical.types';
import { ProviderError } from '../engine/errors';
import { logger } from '../utils/logger';

/**
 * Optional LLM expansion of a caller's prompt before it reaches a **native** image endpoint.
 *
 * Why this exists: a diffusion endpoint is not a chat model, and the same short phrase that
 * makes a good chat prompt ("a fox in the snow") leaves a lot of an image model's control
 * surface unused — composition, medium, lighting, lens, palette. A text model is good at
 * turning that phrase into a *bounded, structured* description of an image, which the native
 * endpoint then consumes.
 *
 * What this is **not**: it does not make a text model into a diffusion model. It has no
 * weights, no decoder and no pixels; it only rewrites words that are already going to an
 * endpoint that does. The distinction is stated plainly and repeated in `.env.example`,
 * because "we added an AI prompt planner" is exactly the kind of claim that gets read as
 * "text models can now make images".
 *
 * Three invariants, all enforced below and pinned by tests:
 *
 *   1. **Off by default.** {@link NativeImageProvider} only reaches for the planner when the
 *      operator configured one, so zero-config behaviour is byte-identical to a build with
 *      no planner at all.
 *   2. **Native only.** The chat/SVG path never plans — a prompt planner that rewrites the
 *      subject of a drawing request would change what gets drawn, not how well. The planner
 *      is invoked from inside the native provider, so the chat path cannot reach it.
 *   3. **Never fatal.** Every failure — no key, non-JSON reply, empty expansion, timeout —
 *      is logged and swallowed; the caller's original prompt is sent. A quality-of-life
 *      feature must not turn a working generation into a failed one.
 *
 * What it preserves: negative, style and aspect intent are copied from the canonical request
 * onto the expanded prompt, because a planner that silently drops "no text" or the requested
 * aspect has made the image *worse* while looking more clever.
 */

export interface PromptPlannerConfig {
  /** Chat-completions endpoint that performs the expansion. */
  baseUrl: string;
  /** Model id that performs the expansion. */
  model: string;
  /** Bearer token. An empty value makes the planner unavailable. */
  apiKey: string;
  /**
   * Completion-token budget for the planner turn.
   *
   * Bounded by the caller. A planner is a single extra call whose whole output is a prompt,
   * so a large budget is a large bill for no benefit.
   */
  maxTokens?: number;
}

/** Default planner completion budget. */
const DEFAULT_MAX_TOKENS = 400;

/** Ceiling on the authored instruction the planner is allowed to return. */
const MAX_PLANNED_PROMPT_CHARS = 2000;

/** How long the planner call may take before the original prompt is used instead. */
const PLANNER_TIMEOUT_MS = 20000;

/**
 * What the planner is asked to do.
 *
 * The instruction is deliberately narrow and heavily constrained, because this is the one
 * place in the native path where an upstream's words become part of the sent request:
 *
 *   - **one JSON object, fixed keys** — so the reply can be parsed rather than guessed at;
 *   - **JSON only, no prose, no markdown** — a fence or a preamble is treated as a failure,
 *     not scraped, because scraping a reply we did not ask for is invention;
 *   - **explicitly no safety re-judgement** — the planner is not asked to refuse, moralise
 *     or sanitise. It is a prompt engineer. The caller's request already passed the
 *     capability matcher, and a planner that silently drops an edge-case subject would be a
 *     censorship layer wearing a style layer's clothes. Genuine upstream moderation still
 *     happens where it always did: at the image endpoint.
 *   - **preserve every explicit constraint** — negatives, aspect and style must survive.
 *
 * `prompt` is the single load-bearing field. The rest are returned for completeness and
 * never trusted as a source of truth for anything the canonical request already carries.
 */
const PLANNER_SYSTEM_INSTRUCTION = [
  'You write prompts for a text-to-image model.',
  'You are given a user request. Rewrite it into one richly descriptive image prompt.',
  'Describe subject, composition, setting, lighting, colour, mood, medium and lens where relevant.',
  'Preserve every explicit constraint in the request: subjects, counts, text to render, styles,',
  'colours, exclusions and aspect ratio must all survive unchanged in meaning.',
  'Do not add content the user did not ask for, and do not remove content they did.',
  'Do not judge, refuse, warn about, or comment on the request.',
  'Reply with exactly one JSON object and no other text, in this shape:',
  '{"prompt":"<the rewritten prompt>","negative":"<things to avoid, or empty>",',
  '"style":"<style, or empty>","aspect_ratio":"<ratio, or empty>"}',
  'The "prompt" value must be plain text, not markdown, and at most 1200 characters.',
].join(' ');

/**
 * The user turn: the raw request plus the fields the planner must carry through.
 *
 * The canonical fields are listed explicitly rather than buried in a JSON dump so the model
 * is told *which* constraints are inviolable, which is what makes "preserve negative" a
 * request rather than a hope.
 */
function plannerInstruction(request: ImageGenerationRequest): string {
  const lines = [
    `User request: ${request.prompt}`,
    request.negativePrompt ? `Must avoid: ${request.negativePrompt}` : '',
    request.style ? `Style the user asked for: ${request.style}` : '',
    request.aspect ? `Aspect ratio the user asked for: ${request.aspect}` : '',
    request.quality ? `Quality the user asked for: ${request.quality}` : '',
    'Rewrite it now as the JSON object described in your instructions.',
  ].filter(Boolean);

  return lines.join('\n');
}

/** A validated, bounded expansion. */
export interface PlannedPrompt {
  prompt: string;
  negative: string;
  style: string;
  aspectRatio: string;
}

/**
 * Expand a request's prompt for a native image endpoint.
 *
 * Returns the authored prompt text to send, or `null` when planning was unavailable or
 * produced nothing usable. It **never throws** and never returns a partial object: the
 * caller's contract is "use this string, or the original", and a half-parsed expansion is
 * not something the native path could act on.
 *
 * The provider decides *whether* to plan (configuration and `count === 1`); this function
 * decides *what to do* with the reply.
 */
export async function planPrompt(
  config: PromptPlannerConfig,
  request: ImageGenerationRequest,
): Promise<string | null> {
  if (config.apiKey.length === 0 || config.model.length === 0) return null;

  let content: unknown;
  try {
    content = await requestPlan(config, request);
  } catch (error) {
    // Honest degradation: the whole point of the planner is to improve a prompt, so any
    // failure at all yields the caller's own words rather than a failed generation. The
    // error text is logged, but only as a message — never the request body, which may
    // contain the operator's or the caller's data.
    logger.warn('Prompt planner call failed; using the original prompt', {
      provider: 'native',
      model: config.model,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const planned = parsePlannedPrompt(content, request);
  if (!planned) {
    logger.warn('Prompt planner reply was unusable; using the original prompt', {
      provider: 'native',
      model: config.model,
    });
    return null;
  }

  logger.info('Prompt planner expanded the prompt', {
    provider: 'native',
    model: config.model,
    originalChars: request.prompt.length,
    plannedChars: planned.length,
  });

  return planned;
}

/**
 * POST the planner turn and read back the assistant message.
 *
 * Isolated from {@link planPrompt} so the network call and the pure parsing are separable:
 * the parser is what most of the tests exercise, and it must be testable without a fetch
 * stub. Deliberately mirrors `ChatProvider.postChat`'s shape — a chat model is a chat model
 * whichever path uses it — including raising a typed `ProviderError` so a planner failure
 * is classified the same way any other upstream failure is.
 */
async function requestPlan(
  config: PromptPlannerConfig,
  request: ImageGenerationRequest,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: AbortSignal.timeout(PLANNER_TIMEOUT_MS),
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: PLANNER_SYSTEM_INSTRUCTION },
          { role: 'user', content: plannerInstruction(request) },
        ],
        // Deterministic: the planner is a rewrite, and a planner that returns a different
        // prompt for the same input makes the native path non-reproducible for no gain.
        temperature: 0,
        max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      }),
    });
  } catch (error) {
    throw new ProviderError({
      provider: 'native',
      message: `Prompt planner request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      cause: error,
    });
  }

  if (!response.ok) {
    // The status is the useful part; the body of a *planner* failure is not worth carrying
    // into the generation path, and could echo caller content back into logs.
    throw new ProviderError({
      provider: 'native',
      message: `Prompt planner returned ${response.status}`,
      status: response.status,
    });
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  return body.choices?.[0]?.message?.content;
}

/**
 * Parse the planner's reply into a bounded, sendable prompt.
 *
 * Tolerant about packaging (a markdown fence around the JSON, an `aspectRatio` spelling) and
 * strict about content, for the same reason `parseReview` is: a model that wrapped its JSON
 * still answered the question, while a reply with no usable `prompt` did not, and guessing
 * one would mean sending a prompt the planner did not commit to.
 *
 * The expansion is *composed* with the canonical request rather than replacing it:
 * {@link composePrompt} appends the negative/style/aspect lines the planner may have
 * dropped, so an incomplete planner cannot silently drop the caller's constraints.
 *
 * Exported so the parsing rules — the risky part — are unit-testable without a fetch.
 */
export function parsePlannedPrompt(
  content: unknown,
  request: ImageGenerationRequest,
): string | null {
  const text = readPlannerText(content);
  if (text.length === 0) return null;

  const parsed = parseJsonObject(text);
  if (!parsed) return null;

  const authored = readString(parsed, 'prompt');
  if (authored.length === 0) return null;

  // A planner that echoed a refusal into `prompt` has not expanded anything. The sentinel is
  // the chat path's; honouring it here keeps one vocabulary for "the model declined" rather
  // than two. The original prompt is used and genuine moderation stays at the image endpoint.
  if (authored.trim().toUpperCase() === 'NO_IMAGE') return null;

  const negative = readString(parsed, 'negative') || request.negativePrompt || '';
  const style = readString(parsed, 'style') || request.style || '';
  const aspectRatio = readString(parsed, 'aspect_ratio') || request.aspect || '';

  return composePrompt({
    subject: clip(authored, MAX_PLANNED_PROMPT_CHARS),
    negative,
    style,
    aspectRatio,
  });
}

/**
 * Fold the preserved constraints onto the authored subject.
 *
 * Kept separate and pure so the exact bytes the native endpoint receives are testable. The
 * `Avoid:` spelling matches {@link foldNegativePrompt}, which is the established way this
 * engine expresses a negative to a provider with no native field — reusing it keeps the two
 * folds recognisably the same idea.
 */
export function composePrompt(parts: {
  subject: string;
  negative?: string;
  style?: string;
  aspectRatio?: string;
}): string {
  const lines = [parts.subject.trim()];

  if (parts.style?.trim()) lines.push(`Style: ${parts.style.trim()}`);
  if (parts.aspectRatio?.trim()) lines.push(`Aspect ratio: ${parts.aspectRatio.trim()}`);
  if (parts.negative?.trim()) lines.push(`Avoid: ${parts.negative.trim()}`);

  return lines.join('\n');
}

/** Read `text` from an object, or `null` when there is not one to read. */
function readObjectText(value: unknown): string | null {
  if (typeof value === 'object' && value !== null) {
    const text = (value as Record<string, unknown>).text;
    if (typeof text === 'string') return text;
  }
  return null;
}

/**
 * Read the assistant text from a chat reply.
 *
 * Handles the string and content-part shapes, and joins parts, so a planner behind a gateway
 * that answers in the multimodal envelope is still usable. Only `text` parts contribute: an
 * image part in a *prompt planner's* reply is not something to parse.
 *
 * `.filter` is load-bearing, not tidiness: a non-text part (an image, a tool call) yields
 * `''`, and joining those into the JSON means `"{"prompt"...}"` no longer parses. Dropping
 * them lets a mixed-content reply still be read.
 */
function readPlannerText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;

  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map((part) => (typeof part === 'string' ? part : readObjectText(part)))
    .filter((text): text is string => text !== null)
    .join('\n');
}

/** The first JSON object in `text`, or `null` when there is not a parseable one. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Read a string field under either its snake_case or camelCase spelling.
 *
 * Both are accepted because models are inconsistent about it and neither spelling changes
 * the meaning; a missing field yields `''`, which the caller treats as "the planner said
 * nothing here, use the request's own value".
 */
function readString(record: Record<string, unknown>, key: string): string {
  const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  for (const candidate of [key, camel]) {
    const value = record[candidate];
    if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * The planner as seen by {@link NativeImageProvider}.
 *
 * A thin function type rather than a class so the provider can hold `undefined` for "no
 * planner configured" and tests can inject a stub without a fetch. The provider's contract
 * is narrow on purpose: it asks for a string, and anything that is not a string means
 * "use the original".
 */
export type PromptPlanner = (request: ImageGenerationRequest) => Promise<string | null>;

/**
 * Build a planner bound to one configuration, or `undefined` when none is configured.
 *
 * Returning `undefined` rather than a planner that always fails is what makes the disabled
 * path byte-identical: the provider skips the branch entirely, so no extra call, no extra
 * latency and no extra log line appears when the feature is off.
 */
export function buildPromptPlanner(
  config: PromptPlannerConfig | undefined,
): PromptPlanner | undefined {
  if (!config || config.apiKey.length === 0 || config.model.length === 0) return undefined;
  return (request: ImageGenerationRequest) => planPrompt(config, request);
}
