import type {
  AppliedAdaptations,
  AspectRatio,
  ImageGenerationRequest,
  QualityLevel,
} from '../types/canonical.types';
import type {
  Attempt,
  CapabilityDescriptor,
  GenerationPlan,
  ModelDescriptor,
  ProviderStatus,
  RejectionReason,
} from '../types/capability.types';
import { UnsupportedCapabilityError } from './errors';

/** Statuses that may still be attempted, in preference order. */
const USABLE_STATUSES: ProviderStatus[] = ['available', 'degraded'];

/**
 * Provider classes that can produce real pixels, preferred over the text-only fallback.
 *
 * The chat provider instructs a language model to compose vector geometry: it works when
 * nothing else is available, and it is the only source of `format: 'svg'`, but its output is
 * a diagram rather than a picture. A native images endpoint returns an actual raster, so
 * when both are configured and the caller has not pinned one, the native path is the better
 * answer.
 *
 * This is a declared first sort key rather than something that emerges from cost and
 * latency. Neither provider declares a cost, and both declare a latency constant — so
 * leaving the preference implicit would let routing be decided by whichever latency number
 * happened to be smaller, which is a behaviour change disguised as an optimisation.
 */
const REAL_IMAGE_PROVIDERS = new Set(['native']);

/**
 * Resolve which provider(s) can serve a request, and how.
 *
 * Pure and synchronous: no I/O, no clock, no randomness. That makes every negotiation
 * decision testable as a table of (request × descriptors) → plan.
 *
 * Algorithm:
 *   1. Hard-filter candidates on size/aspect/quality/feature/format support.
 *   2. Adapt the request where adaptation is safe and disclosed.
 *   3. Rank the survivors: real-image providers first, then cost, then latency.
 *   4. Emit an explicit plan (ordered attempts) rather than a single provider, so
 *      failover is a declared strategy instead of a retry loop.
 */
export function buildPlan(
  request: ImageGenerationRequest,
  descriptors: CapabilityDescriptor[],
): GenerationPlan {
  const rejections: RejectionReason[] = [];
  const adaptations: AppliedAdaptations = {};

  const candidates: Array<{
    descriptor: CapabilityDescriptor;
    model: ModelDescriptor;
    adaptedSize: { width: number; height: number } | null;
    adaptedAspect: AspectRatio | null;
    adaptedQuality: QualityLevel | null;
  }> = [];

  for (const descriptor of descriptors) {
    // Honour an explicitly requested provider. Without this filter a request naming a
    // provider that does not exist silently routed to a different one, so a typo in
    // `provider` produced a successful response from the wrong backend.
    if (
      request.provider &&
      request.provider !== 'auto' &&
      descriptor.provider !== request.provider
    ) {
      rejections.push({
        provider: descriptor.provider,
        reason: `caller requested provider "${request.provider}"`,
      });
      continue;
    }

    if (!USABLE_STATUSES.includes(descriptor.status)) {
      rejections.push({ provider: descriptor.provider, reason: `status is ${descriptor.status}` });
      continue;
    }

    // ── Feature gate ────────────────────────────────────────
    if (request.negativePrompt && !descriptor.features.negativePrompt) {
      rejections.push({
        provider: descriptor.provider,
        reason: 'provider does not support negative_prompt',
      });
      continue;
    }
    if (request.referenceImages?.length && !descriptor.features.imageToImage) {
      rejections.push({
        provider: descriptor.provider,
        reason: 'provider does not support image-to-image',
      });
      continue;
    }
    if (request.mask && !descriptor.features.inpainting) {
      rejections.push({
        provider: descriptor.provider,
        reason: 'provider does not support inpainting/mask',
      });
      continue;
    }

    // ── Output format gate ──────────────────────────────────
    // Hard, not a preference. A model that cannot produce the container the caller asked for
    // must be rejected outright, because the alternative is exactly the substitution the
    // engine exists to prevent: a caller who asked for `svg` and received PNG bytes has been
    // handed the wrong kind of artifact with no signal that it happened.
    //
    // Applied per *model* rather than per provider: a provider may offer several models with
    // different output formats, and only the one actually selected has to be able to serve
    // the request. Checking the provider's whole model list would reject a perfectly good
    // provider because one of its other models lacks the format.
    //
    // This is also what routes `format: 'svg'` to the chat path. The native images endpoint
    // has no vector mode, so every one of its models fails this gate and the request falls
    // through to the provider that genuinely authors vector markup — no special case in the
    // router, and no reliance on ranking to produce the right answer by luck.

    if (request.seed !== undefined && !descriptor.features.seed) {
      // A seed is a reproducibility hint; dropping it is disclosed, not fatal.
      adaptations.droppedHints = [...(adaptations.droppedHints ?? []), 'seed'];
    }

    const model = pickModel(request, descriptor);
    if (!model) {
      rejections.push({
        provider: descriptor.provider,
        reason: request.model
          ? `model "${request.model}" is not offered by this provider`
          : 'provider offers no models',
      });
      continue;
    }

    // The selected model must be able to produce the requested container (see the note
    // above the format gate for why this is a hard rejection).
    if (!model.outputFormats.includes(request.output.format)) {
      rejections.push({
        provider: descriptor.provider,
        model: model.id,
        reason: `model cannot produce ${request.output.format} output`,
      });
      continue;
    }

    // ── Size / aspect gate ──────────────────────────────────
    const sizeResult = resolveSize(request, descriptor, model);
    if (!sizeResult.ok) {
      rejections.push({
        provider: descriptor.provider,
        model: model.id,
        reason: sizeResult.reason,
      });
      continue;
    }

    // ── Quality gate ────────────────────────────────────────
    let adaptedQuality = request.quality;
    if (request.quality && !model.qualityLevels.includes(request.quality)) {
      if (!descriptor.features.quality) {
        adaptedQuality = null;
        adaptations.droppedHints = [...(adaptations.droppedHints ?? []), 'quality'];
      } else if (model.qualityLevels.length > 0) {
        adaptedQuality = nearestQuality(request.quality, model.qualityLevels);
      } else {
        // The provider accepts a quality field but declares no levels for this model, so
        // there is nothing to snap onto. Dropping it is disclosed rather than invented.
        adaptedQuality = null;
        adaptations.droppedHints = [...(adaptations.droppedHints ?? []), 'quality'];
      }
    }

    // ── Style ───────────────────────────────────────────────
    // Folded into the chat instruction, but a native endpoint has no field for it. Dropping
    // it is recorded so the caller is told, rather than the style silently vanishing from a
    // request that mentioned it.
    if (request.style && !descriptor.features.style) {
      adaptations.droppedHints = [...(adaptations.droppedHints ?? []), 'style'];
    }

    // ── Capability declaration gate ─────────────────────────
    // Applied only where a provider's declared limits are the sole reason an otherwise
    // satisfiable request would fail. A chat-only deployment therefore keeps its previous
    // acceptance profile — the fallback folds an over-limit request into a fan-out and
    // discloses it, which is more useful to the caller than a rejection — whereas two
    // providers make an over-limit request genuinely routable to one that can take it, and
    // a hard rejection is the honest answer there.
    if (descriptors.length > 1) {
      if (request.count > descriptor.limits.maxBatch) {
        rejections.push({
          provider: descriptor.provider,
          reason: `limits.maxBatch is ${descriptor.limits.maxBatch}, request asked for ${request.count}`,
        });
        continue;
      }
      if (
        request.referenceImages &&
        request.referenceImages.length > descriptor.limits.maxReferenceImages
      ) {
        rejections.push({
          provider: descriptor.provider,
          reason:
            `limits.maxReferenceImages is ${descriptor.limits.maxReferenceImages}, request ` +
            `carried ${request.referenceImages.length}`,
        });
        continue;
      }
    }

    candidates.push({
      descriptor,
      model,
      adaptedSize: sizeResult.size,
      adaptedAspect: request.aspect,
      adaptedQuality,
    });
  }

  if (candidates.length === 0) {
    const detail = rejections.map(
      (r) => `${r.provider}${r.model ? `/${r.model}` : ''}: ${r.reason}`,
    );

    // Name the available providers when the caller asked for one that is not configured,
    // rather than reporting a generic capability failure.
    if (request.provider && request.provider !== 'auto') {
      const known = descriptors.map((d) => d.provider);
      throw new UnsupportedCapabilityError(
        `Provider "${request.provider}" is not configured or cannot serve this request. ` +
          `Configured providers: ${known.length > 0 ? known.join(', ') : '(none)'}.`,
        detail,
      );
    }

    throw new UnsupportedCapabilityError('No configured provider can satisfy this request', detail);
  }

  // ── Rank ──────────────────────────────────────────────────
  // Prefer a provider that returns real pixels, then cheaper models, then lower observed
  // latency, then the caller's own order. The class preference comes first on purpose: it
  // is a stated policy ("use the image endpoint when there is one"), not a cost accident.
  //
  // Only the *order* is affected, never the candidate set. Everything that survives the
  // gates above stays in `ranked` and therefore stays available as a failover attempt, so a
  // preferred-but-broken native endpoint fails over to the chat path instead of failing the
  // request.
  const ranked = [...candidates].sort((a, b) => {
    const classA = REAL_IMAGE_PROVIDERS.has(a.descriptor.provider) ? 0 : 1;
    const classB = REAL_IMAGE_PROVIDERS.has(b.descriptor.provider) ? 0 : 1;
    if (classA !== classB) return classA - classB;

    const costA = a.model.costPerImageUsd ?? Number.POSITIVE_INFINITY;
    const costB = b.model.costPerImageUsd ?? Number.POSITIVE_INFINITY;
    if (costA !== costB) return costA - costB;

    const latA = a.descriptor.p50LatencyMs ?? Number.POSITIVE_INFINITY;
    const latB = b.descriptor.p50LatencyMs ?? Number.POSITIVE_INFINITY;
    if (latA !== latB) return latA - latB;

    // Deprioritise anything self-reporting as degraded.
    const rankA = a.descriptor.status === 'available' ? 0 : 1;
    const rankB = b.descriptor.status === 'available' ? 0 : 1;
    return rankA - rankB;
  });

  const winner = ranked[0];

  // Record disclosed size adaptation from the winning candidate.
  if (
    request.size &&
    winner.adaptedSize &&
    (winner.adaptedSize.width !== request.size.width ||
      winner.adaptedSize.height !== request.size.height)
  ) {
    adaptations.sizeAdjustedFrom = { ...request.size };
    adaptations.notes = [
      ...(adaptations.notes ?? []),
      `size ${request.size.width}x${request.size.height} adjusted to ` +
        `${winner.adaptedSize.width}x${winner.adaptedSize.height} for ${winner.descriptor.provider}`,
    ];
  }

  // Native batching, or planned fan-out for n>1.
  if (request.count > 1 && !winner.descriptor.features.batch) {
    adaptations.fannedOutFromCount = request.count;
    adaptations.notes = [
      ...(adaptations.notes ?? []),
      `${request.count} images will be produced as ${request.count} separate calls`,
    ];
  }

  // Failover order: the winner first, then remaining usable candidates.
  const attempts: Attempt[] = ranked.slice(0, 3).map((c) => ({
    provider: c.descriptor.provider,
    model: c.model.id,
    timeoutMs: c.descriptor.limits.timeoutMs,
  }));

  return { attempts, adaptations, rejections };
}

/** Select the requested model, or the cheapest offered one when unspecified. */
function pickModel(
  request: ImageGenerationRequest,
  descriptor: CapabilityDescriptor,
): ModelDescriptor | null {
  if (request.model) {
    return descriptor.models.find((m) => m.id === request.model) ?? null;
  }
  if (descriptor.models.length === 0) return null;
  return [...descriptor.models].sort(
    (a, b) => (a.costPerImageUsd ?? Infinity) - (b.costPerImageUsd ?? Infinity),
  )[0];
}

type SizeResolution =
  { ok: true; size: { width: number; height: number } | null } | { ok: false; reason: string };

/**
 * Find a size this provider can actually produce.
 *
 * Discrete-size providers (DALL·E 3) get nearest-match behaviour, which is *recorded*
 * in AppliedAdaptations so the caller is told — the previous implementation rewrote the
 * size silently, which the audit flagged as a contract violation.
 */
function resolveSize(
  request: ImageGenerationRequest,
  descriptor: CapabilityDescriptor,
  model: ModelDescriptor,
): SizeResolution {
  const spec = model.sizes;

  if (spec.kind === 'range') {
    if (!request.size) return { ok: true, size: null };
    const { width, height } = request.size;
    const fits = (n: number) => n >= spec.min && n <= spec.max && n % spec.multiple === 0;
    if (!fits(width) || !fits(height)) {
      return {
        ok: false,
        reason:
          `size ${width}x${height} outside supported range ` +
          `${spec.min}-${spec.max} (multiples of ${spec.multiple})`,
      };
    }
    return { ok: true, size: { width, height } };
  }

  // Discrete sizes.
  if (spec.sizes.length === 0) {
    return { ok: false, reason: 'provider declares no supported sizes' };
  }

  if (request.size) {
    const exact = spec.sizes.find(
      (s) => s.width === request.size!.width && s.height === request.size!.height,
    );
    if (exact) return { ok: true, size: { ...exact } };
    return { ok: true, size: nearestSize(request.size, spec.sizes) };
  }

  if (request.aspect) {
    const target = ASPECT_VALUES[request.aspect];
    const byAspect = spec.sizes.find(
      (s) => Math.abs(s.width / s.height - target) < Math.abs(1 - target) * 0.02 + 0.01,
    );
    if (byAspect) return { ok: true, size: { ...byAspect } };
  }

  return { ok: true, size: { ...spec.sizes[0] } };
}

/** Numeric value of each supported aspect ratio. */
const ASPECT_VALUES: Record<AspectRatio, number> = {
  '1:1': 1,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
};

/**
 * Nearest supported size, compared on aspect ratio first and pixel count second.
 *
 * Aspect dominates because a wrong aspect distorts the composition, whereas a modest
 * difference in resolution usually does not.
 */
function nearestSize(
  requested: { width: number; height: number },
  sizes: Array<{ width: number; height: number }>,
): { width: number; height: number } {
  const requestedAspect = requested.width / requested.height;
  const requestedPixels = requested.width * requested.height;

  let best = sizes[0];
  let bestScore = Infinity;

  for (const size of sizes) {
    const aspectDelta = Math.abs(size.width / size.height - requestedAspect) / requestedAspect;
    const pixelDelta = Math.abs(size.width * size.height - requestedPixels) / requestedPixels;
    // Weight aspect difference far more heavily than pixel difference.
    const score = aspectDelta * 10 + pixelDelta;
    if (score < bestScore) {
      bestScore = score;
      best = size;
    }
  }

  return { width: best.width, height: best.height };
}

/** Snap a requested quality onto the nearest level the model offers. */
function nearestQuality(requested: QualityLevel, supported: QualityLevel[]): QualityLevel {
  const order: QualityLevel[] = ['draft', 'standard', 'high'];
  const wanted = order.indexOf(requested);

  let best = supported[0];
  let bestDistance = Infinity;
  for (const level of supported) {
    const distance = Math.abs(order.indexOf(level) - wanted);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = level;
    }
  }
  return best;
}
