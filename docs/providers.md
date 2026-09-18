# Providers

A **provider** is an outbound adapter that talks to one image-generation service. The
engine routes to providers through capability negotiation, so nothing in the request path
hardcodes which service is used.

## Available providers

| Name | Service | Required env | Notes |
|---|---|---|---|
| openclaw | Any openclaw-compatible image API | OPENAI_API_KEY | Primary provider. See the naming note below. |
| stability | Stability AI (Stable Diffusion) | STABILITY_API_KEY | Native negative prompts and step control. |
| replicate | Replicate (Flux) | REPLICATE_API_TOKEN | Returns CDN URLs; inlined when base64 is requested. |
| <custom> | Your own HTTP endpoint | CUSTOM_BACKENDS | One provider per entry in the JSON array. |

A provider registers only when its credential is present. A base URL without an API key
does **not** register the provider, because advertising a provider that cannot be called
means it gets selected and then fails upstream.

## Naming: what "openclaw" means here

The `openclaw` provider speaks the same HTTP protocol that openclaw's image API exposes:
`POST {baseUrl}/images/generations`, bearer auth, a `data` array in the response.

The name refers to **the protocol, not a vendor**. Configure `OPENAI_BASE_URL` to point at
api.openai.com, Azure openclaw, LM Studio, LocalAI, or any compatible image service. The
environment variables are named `OPENAI_*` for historical reasons.

The provider is configured with `dall-e-3` as its default model because that is the most
common target, but any model id the endpoint accepts can be used. List additional ids in
`OPENAI_EXTRA_MODELS`; unknown models are assumed to accept arbitrary sizes rather than
being constrained to DALL-E's discrete buckets.

## Capability negotiation

Every provider declares a `CapabilityDescriptor` describing what it can actually do. The
matcher reads these to decide, before dispatching, whether a request is servable, whether
it must be adapted, and which provider should win.

A descriptor covers:

- **Models**, each with its supported sizes (either an explicit list or a range), aspect
  ratios, quality levels and output formats.
- **Features**: whether negative prompts, seeds, step counts, guidance scale, batching,
  image-to-image, inpainting and revised prompts are supported.
- **Limits**: batch size, prompt length, reference-image count, timeout.
- **Routing signals**: concurrency, observed latency, relative cost, current status.

### Why this exists

Without it, capabilities get guessed, and the failure is invisible. Two concrete cases
from this codebase's history:

- DALL-E 3 accepts only three discrete sizes. The old code silently rewrote any requested
  size to the nearest bucket, so a caller asking for 1500x1500 received 1024x1024 with no
  indication. Now the constraint is declared, the substitution is computed by the
  matcher, and it is reported back to the caller.
- `n > 1` against a non-batching provider must become several calls. Declaring `batch:
  false` lets the engine plan the fan-out explicitly, rather than issuing a request the
  provider would ignore.

### Adaptation is always disclosed

Any change the engine makes to a request is recorded in `AppliedAdaptations`:

- `sizeAdjustedFrom` — the size the caller asked for, when it was substituted.
- `droppedHints` — hint fields the chosen provider cannot honour, such as `seed` or
  `quality`.
- `fannedOutFromCount` — set when `count` was satisfied by several calls.
- `notes` — human-readable detail.

An empty `AppliedAdaptations` means the request was honoured verbatim.

## Ranking and failover

Candidates that survive the hard filters are ranked by relative cost, then observed
latency, then status (an `available` provider outranks a `degraded` one). The matcher
emits an ordered list of up to three attempts.

Failover is plan-driven. When an attempt fails terminally, the next is tried. A provider
that keeps failing trips its circuit breaker and is skipped entirely until a probe
succeeds, rather than being called again on every request.

## Custom providers

Register any HTTP endpoint that accepts a JSON POST:

    CUSTOM_BACKENDS=[{"name":"my-sd","url":"http://localhost:7860/generate","models":["sdxl"]}]

Optional fields per entry: `api_key` (sent as a bearer token), `headers` (extra headers),
and `body_template` (a JSON string with `{{placeholders}}` for `{{prompt}}`,
`{{negative_prompt}}`, `{{width}}`, `{{height}}`, `{{steps}}`, `{{cfg_scale}}`,
`{{seed}}`, `{{model}}` and `{{n}}`).

The response may express the image in any of these shapes, and they are all recognised:

    { "image_base64": "..." }
    { "image_url": "https://..." }
    { "output": "https://..." }
    { "images": [{ "base64": "..." }] }
    { "data": [{ "b64_json": "..." }] }

If none yields an image, the provider throws. It does **not** report success with no
pixels, which the previous implementation did.

## Adding a provider

1. Implement `ImageProvider` from `src/providers/provider.interface.ts`. A provider
   receives a canonical request and returns a canonical result, and must know nothing
   about protocols or adapters.
2. Declare an accurate `CapabilityDescriptor`. Accuracy matters more than optimism: an
   over-claiming descriptor produces a request the provider cannot honour, while an
   under-claiming one only makes the matcher avoid it.
3. Throw `ProviderError` on failure, preserving the upstream status so the engine can
   classify retryability. A bare `Error` is treated as retryable and loses that detail.
4. Register it in `ProviderRegistry.fromConfig`.
5. Add unit tests that stub `fetch` and assert both the outgoing payload and the error
   classification. See `tests/unit/providers/` for the pattern.

## Verification status

Provider behaviour is verified against stubbed `fetch` responses and the documented API
shapes. It is **not** verified against live paid APIs in this repository's test suite,
because that would require credentials in CI.

One consequence worth naming: the Replicate provider's create call was corrected to use
`POST /v1/models/{owner}/{name}/predictions` for owner/name model ids, because
`POST /v1/predictions` expects a version hash in its `version` field and the previous code
sent a model name there. This fix follows the documented API shape and is covered by a
stubbed test, but it has not been confirmed against a live Replicate token. If you use
Replicate, verify it first.
