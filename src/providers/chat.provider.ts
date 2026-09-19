import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  GeneratedImage,
} from '../types/canonical.types';
import type { CapabilityDescriptor, ModelDescriptor } from '../types/capability.types';
import type { ImageProvider } from './provider.interface';
import { ProviderError } from '../engine/errors';
import { buildImageInstruction } from './prompt.builder';
import { logger } from '../utils/logger';

/**
 * Provider for text-only chat models that must be *asked* for an image.
 *
 * The premise this engine is built on: most capable models expose only
 * `POST {baseUrl}/chat/completions` and have no image endpoint at all. This provider
 * turns such a model into an image source by instructing it to answer with an image,
 * then extracting the payload from the chat response.
 *
 * Accepted response shapes, tried in order, because models differ:
 *   1. `content` parts carrying `image_url` (OpenAI multimodal shape)
 *   2. a `data:image/...;base64,...` URI anywhere in the text
 *   3. a bare image URL in the text (`.png`/`.jpg`/`.webp`, or a known CDN host)
 *   4. a JSON object with `b64_json` / `image_base64` / `images[]`, emitted as text
 *
 * A model that answers with prose and no image is a **terminal** failure
 * (`unsupported_output`), never a silent empty success: the whole point of this engine
 * is to report honestly when the upstream cannot actually produce pixels.
 */

/** Image URLs we are willing to fetch and inline when delivery demands base64. */
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i;

const DATA_URI = /data:image\/(png|jpe?g|webp|gif|avif);base64,([A-Za-z0-9+/=]+)/i;

/** A bare http(s) URL, used only when the text contains nothing better. */
const BARE_URL = /https?:\/\/[^\s"'<>)\]]+/gi;

export interface ChatProviderConfig {
  apiKey: string;
  baseUrl: string;
  /** Model used for text-only generation. */
  defaultModel: string;
  /** Model used when the request carries input images. */
  visionModel?: string;
  /** Additional model ids this endpoint accepts. */
  extraModels?: string[];
  /** Optional system prompt override, replacing the built-in instruction. */
  systemPrompt?: string;
}

export class ChatProvider implements ImageProvider {
  readonly name = 'chat';
  readonly displayName = 'Chat-completions model (image via instruction)';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly visionModel: string;
  private readonly extraModels: string[];
  private readonly systemPrompt?: string;

  constructor(config: ChatProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.defaultModel = config.defaultModel;
    this.visionModel = config.visionModel ?? config.defaultModel;
    this.extraModels = config.extraModels ?? [];
    this.systemPrompt = config.systemPrompt;
  }

  isAvailable(): boolean {
    // As with the previous provider design: a base URL without a key must not advertise
    // as available, or the matcher selects it and every request 401s upstream.
    return this.apiKey.length > 0;
  }

  getCapabilities(): CapabilityDescriptor {
    const modelIds = new Set<string>([this.defaultModel, this.visionModel, ...this.extraModels]);

    const models: ModelDescriptor[] = [...modelIds].map((id) => ({
      id,
      // A chat model does not constrain output pixels, so declare a wide range and let
      // the instruction carry the requested size.
      aspectRatios: [],
      sizes: { kind: 'range' as const, min: 64, max: 4096, multiple: 8 },
      qualityLevels: [],
      outputFormats: ['png', 'jpeg', 'webp'] as const,
    }));

    return {
      provider: this.name,
      displayName: this.displayName,
      models,
      features: {
        // No native field: the instruction folds it into the prompt text.
        negativePrompt: false,
        // No native seed either; disclosed as dropped rather than pretended.
        seed: false,
        steps: false,
        guidanceScale: false,
        quality: false,
        style: false,
        batch: false,
        // Only meaningful when a vision model is configured.
        imageToImage: this.visionModel.length > 0,
        inpainting: false,
        revisedPrompt: true,
        nativeBase64: true,
        nativeUrl: true,
      },
      limits: {
        maxBatch: 1,
        maxPromptChars: 32000,
        maxReferenceImages: 4,
        timeoutMs: 120000,
      },
      concurrency: 4,
      p50LatencyMs: 20000,
      status: this.isAvailable() ? 'available' : 'unavailable',
    };
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const started = Date.now();
    const hasReferences = Boolean(request.referenceImages?.length);
    const model = request.model ?? (hasReferences ? this.visionModel : this.defaultModel);

    const messages = this.buildMessages(request);
    const payload: Record<string, unknown> = {
      model,
      messages,
      // A deterministic-as-possible answer; the model must not editorialise.
      temperature: 0.2,
      max_tokens: 4096,
    };

    if (request.seed !== undefined) {
      // Not a standard field, but some gateways honour it. Harmless when ignored.
      payload.seed = request.seed;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(this.getCapabilities().limits.timeoutMs),
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new ProviderError({
        provider: this.name,
        message: `Upstream request failed: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }

    if (!response.ok) {
      throw await this.toProviderError(response);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };

    const content = body.choices?.[0]?.message?.content;
    const images = extractImages(content);

    // A model that answered with prose has not produced an image, and retrying will not
    // change that. Report it as a terminal capability failure rather than an empty result.
    if (images.length === 0) {
      throw new ProviderError({
        provider: this.name,
        message:
          `Model "${model}" returned no image. It answered with text only, so it cannot ` +
          'serve image generation. Configure a model that returns images (or an image URL).',
        code: 'unsupported_output',
        retryable: false,
      });
    }

    logger.info('Chat provider extracted images', {
      provider: this.name,
      model,
      count: images.length,
      usedReferences: hasReferences,
      elapsedMs: Date.now() - started,
    });

    return {
      images,
      provider: this.name,
      model,
      timings: { queueMs: 0, providerMs: Date.now() - started, totalMs: Date.now() - started },
      cached: false,
      adaptations: {},
    };
  }

  /**
   * Build the chat messages.
   *
   * The instruction is a *system* message so the model treats it as a standing
   * requirement rather than part of the subject to draw. Reference images, when present,
   * are attached as `image_url` content parts — the shape every multimodal openclaw-
   * compatible endpoint accepts — followed by the generation instruction.
   */
  private buildMessages(request: ImageGenerationRequest): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: this.systemPrompt ?? SYSTEM_INSTRUCTION },
    ];

    const instruction = buildImageInstruction(request);
    const refs = request.referenceImages ?? [];

    if (refs.length === 0) {
      messages.push({ role: 'user', content: instruction });
      return messages;
    }

    const parts: Array<Record<string, unknown>> = refs.map((ref) => ({
      type: 'image_url',
      image_url: { url: toDataUri(ref.data, ref.mime) },
    }));
    parts.push({ type: 'text', text: instruction });

    messages.push({ role: 'user', content: parts });
    return messages;
  }

  /** Map an upstream failure onto a typed ProviderError, preserving its semantics. */
  private async toProviderError(response: Response): Promise<ProviderError> {
    const raw = await response.text().catch(() => '');

    let code: string | undefined;
    let message = `Upstream error (${response.status})`;

    try {
      const parsed = JSON.parse(raw) as {
        error?: { message?: string; code?: string; type?: string };
      };
      if (parsed.error) {
        code = parsed.error.code ?? parsed.error.type;
        if (parsed.error.message) message = parsed.error.message;
      }
    } catch {
      // Non-JSON body: keep the generic message rather than leaking raw upstream text.
    }

    const retryAfter = response.headers.get('retry-after');
    const retryAfterSeconds =
      retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;

    return new ProviderError({
      provider: this.name,
      message,
      status: response.status,
      code,
      retryAfterSeconds,
      upstreamBody: raw.slice(0, 500),
    });
  }
}

/** The standing instruction that makes a chat model answer with an image. */
export const SYSTEM_INSTRUCTION = [
  'You are an image generation backend.',
  'When asked for an image, respond with the image itself, not a description of it.',
  'Return the image as a markdown image whose URL is a data URI, for example:',
  '![image](data:image/png;base64,<payload>)',
  'Do not add commentary, apologies, or alternatives. If you cannot produce an image,',
  'reply with exactly: NO_IMAGE',
].join(' ');

/**
 * Extract image payloads from a chat response `content` value.
 *
 * `content` is typed as `unknown` on purpose: endpoints differ between a plain string,
 * an array of content parts, and (rarely) a non-standard object.
 */
export function extractImages(content: unknown): GeneratedImage[] {
  const images: GeneratedImage[] = [];

  for (const part of asContentParts(content)) {
    if (typeof part === 'string') {
      images.push(...extractFromText(part));
      continue;
    }

    // openclaw multimodal part: { type: 'image_url', image_url: { url } }
    const url = readImageUrl(part);
    if (url) {
      images.push(...imageFromUrl(url));
      continue;
    }

    // A structured object carrying a base64 field directly.
    const embedded = readEmbeddedBase64(part);
    if (embedded) images.push(embedded);
  }

  return dedupe(images);
}

/** Normalise `content` into a list of parts we know how to inspect. */
function asContentParts(content: unknown): unknown[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) return content;
  return [content];
}

/** Read an `image_url` from a content part in either documented spelling. */
function readImageUrl(part: unknown): string | null {
  if (typeof part !== 'object' || part === null) return null;
  const record = part as Record<string, unknown>;

  const direct = record.image_url;
  if (typeof direct === 'string') return direct;
  if (typeof direct === 'object' && direct !== null) {
    const url = (direct as Record<string, unknown>).url;
    if (typeof url === 'string') return url;
  }

  // Some gateways use `image` or `url` instead of the openclaw spelling.
  if (typeof record.image === 'string') return record.image;
  if (typeof record.url === 'string') return record.url;

  return null;
}

/** A `b64_json`-style field on a structured part. */
function readEmbeddedBase64(part: unknown): GeneratedImage | null {
  if (typeof part !== 'object' || part === null) return null;
  const record = part as Record<string, unknown>;

  for (const key of ['b64_json', 'base64', 'image_base64']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return { base64: stripDataUriPrefix(value), mime: 'image/png' };
    }
  }
  return null;
}

/** Pull images out of free text: data URIs first, then bare URLs. */
function extractFromText(text: string): GeneratedImage[] {
  const images: GeneratedImage[] = [];

  // 1. Structured JSON embedded in the text (some models emit { b64_json } as prose).
  const structured = tryParseEmbeddedJson(text);
  if (structured) images.push(...structured);

  // 2. Data URIs — the preferred shape, since no fetch is needed.
  const dataUri = DATA_URI.exec(text);
  if (dataUri) {
    images.push({ base64: dataUri[2], mime: `image/${dataUri[1].toLowerCase()}` });
  }

  // 3. Markdown/plain URLs, but only for things that look like images.
  for (const match of text.matchAll(BARE_URL)) {
    const url = match[0];
    if (IMAGE_EXTENSION.test(url)) images.push({ url, mime: guessMime(url) });
  }

  return images;
}

/** Attempt to read a JSON object containing image fields out of the text. */
function tryParseEmbeddedJson(text: string): GeneratedImage[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  const records = Array.isArray(parsed) ? parsed : [parsed];
  const images: GeneratedImage[] = [];

  for (const record of records) {
    const embedded = readEmbeddedBase64(record);
    if (embedded) {
      images.push(embedded);
      continue;
    }
    const url = readImageUrl(record);
    if (url) images.push(...imageFromUrl(url));
  }

  return images.length > 0 ? images : null;
}

/** Build an image from a URL that may itself be a data URI. */
function imageFromUrl(url: string): GeneratedImage[] {
  if (url.startsWith('data:')) {
    const parsed = parseDataUri(url);
    return parsed ? [parsed] : [];
  }
  if (!/^https?:\/\//i.test(url)) return [];
  return [{ url, mime: guessMime(url) }];
}

function parseDataUri(uri: string): GeneratedImage | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(uri);
  if (!match) return null;
  return { base64: match[2], mime: match[1].toLowerCase() };
}

function toDataUri(data: string, mime: string): string {
  // Tolerate a caller who already sent a full data URI.
  if (data.startsWith('data:')) return data;
  return `data:${mime};base64,${data}`;
}

function stripDataUriPrefix(value: string): string {
  const match = /^data:[^;]+;base64,(.*)$/s.exec(value);
  return match ? match[1] : value;
}

function guessMime(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('.jpg') || lower.includes('.jpeg')) return 'image/jpeg';
  if (lower.includes('.webp')) return 'image/webp';
  if (lower.includes('.gif')) return 'image/gif';
  if (lower.includes('.avif')) return 'image/avif';
  return 'image/png';
}

/** Collapse duplicates, so a model echoing the same image twice yields one result. */
function dedupe(images: GeneratedImage[]): GeneratedImage[] {
  const seen = new Set<string>();
  const out: GeneratedImage[] = [];

  for (const image of images) {
    const key = image.base64 ? `b:${image.base64.slice(0, 64)}` : `u:${image.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(image);
  }

  return out;
}
