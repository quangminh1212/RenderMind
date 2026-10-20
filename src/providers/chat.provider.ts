import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  GeneratedImage,
} from '../types/canonical.types';
import type { CapabilityDescriptor, ModelDescriptor } from '../types/capability.types';
import type { ImageProvider } from './provider.interface';
import { ProviderError } from '../engine/errors';
import {
  buildImageInstruction,
  buildSceneInstruction,
  SCENE_SYSTEM_INSTRUCTION,
} from './prompt.builder';
import { logger } from '../utils/logger';
import { SVG_MIME, RasterizeError, rasterizeSvgToPng, validateSvg } from '../platform/svg';
import type { RasterizeResult } from '../platform/svg';
import { compileTextScene } from '../platform/text-scene';
import type { RenderMode } from '../config';

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

/**
 * An SVG data URI, matched separately from `DATA_URI`.
 *
 * `svg+xml` contains a `+`, which is not in the payload character class the raster pattern
 * uses, so folding it into the same alternation would misalign the capture groups. Keeping
 * them apart also makes the intent legible: an SVG is decoded and validated, a raster is
 * passed through, and the two have different handling from here on.
 */
const SVG_DATA_URI = /data:image\/svg\+xml;base64,([A-Za-z0-9+/\s=]+)/i;

/** One format-repair turn handles a model that prefaced its SVG with prose. */
const MAX_FORMAT_REPAIR_ATTEMPTS = 1;

/** Keep generated SVGs finishable on models whose output is text-token bounded. */
const DEFAULT_DRAWING_MAX_TOKENS = 8192;
const MAX_DRAWING_MAX_TOKENS = 16384;

/** A short follow-up is more reliable than repeating the long standing instruction. */
const SVG_REPAIR_INSTRUCTION =
  'Your previous response did not contain a usable image. Try again now: output exactly one ' +
  'complete self-contained SVG document, beginning with <svg and ending with </svg>. Use ' +
  'simple safe shapes only. Do not explain, refuse, use a markdown fence, or add prose.';

/**
 * The scene-mode repair turn.
 *
 * Scene mode fails differently from SVG mode. An SVG reply that is prose is obvious; a scene
 * reply can be *almost* JSON — a trailing comma, single quotes, a wrong key, a shape object
 * where an array was expected — and the compiler refuses it with a precise code. Because the
 * defect is usually repairable in one bounded turn and the whole point of scene mode is that
 * the model can be told exactly what was wrong, the failure names the compiler's reason
 * verbatim and re-states the contract.
 *
 * One attempt only, for the same reason `MAX_FORMAT_REPAIR_ATTEMPTS` is one: a model that
 * produced invalid scene JSON twice has demonstrated it is not following the schema, and a
 * longer repair loop spends the operator's quota to confirm that.
 */
const SCENE_REPAIR_INSTRUCTION =
  'Your previous response was not a usable scene. It must be exactly one JSON object matching ' +
  'the schema in your system instructions — no SVG markup, no code fence, no prose. Reply ' +
  'now with only that JSON object.';

/**
 * A scene id for the compiler, derived deterministically from the request.
 *
 * The compiler requires a caller-assigned, bounded id and *never* reads it from the payload.
 * It exists so a stream stays addressable even when a model's output is unusable, so this is
 * a stable, non-secret label rather than anything derived from the reply. It is length-bounded
 * to the protocol's own limit by construction.
 */
function sceneIdFor(attempt: number): string {
  return `chat-scene-${attempt + 1}`;
}

/**
 * Ceiling on the opt-in refinement rounds, enforced here as well as in the config schema.
 *
 * Two more upstream calls per round, on top of the generation itself, so an unbounded value
 * is an unbounded spend on the operator's key. The schema rejects a bad value at startup;
 * this bound exists because the provider can also be constructed directly, and a class must
 * not trust its caller for something that costs money.
 */
const MAX_REFINEMENT_ROUNDS = 5;

/** A bare http(s) URL, used only when the text contains nothing better. */
const BARE_URL = /https?:\/\/[^\s"'<>)\]]+/gi;

export interface ChatProviderConfig {
  apiKey: string;
  baseUrl: string;
  /** Model used for text-only generation. */
  defaultModel: string;
  /** Completion-token budget for drawing and revision turns. */
  maxTokens?: number;
  /** Model used when the request carries input images. */
  visionModel?: string;
  /** Whether the operator explicitly verified that `visionModel` accepts image input. */
  visionModelConfigured?: boolean;
  /**
   * Extra review + revision passes to run after a drawing has been produced.
   *
   * `0` — the default — means the provider behaves exactly as it did before this setting
   * existed: one upstream call per image, no review. Ignored entirely unless
   * `visionModelConfigured` is also true, because a review needs a model that can actually
   * *see* the rendered image, and assuming that ability is the same mistake the capability
   * descriptor already refuses to make.
   */
  visionRefinementRounds?: number;
  /** Additional model ids this endpoint accepts. */
  extraModels?: string[];
  /** Optional system prompt override, replacing the built-in instruction. */
  systemPrompt?: string;
  /**
   * How the model is asked to describe a picture.
   *
   * `svg` (default) asks for one complete SVG document and extracts it — the historical
   * behaviour, byte-identical when unset. `scene` asks for a compact JSON scene instead and
   * compiles it through `compileTextScene`, which validates it before any markup is written.
   * Either way the result is a validated SVG document handed to the same `deliver` path, so
   * the requested output format (`png`/`svg`) is honoured identically in both modes.
   */
  renderMode?: RenderMode;
}

export class ChatProvider implements ImageProvider {
  readonly name = 'chat';
  readonly displayName = 'Chat-completions model (image via instruction)';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly maxTokens: number;
  private readonly visionModel: string;
  private readonly visionModelConfigured: boolean;
  private readonly visionRefinementRounds: number;
  private readonly extraModels: string[];
  private readonly systemPrompt?: string;
  private readonly renderMode: RenderMode;

  constructor(config: ChatProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.defaultModel = config.defaultModel;
    this.maxTokens = clampMaxTokens(config.maxTokens ?? DEFAULT_DRAWING_MAX_TOKENS);
    this.visionModel = config.visionModel ?? config.defaultModel;
    this.visionModelConfigured = config.visionModelConfigured ?? Boolean(config.visionModel);
    // Defensive on top of the config schema's own bound: this class is also constructed
    // directly (and in tests), and an unbounded loop here spends the operator's quota.
    this.visionRefinementRounds = clampRounds(config.visionRefinementRounds ?? 0);
    this.extraModels = config.extraModels ?? [];
    this.systemPrompt = config.systemPrompt;
    this.renderMode = config.renderMode ?? 'svg';
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
      outputFormats: ['png', 'jpeg', 'webp', 'svg'] as const,
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
        imageToImage: this.visionModelConfigured && this.visionModel.length > 0,
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

    const { images, content } = await this.requestDrawing(request, model);

    // A model that answered with prose has not produced an image. After one format-repair
    // turn, report it as a terminal capability failure rather than an empty result.
    if (images.length === 0) {
      throw new ProviderError({
        provider: this.name,
        message:
          `Model "${model}" returned no image. It answered with text only, so it cannot ` +
          'serve image generation. Configure a model that answers with SVG ' +
          '(or one that returns image bytes directly).',
        code: 'unsupported_output',
        retryable: false,
      });
    }

    // ── Optional: review the drawing and revise it ───────────
    // Off unless the operator asked for it *and* named a model that can see. Runs after a
    // valid image exists, so a failed initial generation stays the terminal failure it was
    // and is never masked by a round that happens to succeed.
    const refined = await this.refine(request, model, images, content);

    // ── Honor the requested container ───────────────────────
    // The instruction makes the model draw in SVG, so a raster is normally what a caller
    // asked for and an SVG is what arrives. Rasterizing here, in the provider, is what
    // keeps the default PNG contract intact: by the time the engine and the adapter see
    // the result, `format: 'png'` means PNG bytes and nothing has been substituted.
    const delivered = this.deliver(refined.images, request, refined.model);

    logger.info('Chat provider extracted images', {
      provider: this.name,
      model: refined.model,
      count: delivered.length,
      usedReferences: hasReferences,
      vector: delivered.filter((image) => image.mime === SVG_MIME).length,
      refinementRounds: refined.rounds,
      elapsedMs: Date.now() - started,
    });

    return {
      images: delivered,
      provider: this.name,
      model: refined.model,
      timings: { queueMs: 0, providerMs: Date.now() - started, totalMs: Date.now() - started },
      cached: false,
      adaptations: {},
    };
  }

  /**
   * Ask the model for a drawing, with at most one repair turn.
   *
   * Two modes share this method because they share the transport, the repair *bound* and the
   * return shape; they differ only in what is asked for and how the reply is read:
   *
   *   - **`svg`** (default) — one call, or two when the first reply carried no image at all.
   *     Unchanged from before `renderMode` existed, byte for byte: same system instruction,
   *     same user turn, same `extractImages`, same repair instruction.
   *   - **`scene`** — ask for a JSON scene, compile it through `compileTextScene`. The reply
   *     is *not* run through `extractImages` (there is no markup to extract); the compiler's
   *     validated final frame is wrapped as an SVG `GeneratedImage`, which the rest of the
   *     provider already knows how to deliver. A compile failure earns one repair turn; a
   *     second failure is terminal.
   *
   * In both modes the returned `content` is the raw reply of the *last* attempt, which the
   * refinement step reuses as the drawing under review.
   *
   * @param request the canonical request, for the instruction text.
   * @param model   the model id to send.
   * @returns the extracted images plus the raw `content` of the *last* reply.
   */
  private async requestDrawing(
    request: ImageGenerationRequest,
    model: string,
  ): Promise<{ images: GeneratedImage[]; content: unknown }> {
    if (this.renderMode === 'scene') {
      return this.requestScene(request, model);
    }
    return this.requestSvg(request, model);
  }

  /**
   * The historical SVG path: one call, plus one repair turn when no image came back.
   *
   * Left exactly as `requestDrawing` was before scene mode existed, so `CHAT_RENDER_MODE=svg`
   * — the default — keeps byte-identical prompts and identical extraction behaviour.
   */
  private async requestSvg(
    request: ImageGenerationRequest,
    model: string,
  ): Promise<{ images: GeneratedImage[]; content: unknown }> {
    let images: GeneratedImage[] = [];
    let content: unknown = null;

    for (let formatAttempt = 0; formatAttempt <= MAX_FORMAT_REPAIR_ATTEMPTS; formatAttempt++) {
      const messages = this.buildMessages(request);
      if (formatAttempt > 0) {
        messages.push({ role: 'user', content: SVG_REPAIR_INSTRUCTION });
        logger.warn('Chat provider requested a format repair after a text-only reply', {
          provider: this.name,
          model,
          attempt: formatAttempt + 1,
        });
      }

      const payload: Record<string, unknown> = {
        model,
        messages,
        // Keep the drawing request deterministic. A text-only model sometimes alternates
        // between a usable SVG and a prose refusal at a non-zero temperature; that makes a
        // fan-out fail randomly even though the model can produce the requested artifact.
        temperature: 0,
        max_tokens: this.maxTokens,
      };

      if (request.seed !== undefined) {
        // Not a standard field, but some gateways honour it. Harmless when ignored.
        payload.seed = request.seed;
      }

      const body = await this.postChat(payload);
      content = body.choices?.[0]?.message?.content;

      images = extractImages(content);
      if (images.length > 0 || isNoImageSentinel(content)) break;
    }

    return { images, content };
  }

  /**
   * The scene path: ask for JSON, compile it, wrap the validated document for delivery.
   *
   * The shape of the loop is the same as the SVG path — one attempt, then one bounded repair —
   * but the *unit of success* is different. There is no extraction step to succeed at
   * partially: `compileTextScene` either returns a validated scene (with its final SVG) or a
   * typed failure naming the stage and code. So the loop asks, compiles, and on failure either
   * repairs once or gives up.
   *
   * Nothing model-authored is ever logged: not the prompt, not the reply, not the API key.
   * The failure log carries only the compiler's stage and code, which are fixed vocabulary.
   * A final failure is a terminal `unsupported_output` ProviderError, exactly like the SVG
   * path's prose refusal — the caller must be told the upstream could not produce an image,
   * and nothing is invented to fill the gap.
   */
  private async requestScene(
    request: ImageGenerationRequest,
    model: string,
  ): Promise<{ images: GeneratedImage[]; content: unknown }> {
    let content: unknown = null;

    for (let attempt = 0; attempt <= MAX_FORMAT_REPAIR_ATTEMPTS; attempt++) {
      const messages = this.buildMessages(request);
      if (attempt > 0) {
        messages.push({ role: 'user', content: SCENE_REPAIR_INSTRUCTION });
        logger.warn('Chat provider requested a scene repair after an unusable reply', {
          provider: this.name,
          model,
          attempt: attempt + 1,
        });
      }

      const payload: Record<string, unknown> = {
        model,
        messages,
        temperature: 0,
        max_tokens: this.maxTokens,
      };

      if (request.seed !== undefined) payload.seed = request.seed;

      const body = await this.postChat(payload);
      content = body.choices?.[0]?.message?.content;

      // A model that refused outright is terminal, and spending a repair turn on an explicit
      // refusal would be nagging. Same sentinel the SVG path honours.
      if (isNoImageSentinel(content)) {
        throw sceneFailure(model, 'the model declined the request (NO_IMAGE)');
      }

      const compiled = compileTextScene(content, sceneIdFor(attempt));
      if (compiled.ok) {
        return {
          images: [sceneImage(compiled.svg, compiled.finalFrame.width, compiled.finalFrame.height)],
          content,
        };
      }

      // Not usable. Log the fixed vocabulary (stage + code), never the payload, and either
      // repair once more or fail terminally with the compiler's own reason.
      logger.warn('Chat provider scene compile refused the reply', {
        provider: this.name,
        model,
        attempt: attempt + 1,
        stage: compiled.stage,
        code: compiled.code,
      });

      if (attempt >= MAX_FORMAT_REPAIR_ATTEMPTS) {
        throw sceneFailure(model, `${compiled.stage}/${compiled.code}: ${compiled.reason}`);
      }
    }

    // Unreachable: the loop returns on success and throws on the final failure. Kept as a
    // totality guard so a future change that let the loop fall through fails here rather
    // than returning `undefined` images to `generate`.
    throw sceneFailure(model, 'the scene loop ended without a result');
  }

  /**
   * Review the produced image and revise it, up to `visionRefinementRounds` times.
   *
   * The loop is deliberately built so that **review and revision are one atomic round**.
   * A round either completes — the image was looked at, a critique came back, and the
   * drawing was revised — or it changes nothing at all. That is what makes the failure
   * semantics honest: there is no state in which the critique was accepted but the
   * drawing was not updated, and so no state in which a caller is told something happened
   * that did not.
   *
   * Every upstream failure inside a round is swallowed *here*, after logging, and the last
   * valid drawing is returned instead. The reasoning: the caller already has a correct
   * image at this point, and an optional quality pass that fails must not convert a
   * successful generation into a failed one. The first generation's own failures are
   * raised before this method is reached and are therefore never swallowed.
   *
   * Cost note: a revision asks for a *new* drawing, which doubles the upstream calls per
   * round. That is the price of the inspection phase being separate from the drawing one.
   * The alternative — folding the critique into the original session — is not available
   * here, because the drawing request does not carry the image it produced, so a critique
   * the model wrote about its own output would be an assertion about an artifact it can no
   * longer see. Sending the rendered bytes back is the honest form.
   */
  private async refine(
    request: ImageGenerationRequest,
    model: string,
    images: GeneratedImage[],
    content: unknown,
  ): Promise<{ images: GeneratedImage[]; model: string; rounds: number }> {
    // Both gates are required. `visionModelConfigured` is the operator's explicit statement
    // that `CHAT_VISION_MODEL` accepts image input; without it, sending pixels to a
    // text-only model would be a guess dressed up as a feature.
    if (!this.visionRefinementRounds || !this.visionModelConfigured) {
      return { images, model, rounds: 0 };
    }

    // Honest degradation: the loop needs the document *text* to hand back for revision, and
    // a raster the model returned directly is not a document. Rather than reconstruct one,
    // the pass is skipped and said so.
    if (images.length !== 1 || images[0].mime !== SVG_MIME || !images[0].svg) {
      logger.info('Chat provider skipped vision refinement: the drawing is not a single SVG', {
        provider: this.name,
        model,
        images: images.length,
        mime: images[0]?.mime ?? null,
      });
      return { images, model, rounds: 0 };
    }

    const reviewModel = this.visionModel;
    const size = request.size;
    let current = images;
    let currentContent = content;
    let currentModel = model;
    let completed = 0;

    for (let round = 1; round <= this.visionRefinementRounds; round++) {
      const source = current[0];

      // ── 1. Render the drawing so the reviewing model can look at it ──
      // rawsvg cannot render a document for itself, so the pixels come from the same
      // bounded rasterizer the delivery path uses.
      let raster: RasterizeResult;
      try {
        raster = rasterizeSvgToPng(source.svg!, size ? { width: size.width } : {});
      } catch (error) {
        logger.warn('Chat provider stopped vision refinement: the drawing would not render', {
          provider: this.name,
          round,
          reason: error instanceof RasterizeError ? error.message : String(error),
        });
        break;
      }

      // ── 2. Review ────────────────────────────────────────────
      let critique: VisualCritique | null;
      try {
        critique = await this.requestReview(raster, request, reviewModel, round);
      } catch (error) {
        logger.warn('Chat provider stopped vision refinement: the review call failed', {
          provider: this.name,
          round,
          reviewModel,
          reason: error instanceof ProviderError ? error.message : String(error),
        });
        break;
      }

      // A reply that was not the JSON we asked for is not a critique. Treating it as one —
      // or falling back to a keyword scan of the prose — would mean revising a drawing on
      // the strength of text the reviewer did not actually commit to. The pass stops here
      // and the caller keeps the drawing that already exists.
      if (!critique) {
        logger.warn('Chat provider stopped vision refinement: the review reply was unusable', {
          provider: this.name,
          round,
          reviewModel,
        });
        break;
      }

      if (critique.verdict === 'accept') {
        // The reviewer looked at the image and had nothing to fix. Stopping is both the
        // cheaper and the more honest answer: further rounds would be spent re-reviewing a
        // drawing that has already been judged satisfactory.
        logger.info('Chat provider vision refinement accepted the drawing', {
          provider: this.name,
          round,
          reviewModel,
          summary: critique.summary,
        });
        break;
      }

      // ── 3. Revise ────────────────────────────────────────────
      // Only reached with a parsed critique, so the loop cannot revise on a guess.
      try {
        const messages = withRevision(
          this.buildMessages(request),
          revisionInstruction(currentContent, critique, request),
        );
        const body = await this.postChat({
          model,
          messages,
          temperature: 0,
          max_tokens: this.maxTokens,
        });
        const reply = body.choices?.[0]?.message?.content;

        let revised: GeneratedImage[];
        try {
          revised = extractImages(reply);
        } catch (error) {
          // A revision that fails the SVG gate is not a revision. The critique was acted
          // on and rejected by our own validator, so the drawing under review stands and
          // the loop stops rather than spending another round on the same path.
          logger.warn('Chat provider stopped vision refinement: the revision was refused', {
            provider: this.name,
            round,
            reason: error instanceof ProviderError ? error.message : String(error),
          });
          break;
        }

        if (revised.length !== 1 || revised[0].mime !== SVG_MIME) {
          logger.warn('Chat provider stopped vision refinement: the revision was not a drawing', {
            provider: this.name,
            round,
            images: revised.length,
          });
          break;
        }

        current = revised;
        currentContent = reply;
        currentModel = model;
        completed = round;
      } catch (error) {
        logger.warn('Chat provider stopped vision refinement: the revision call failed', {
          provider: this.name,
          round,
          reason: error instanceof ProviderError ? error.message : String(error),
        });
        break;
      }
    }

    if (completed === 0) return { images, model, rounds: 0 };
    return { images: current, model: currentModel, rounds: completed };
  }

  /**
   * Ask the vision model to judge a rendered drawing.
   *
   * The image is attached as an `image_url` data URI *before* the instruction text, matching
   * the order the reference-image path already uses. The attachment is the whole point:
   * a review is only worth acting on if the reviewer could actually see the artifact, and
   * attaching the bytes makes that structural rather than a claim in the prompt.
   *
   * The reply is parsed tolerantly but not credulously — see `parseReview`. A reply that is
   * not the JSON we asked for yields `null`, which is treated exactly like a failed review,
   * because acting on a critique we could not read would be invention.
   */
  private async requestReview(
    raster: RasterizeResult,
    request: ImageGenerationRequest,
    reviewModel: string,
    round: number,
  ): Promise<VisualCritique | null> {
    const payload: Record<string, unknown> = {
      model: reviewModel,
      messages: [
        { role: 'system', content: REVIEW_SYSTEM_INSTRUCTION },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: toDataUri(raster.png.toString('base64'), 'image/png') },
            },
            { type: 'text', text: reviewInstruction(request, round) },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 1024,
    };

    const body = await this.postChat(payload);
    return parseReview(body.choices?.[0]?.message?.content);
  }

  /**
   * POST a chat-completions payload and parse the envelope.
   *
   * Extracted because the drawing path now makes *three* kinds of call against the same
   * endpoint, and the transport and error mapping must be identical for all of them: a
   * failure anywhere has to reach the caller as the same typed `ProviderError` with the
   * same status, code and Retry-After. Duplicating that mapping is how the three drift.
   *
   * Like its predecessor this does not check `response.ok` — it returns the parsed error
   * envelope so that `toProviderError` can read it — which is what lets a 400 body be
   * diagnosed rather than lost.
   */
  private async postChat(payload: Record<string, unknown>): Promise<{
    choices?: Array<{ message?: { content?: unknown } }>;
    error?: { message?: string; code?: string; type?: string };
  }> {
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

    return (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      error?: { message?: string; code?: string; type?: string };
    };
  }

  /**
   * Convert extracted images into the format the caller actually asked for.
   *
   * Only `format: 'svg'` opts out of rasterization. That is a deliberate narrowing: an SVG
   * is a document, and handing one to a client that asked for PNG would put an
   * active-content-capable payload where the caller expects a flat bitmap. The inverse is
   * harmless — rasterizing is lossless with respect to the caller's intent, since they
   * asked for pixels.
   *
   * A raster the model produced directly is passed through untouched: it did not come from
   * our instruction, it is already the right shape, and re-encoding it to satisfy a nominal
   * format would be churn for no gain.
   */
  private deliver(
    images: GeneratedImage[],
    request: ImageGenerationRequest,
    model: string,
  ): GeneratedImage[] {
    if (request.output.format === 'svg') return images;

    const targetWidth = request.size?.width;

    return images.map((image) => {
      if (image.mime !== SVG_MIME || !image.svg) return image;

      if (request.output.format === 'jpeg' || request.output.format === 'webp') {
        throw new ProviderError({
          provider: this.name,
          message:
            `Model "${model}" authored SVG, but this fallback can rasterize it only to PNG. ` +
            `Use format "png" or "svg"; the engine will not mislabel PNG bytes as ${request.output.format}.`,
          code: 'unsupported_output',
          retryable: false,
        });
      }

      try {
        const raster = rasterizeSvgToPng(image.svg, {
          ...(targetWidth ? { width: targetWidth } : {}),
        });

        return {
          base64: raster.png.toString('base64'),
          mime: 'image/png',
          // Honest dimensions: the rasterizer's own, not the document's declared ones,
          // because those are what the delivered bytes actually measure.
          width: raster.width,
          height: raster.height,
          // Keep the source document so a caller can be shown what was drawn, without a
          // second upstream call to ask for it again.
          svg: image.svg,
        };
      } catch (error) {
        // A document that validated but will not render is terminal: the same bytes will
        // fail the same way, so retrying spends quota to confirm a known answer.
        throw new ProviderError({
          provider: this.name,
          message:
            `Model "${model}" returned SVG that validated but could not be rasterized: ` +
            `${error instanceof RasterizeError ? error.message : String(error)}`,
          code: 'unsupported_output',
          retryable: false,
          cause: error,
        });
      }
    });
  }

  /**
   * Build the chat messages.
   *
   * The instruction is a *system* message so the model treats it as a standing
   * requirement rather than part of the subject to draw. Reference images, when present,
   * are attached as `image_url` content parts — the shape every multimodal openclaw-
   * compatible endpoint accepts — followed by the generation instruction.
   *
   * The instruction depends on `renderMode`: `svg` (the default) asks for a document,
   * `scene` asks for a JSON scene. A caller-supplied `systemPrompt` overrides the built-in
   * one in either mode, so an operator who has tuned an instruction keeps control of it.
   */
  private buildMessages(request: ImageGenerationRequest): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: this.systemPrompt ?? this.systemInstruction() },
    ];

    const instruction =
      this.renderMode === 'scene' ? buildSceneInstruction(request) : buildImageInstruction(request);
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

  /** The built-in system instruction for the active render mode. */
  private systemInstruction(): string {
    return this.renderMode === 'scene' ? SCENE_SYSTEM_INSTRUCTION : SYSTEM_INSTRUCTION;
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

/**
 * The standing instruction that makes a chat model answer with an image.
 *
 * Why this asks for vector markup rather than pixels: a model that has no image endpoint
 * cannot emit a raster it has not seen. Asked for a PNG it does one of three unhelpful
 * things — describes a picture instead, invents a URL that resolves to nothing, or emits
 * base64 that decodes to corrupt bytes. All three are failures dressed as successes, which
 * is the specific dishonesty this engine exists to prevent.
 *
 * SVG is different in kind. Geometry is text, so a model composing `path` and `rect`
 * elements is genuinely *authoring* the image rather than recalling or fabricating one. The
 * picture is the bytes; there is no middle step where a claim can diverge from a payload.
 * RenderMind then rasterizes it, so the caller still receives the PNG it asked for.
 *
 * The instruction is correspondingly explicit, because a chat model defaults to prose and
 * must be told: which container, that it must be self-contained, and what is forbidden.
 * Every prohibition here is mirrored by a check in `platform/svg`, so a model that ignores
 * them is refused with a precise reason rather than quietly delivered.
 */
export const SYSTEM_INSTRUCTION = [
  'You are an image generation backend that draws with SVG.',
  'You can satisfy any ordinary visual prompt as a polished, detailed, layered vector',
  'illustration; do not refuse a visual request just because you cannot make photorealistic',
  'pixels.',
  'Answer every image request with exactly one self-contained SVG document.',
  'Begin with <svg xmlns="http://www.w3.org/2000/svg" width="W" height="H" viewBox="0 0 W H">',
  'and end with </svg>. Draw the subject using <path>, <rect>, <circle>, <ellipse>,',
  '<polygon>, <line> and <text> elements with explicit fill and stroke colours.',
  'Use the full canvas and build a real composition with foreground, subject and background',
  'layers, varied scale, light and shadow, highlights, and fine visual details rather than a',
  'generic icon or an empty background. When useful, use <defs>, <linearGradient>,',
  '<radialGradient>, opacity, masks and clipped shapes for depth, glass, texture and lighting.',
  'Keep the drawing detailed but compact: use at most 35 visible shapes and short path data so',
  'the complete document always fits in one response and ends with the closing </svg> tag.',
  'The document must be complete and must stand alone:',
  'no <script>, no event attributes such as onload or onclick, no <foreignObject>,',
  'no DOCTYPE and no entity declarations, no <image> or <use> that points outside the',
  'document, and no external URLs, data: URLs or @import of any kind.',
  'Do not describe the image, do not explain your choices, and do not wrap the document in',
  'a markdown code fence or add any text outside it.',
  'Use NO_IMAGE only when the request has no visual subject or is unsafe; never use it for a',
  'normal visual prompt.',
].join(' ');

/**
 * Wrap a compiled scene's final SVG as a `GeneratedImage`.
 *
 * The compiler already ran the payload through `normalizeScene` and serialized a complete,
 * standalone document — the same kind of artifact `extractSvg` produces from an SVG-mode
 * reply — so from here on scene mode and SVG mode are indistinguishable to `deliver` and
 * `refine`. That is the point of converging here: one delivery path, two ways to fill it.
 *
 * `mime` is `image/svg+xml` with `svg` populated, exactly as a validated SVG-mode payload is,
 * which is what makes `deliver` rasterize it to PNG (or pass it through for `format: 'svg'`)
 * without a mode check of its own. The width/height are the final frame's own, taken from the
 * scene's canvas, so they describe the document that was actually produced.
 */
function sceneImage(svg: string, width: number, height: number): GeneratedImage {
  return { svg, mime: SVG_MIME, width, height };
}

/**
 * Build the terminal failure for an unusable scene reply.
 *
 * A scene request that never compiles is the same fact to a caller as a prose reply in SVG
 * mode: the upstream could not produce an image. It is reported as `unsupported_output`
 * (HTTP 422) and marked non-retryable, because the same request to the same model produces
 * the same result — retrying spends quota to confirm a known answer.
 *
 * `detail` names the compiler's stage, code and reason, all of which are fixed vocabulary and
 * never carry the model's payload.
 */
function sceneFailure(model: string, detail: string): ProviderError {
  return new ProviderError({
    provider: 'chat',
    message:
      `Model "${model}" did not return a usable scene. ${detail}. A scene-mode reply must be ` +
      'one JSON object matching the documented schema; the object is validated before anything ' +
      'is drawn, and nothing is delivered rather than an invalid image.',
    code: 'unsupported_output',
    retryable: false,
  });
}

/**
 * Extract image payloads from a chat response `content` value.
 *
 * `content` is typed as `unknown` on purpose: endpoints differ between a plain string,
 * an array of content parts, and (rarely) a non-standard object.
 *
 * A validated SVG is returned with `mime: 'image/svg+xml'` and the `svg` field populated,
 * and it is returned **before** any raster or URL candidate. That ordering is deliberate.
 * The instruction asks for one SVG, so when a model supplies both an SVG and a stray URL —
 * which happens when it narrates its answer — the SVG is the artifact it was told to
 * produce. Taking the URL instead would hand the caller a link the engine never vetted,
 * and would silently substitute provenance for authorship.
 */
export function extractImages(content: unknown): GeneratedImage[] {
  const images: GeneratedImage[] = [];

  for (const part of asContentParts(content)) {
    if (typeof part === 'string') {
      images.push(...extractFromText(part));
      continue;
    }

    const text = readTextPart(part);
    if (text) {
      images.push(...extractFromText(text));
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

/** Keep the explicit refusal terminal instead of spending a repair turn on it. */
function isNoImageSentinel(content: unknown): boolean {
  return asContentParts(content).some(
    (part) => typeof part === 'string' && part.trim().toUpperCase() === 'NO_IMAGE',
  );
}

/** Read the text member used by multimodal content-part responses. */
function readTextPart(part: unknown): string | null {
  if (typeof part !== 'object' || part === null) return null;
  const text = (part as Record<string, unknown>).text;
  return typeof text === 'string' ? text : null;
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

/** Pull images out of free text: SVG first, then data URIs, then bare URLs. */
function extractFromText(text: string): GeneratedImage[] {
  // 1. SVG. Tried first and short-circuits, because the instruction asks for exactly one
  //    SVG: a model that complied has answered the question, and anything else in the same
  //    message is narration. See the note on extraction ordering in `extractImages`.
  const svg = extractSvg(text);
  if (svg) return [svg];

  const images: GeneratedImage[] = [];

  // 2. Structured JSON embedded in the text (some models emit { b64_json } as prose).
  const structured = tryParseEmbeddedJson(text);
  if (structured) images.push(...structured);

  // 3. Data URIs — the preferred shape, since no fetch is needed.
  const dataUri = DATA_URI.exec(text);
  if (dataUri) {
    images.push({ base64: dataUri[2], mime: `image/${dataUri[1].toLowerCase()}` });
  }

  // 4. Markdown/plain URLs, but only for things that look like images.
  for (const match of text.matchAll(BARE_URL)) {
    const url = match[0];
    if (IMAGE_EXTENSION.test(url)) images.push({ url, mime: guessMime(url) });
  }

  return images;
}

/**
 * A validated SVG candidate, or nothing.
 *
 * Two shapes reach us, and both are normal:
 *
 *   - **Bare markup.** The instruction demands a self-contained document, so the common
 *     case is `<svg …>…</svg>` sitting in the message, sometimes inside a ```svg fence
 *     because a model cannot resist formatting it as code.
 *   - **A data URI.** `data:image/svg+xml;base64,…` — the shape the previous instruction
 *     asked for. Still accepted, so a prompt override or a cached model behaviour that
 *     still emits it does not become an error.
 *
 * Extraction is deliberately *not* a parse. It locates the candidate region and hands it to
 * the validator, which is the single place that decides what the document means. A
 * candidate that fails validation is reported as `unsupported_output` — the same terminal
 * verdict a prose reply gets, because to a caller the two are the same fact: the upstream
 * did not produce a usable image.
 *
 * This returns `null` rather than throwing, so the caller can keep looking for a raster in
 * the same message. It does not get to: a document that *looks* like SVG and fails
 * validation is a much stronger signal than a stray URL, and `extractFromText` stops there.
 */
function extractSvg(text: string): GeneratedImage | null {
  // ── A data URI, decoded and validated ──────────────────────
  const dataUri = SVG_DATA_URI.exec(text);
  if (dataUri) {
    const validated = validateSvgPayload(decodeBase64Payload(dataUri[1]));
    if (validated) return validated;
  }

  // ── Bare markup, with any code fence stripped ─────────────
  // A fence is presentation, not content: ```svg\n<svg…/>\n``` carries one document, and
  // handing the backticks to the validator would fail a payload that is actually correct.
  for (const candidate of svgCandidates(text)) {
    if (candidate.trim().toLowerCase() === 'no_image') continue;
    const validated = validateSvgPayload(Buffer.from(candidate, 'utf8'));
    if (validated) return validated;
  }

  return null;
}

/**
 * Validate a decoded SVG payload into a `GeneratedImage`.
 *
 * The `unsupported_output` error is raised here rather than returned, because a payload
 * that opened like a document and then failed the gate is not something to keep searching
 * past. The message names the specific refusal so an operator can tell an unsafe model from
 * a merely inept one, which is the difference between a prompt fix and an incident.
 */
function validateSvgPayload(payload: Buffer | null): GeneratedImage | null {
  if (!payload) return null;

  // Only treat it as an attempted SVG if it opens like one; otherwise this is not our
  // candidate and the caller should keep looking for a raster.
  if (!looksLikeSvgStart(payload)) return null;

  const verdict = validateSvg(payload);
  if (!verdict.ok) {
    throw new ProviderError({
      provider: 'chat',
      message:
        `Model returned SVG that RenderMind refused (${verdict.code}): ${verdict.reason} ` +
        'Nothing is delivered rather than an invalid or unsafe image.',
      code: 'unsupported_output',
      retryable: false,
    });
  }

  return {
    svg: verdict.svg,
    mime: SVG_MIME,
    width: verdict.width,
    height: verdict.height,
  };
}

/** Whether a payload opens like an SVG document, cheaply, without a full validation. */
function looksLikeSvgStart(payload: Buffer): boolean {
  const head = payload.subarray(0, 4096);
  if (head.includes(0)) return false;
  // A UTF-8 BOM is three bytes on the wire, and `Buffer.toString` decodes it to a single
  // U+FEFF. The pattern is written as an escape because the character itself is
  // invisible in source; a literal would look like an empty regex to a reader.
  const text = head
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  return text.startsWith('<svg') || text.startsWith('<?xml') || text.startsWith('<!DOCTYPE');
}

/**
 * Candidate SVG documents in a text block, longest first.
 *
 * Each candidate is a *balanced* region — an opening `<svg>` through the `</svg>` that
 * closes it — rather than a slice from the first open to the last close. That distinction
 * matters: a model that emits a stub and then the real drawing produces two documents, and
 * slicing across both would concatenate them into one malformed payload that fails
 * validation for a reason that has nothing to do with either drawing.
 *
 * Longest-first is the preference order. A model that emits several documents is being
 * indecisive rather than offering alternatives, and the largest is the one with content in
 * it — a bare-`<svg>` placeholder followed by the actual illustration is the observed
 * pattern.
 */
function svgCandidates(text: string): string[] {
  const candidates: string[] = [];

  // A fenced block, preferred because it delimits the document exactly.
  for (const fence of text.matchAll(/```(?:svg|xml|html)?\s*\n([\s\S]*?)```/gi)) {
    const body = fence[1].trim();
    if (looksLikeSvgStart(Buffer.from(body, 'utf8'))) candidates.push(body);
  }

  // Each balanced top-level document, found by walking the nesting depth so a nested
  // `<svg>` inside a wrapper does not get treated as a separate candidate.
  const tagPattern = /<\s*(\/?)\s*svg\b[^>]*?(\/?)\s*>/gi;
  let match: RegExpExecArray | null;
  let depth = 0;
  let start = -1;

  while ((match = tagPattern.exec(text)) !== null) {
    const isClosing = match[1] === '/';
    const isSelfClosing = match[2] === '/';

    if (!isClosing && !isSelfClosing && depth === 0) {
      start = match.index;
      depth = 1;
      continue;
    }

    if (isSelfClosing && depth === 0) {
      // A whole document on one tag.
      candidates.push(text.slice(match.index, match.index + match[0].length));
      continue;
    }

    if (!isClosing && !isSelfClosing) {
      depth += 1;
      continue;
    }

    if (isClosing) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, match.index + match[0].length));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }

  // An unclosed trailing document: pass it through so the validator can report the
  // truncation precisely instead of the payload vanishing into a generic failure.
  if (depth > 0 && start >= 0) candidates.push(text.slice(start));

  return [...new Set(candidates)].sort((a, b) => b.length - a.length);
}

/** Decode a base64 payload, returning `null` when it is not plausible base64. */
function decodeBase64Payload(encoded: string): Buffer | null {
  const normalized = encoded.replace(/\s+/g, '');
  if (normalized.length === 0 || normalized.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  return Buffer.from(normalized, 'base64');
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

// ─── Opt-in vision refinement ────────────────────────────────
//
// The drawing loop above answers "can this model produce an image at all?". This second loop
// answers a different question: "does the image it produced match the request?". They are
// kept apart on purpose, because the second one costs two extra upstream calls per round and
// therefore has to be opt-in, bounded, and impossible to trigger by accident.
//
// Everything below is transport-level, so it is deliberately free of policy: what to do when
// a round fails is decided in `ChatProvider.refine`, in one place, and these helpers only
// read what the upstream actually said.

/**
 * What the reviewing model is allowed to look at, and what it must write back.
 *
 * Two properties are load-bearing:
 *
 *   1. **It gets the rendered image, not the source.** A reviewer handed SVG can only comment
 *      on geometry it re-parses in its head — which is the same imagination that produced the
 *      drawing. The PNG bytes are the artifact a human will actually see, so those are what
 *      gets judged.
 *   2. **It returns a fixed JSON shape.** A free-text critique cannot be handed to a second
 *      model without smuggling one model's prose into another's context — an injection
 *      surface, and an unparseable one. A constrained object with a verdict and a bounded
 *      list of issues is something we can validate, deduplicate and cap before use.
 *
 * The reviewer is also told explicitly not to author the replacement document. If it did,
 * we would have two drawings and no way to decide between them; revision is the drawing
 * model's job, and the split is what keeps the loop's output attributable.
 */
const REVIEW_SYSTEM_INSTRUCTION = [
  'You are a visual quality reviewer for an image generation service.',
  'You will be shown one rendered image and the request that produced it.',
  'Judge only what you can actually see in the image, plus whether it satisfies the request.',
  'Reply with exactly one JSON object and no other text:',
  '{"verdict":"accept"|"revise","summary":"<one sentence>","issues":["<specific visual defect>"],',
  '"suggestions":["<concrete edit>"]}',
  'Use "accept" only when the image visibly satisfies the request and needs no change.',
  'Use "revise" when it does not, and list concrete, observable problems',
  '(missing subject, wrong colours, unreadable text, clipped or overlapping elements,',
  'empty or near-empty canvas, wrong composition). Do not invent problems you cannot see.',
  'Do not write or include SVG, code, or a replacement drawing in your answer.',
].join(' ');

/** Which round this is, so a later pass knows a previous critique was already applied. */
function reviewInstruction(request: ImageGenerationRequest, round: number): string {
  return [
    'Review the attached image.',
    `It was generated for this request: ${request.prompt}`,
    request.negativePrompt ? `The caller asked for none of: ${request.negativePrompt}` : '',
    round > 1
      ? `This is revision pass ${round - 1}; an earlier critique has already been applied.`
      : '',
    'Answer with the JSON object described in your instructions, and nothing else.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A parsed, bounded review suitable for handing to the drawing model. */
export interface VisualCritique {
  verdict: 'accept' | 'revise';
  summary: string;
  issues: string[];
  suggestions: string[];
}

/**
 * Parse the reviewer's reply into a critique, or `null` when it cannot be trusted.
 *
 * Tolerant about *packaging*, strict about *content*, because those two failure modes have
 * opposite right answers. A model that wraps its JSON in a markdown fence, or prefixes it
 * with a sentence, has still answered the question — refusing that would make the feature
 * unreliable for no benefit. A model whose reply carries no usable verdict has not, and
 * guessing one would mean revising a drawing on the strength of text we did not understand.
 *
 * Every field is coerced and bounded: lengths are capped so a verbose reviewer cannot push
 * the drawing prompt past the upstream's context, and the issue list is truncated rather
 * than allowed to grow a round into a novel.
 */
export function parseReview(content: unknown): VisualCritique | null {
  const text = asContentParts(content)
    .map((part) => (typeof part === 'string' ? part : (readTextPart(part) ?? '')))
    .join('\n')
    .trim();

  if (text.length === 0) return null;

  const parsed = parseJsonObject(text);
  if (!parsed) return null;

  const rawVerdict = typeof parsed.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : '';
  const verdict: VisualCritique['verdict'] | null =
    rawVerdict === 'accept' ? 'accept' : rawVerdict === 'revise' ? 'revise' : null;

  const issues = toStringList(parsed.issues).slice(0, MAX_REVIEW_ITEMS);
  const suggestions = toStringList(parsed.suggestions).slice(0, MAX_REVIEW_ITEMS);

  // A verdict is the one part that cannot be inferred. Everything else has a defensible
  // default: an absent summary becomes a restatement of the verdict, and an absent issue
  // list is only fatal when the reviewer asked for a revision it did not describe —
  // "revise" with nothing to revise is not an instruction anyone can act on.
  // A verdict is normally explicit. Some multimodal models, including the live GLM route,
  // answer a strict review request with a boolean visual checklist instead. That shape is
  // still actionable when it contains several known criteria, so normalize it rather than
  // silently disabling the GLM chat+vision loop.
  if (!verdict) {
    // GLM may put the numeric review under an `evaluation` object and add a long
    // `criteria_analysis` beside it. Inspect that bounded object as well, without allowing
    // arbitrary nested data to become an instruction.
    const evaluation = asRecord(parsed.evaluation);
    const scored = parseScoredReview(parsed) ?? (evaluation ? parseScoredReview(evaluation) : null);
    const checklist =
      parseChecklistReview(parsed) ?? (evaluation ? parseChecklistReview(evaluation) : null);
    return scored ?? checklist;
  }
  if (verdict === 'revise' && issues.length === 0 && suggestions.length === 0) return null;

  const summary =
    typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
      ? clip(parsed.summary.trim(), MAX_REVIEW_CHARS)
      : verdict === 'accept'
        ? 'The reviewer accepted the image.'
        : 'The reviewer asked for a revision.';

  return { verdict, summary, issues, suggestions };
}

/** Normalize GLM's numeric-score review shape: `{ score: 1..10, reason: "..." }`. */
function parseScoredReview(parsed: Record<string, unknown>): VisualCritique | null {
  const score = typeof parsed.score === 'number' ? parsed.score : Number(parsed.score);
  const reason = typeof parsed.reason === 'string' ? parsed.reason.replace(/\s+/g, ' ').trim() : '';

  if (!Number.isFinite(score) || score < 0 || score > 10 || reason.length === 0) return null;

  if (score >= 8) {
    return {
      verdict: 'accept',
      summary: clip(
        `The visual reviewer scored the drawing ${score}/10: ${reason}`,
        MAX_REVIEW_CHARS,
      ),
      issues: [],
      suggestions: [],
    };
  }

  return {
    verdict: 'revise',
    summary: clip(
      `The visual reviewer scored the drawing ${score}/10: ${reason}`,
      MAX_REVIEW_CHARS,
    ),
    issues: [clip(reason, MAX_REVIEW_CHARS)],
    suggestions: [
      clip(
        'Revise the drawing to address every concrete visual defect identified by the reviewer.',
        MAX_REVIEW_CHARS,
      ),
    ],
  };
}

/**
 * Normalize the checklist shape emitted by some multimodal chat models.
 *
 * This is intentionally narrow: arbitrary booleans must not become an invented verdict.
 * GLM's current vision response carries several of these named criteria, which makes the
 * mapping evidence-based and keeps the original strict JSON gate for every other shape.
 */
function parseChecklistReview(parsed: Record<string, unknown>): VisualCritique | null {
  const present = GLM_CHECKLIST_FIELDS.filter((field) => typeof parsed[field] === 'boolean');
  if (present.length < 3) return null;

  const failed = present.filter((field) => parsed[field] !== true);
  if (failed.length === 0) {
    return {
      verdict: 'accept',
      summary: 'The visual checklist found the requested subject, composition and finish.',
      issues: [],
      suggestions: [],
    };
  }

  return {
    verdict: 'revise',
    summary: `The visual checklist flagged ${failed.length} criterion(s) for improvement.`,
    issues: failed.map((field) => `Visual issue: ${GLM_CHECKLIST_LABELS[field]}`),
    suggestions: failed.map((field) => `Improve ${GLM_CHECKLIST_LABELS[field]}`),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const GLM_CHECKLIST_FIELDS = [
  'polished_illustration',
  'clear_glass',
  'fern_leaves',
  'warm_light',
  'balanced_composition',
  'no_text',
] as const;

const GLM_CHECKLIST_LABELS: Record<(typeof GLM_CHECKLIST_FIELDS)[number], string> = {
  polished_illustration: 'the illustration is not polished or detailed enough',
  clear_glass: 'the glass is not clear or convincingly rendered',
  fern_leaves: 'the fern leaves are missing or unclear',
  warm_light: 'the requested warm lighting is missing',
  balanced_composition: 'the composition is unbalanced',
  no_text: 'the image contains text',
};

/** Bounds on what a critique may contribute to the next prompt. */
const MAX_REVIEW_ITEMS = 6;
const MAX_REVIEW_CHARS = 400;

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

/** Read a string, or a list of strings, into a bounded list of non-empty clipped strings. */
function toStringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];

  return items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter((item) => item.length > 0)
    .map((item) => clip(item, MAX_REVIEW_CHARS));
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * The user turn that hands a critique back to the drawing model.
 *
 * Attributed as *reviewer feedback* rather than presented as the operator's own words, and
 * framed as a bounded edit. Both matter: a reviewer's reply is untrusted text, and a model
 * that treats it as a new standing instruction will happily abandon the original request —
 * or comply with whatever the text asks for. The original instruction stays in the message
 * list above this turn, so the drawing model still has the specification it was given.
 */
function revisionInstruction(
  content: unknown,
  critique: VisualCritique,
  request: ImageGenerationRequest,
): string {
  const previous = previousDocument(content);
  const lines: string[] = [];

  lines.push('Your previous drawing was reviewed by a vision model against the original request.');
  lines.push(`Reviewer verdict: ${critique.verdict}. ${critique.summary}`);

  if (critique.issues.length > 0) {
    lines.push('');
    lines.push('Issues found in the rendered image:');
    for (const issue of critique.issues) lines.push(`- ${issue}`);
  }

  if (critique.suggestions.length > 0) {
    lines.push('');
    lines.push('Suggested corrections:');
    for (const suggestion of critique.suggestions) lines.push(`- ${suggestion}`);
  }

  lines.push('');
  lines.push('Revise the drawing to resolve them. Keep everything that already works.');
  lines.push(`The subject is still: ${request.prompt}`);

  if (previous) {
    lines.push('');
    lines.push('The document being revised:');
    lines.push(previous);
  }

  lines.push('');
  lines.push(
    'Reply with exactly one complete self-contained SVG document, the full revised drawing, ' +
      'beginning with <svg and ending with </svg>. Do not explain, do not comment on the ' +
      'review, use no markdown fence, and add no text outside the document.',
  );

  return lines.join('\n');
}

/**
 * The SVG text in a previous reply, bounded.
 *
 * Sent back in full because of a measured trade-off, not an oversight. A partial document
 * would ask the model to continue an artifact it cannot see, and a round that *does* carry
 * the document is materially more likely to return a drawing than one that describes the
 * change in prose. The cost is one extra copy of a kilobyte-scale document on a call that
 * already carries a raster, which changes the payload's order of magnitude only when the
 * document is near its own limit — and the SVG gate refuses those long before here.
 */
function previousDocument(content: unknown): string | null {
  if (content === null || content === undefined) return null;
  const text = asContentParts(content)
    .map((part) => (typeof part === 'string' ? part : (readTextPart(part) ?? '')))
    .join('\n');
  if (text.trim().length === 0) return null;
  return clip(text, MAX_PREVIOUS_DOCUMENT_CHARS);
}

/** Ceiling on the document text carried back, so one reply cannot dominate the next prompt. */
const MAX_PREVIOUS_DOCUMENT_CHARS = 12000;

/** Coerce a configured round count onto `[0, MAX_REFINEMENT_ROUNDS]`. */
function clampRounds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_REFINEMENT_ROUNDS);
}

/** Defend direct class construction from an unbounded or unusable token budget. */
function clampMaxTokens(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DRAWING_MAX_TOKENS;
  return Math.min(Math.floor(value), MAX_DRAWING_MAX_TOKENS);
}

/** Ensure a message list does not end on a user turn, then append this one. */
function withRevision(
  messages: Array<Record<string, unknown>>,
  instruction: string,
): Array<Record<string, unknown>> {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    const continuation: Array<Record<string, unknown>> = [
      { role: 'assistant', content: 'Understood.' },
      { role: 'user', content: instruction },
    ];
    return [...messages, ...continuation];
  }
  return [...messages, { role: 'user', content: instruction }];
}
