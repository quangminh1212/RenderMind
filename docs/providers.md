# Providers

A **provider** is an outbound adapter that talks to one image-generation service. The
engine routes to providers through capability negotiation, so nothing in the request path
hardcodes which service is used.

## The two providers

| Name | Service | Required env | Returns |
|---|---|---|---|
| `native` | `POST {IMAGE_BASE_URL}/images/generations` | `IMAGE_API_KEY` **and** `IMAGE_MODEL` | real raster pixels |
| `chat` | `POST {CHAT_BASE_URL}/chat/completions` | `CHAT_API_KEY` | vector markup, rasterized |

They answer different questions and neither replaces the other.

**`native` is the better image generator.** It calls an endpoint that was built to produce
images — the shape LiteLLM exposes for DALL·E, gpt-image-1, Imagen, Bedrock, Stability,
Flux and others — and receives an actual raster. It is preferred whenever it is configured.

**`chat` is the honest fallback, and the only source of two things.** A text-only model
cannot emit pixels it has not seen, so this path asks it to compose vector geometry instead
and rasterizes the result. Its output is a diagram, not a photograph. But it is the only
path that:

- produces `format: 'svg'` — a real document a client can edit and rescale, which no images
  API returns;
- accepts input images, and therefore serves `/vision`.

Both properties are *declared* in each provider's capability descriptor, not special-cased
in the router. The `native` provider does not list `svg` in its `outputFormats` and declares
`imageToImage: false`; the matcher reads both and routes accordingly.

A third, narrower property sits alongside them: with `CHAT_VISION_REFINEMENT_ROUNDS` above
`0` and `CHAT_VISION_MODEL` set, the chat path will render each drawing it produces and ask a
vision model to review it, then revise once per round. It is off by default and applies to the
chat path only — see [Vision refinement](#vision-refinement-closing-the-loop-on-a-model-that-cannot-see).

### `CHAT_RENDER_MODE`: asking for a scene instead of a document

`CHAT_RENDER_MODE` selects what the chat provider asks the model to *produce*. `svg` is the
default and is the historical behaviour, byte for byte. `scene` is opt-in and changes only the
instruction and how the reply is read:

| Value | What the model is asked for | How the reply is read |
|---|---|---|
| `svg` (default) | one complete SVG document | `extractImages` → `validateSvg` |
| `scene` | one compact **JSON scene** (layers of typed geometry) | `compileTextScene` → the platform's own gate |

The distinction that matters is where the document is written. In `svg` mode the *model*
authors markup, and RenderMind's job is to refuse the markup it should not accept. In `scene`
mode the model authors **data** — shapes with numeric fields, never SVG, base64, pixels or a
`data:` URL — and RenderMind's own serializer writes the document from validated geometry. So
there is no path by which model-authored text becomes an element, an attribute or an event
handler: the payload is `JSON.parse`d, normalized, and reassembled.

The two modes converge at the **same delivery path**. A compiled scene yields a final,
standalone SVG document — the same artifact an SVG-mode reply produces — so `deliver` rasterizes
it to PNG or passes it through for `format: 'svg'` with no mode check. A caller sees identical
payload shapes either way; only the upstream instruction and the parse differ.

A scene that fails validation gets **one bounded repair turn** (the compiler's reason, in fixed
vocabulary, is restated with the schema). A second failure is terminal: a truthful
`unsupported_output` (HTTP 422), never a partly-drawn image. Nothing model-authored — the
prompt, the reply, the key — is ever logged; the failure log carries only the compiler's stage
and code. An unrecognised `CHAT_RENDER_MODE` value is a startup error, not a silent fallback.

## Routing: `PROVIDER_STRATEGY`

| Value | Behaviour |
|---|---|
| `auto` (default) | Prefer `native`; `chat` remains a failover attempt in the plan |
| `chat` | Pin the previous behaviour — the chat path only, even with a native backend configured |
| `native` | Native only. `format: 'svg'` and `/vision` then have no provider and return `400` |

An unrecognised value is a **startup error**, not a silent fallback: a typo in a routing
switch must not quietly change which upstream is billed.

`auto` is a *declared* preference, not an emergent one. Neither provider declares a cost, so
ranking by cost is a tie; ranking would then fall to `p50LatencyMs`, which would let the
native provider win by accident of a latency constant. The matcher instead sorts on provider
class first, and the strategy switch decides which descriptors the matcher sees at all.

**Registration is conditional, and that keeps zero-config behaviour unchanged.** `native` is
registered only when **both** `IMAGE_API_KEY` and `IMAGE_MODEL` are set, and there is no
default model — a guessed model id would 404 on every request. With no native backend
configured, the descriptor set is exactly what it was before this provider existed.

`PROVIDER_STRATEGY=chat` produces the *same descriptor set* as having no native provider at
all, which is what makes it a genuine pin rather than an approximation of one.

### Failover is real, in both directions

The plan keeps every provider that passes the gates, ordered — not just the winner. A native
endpoint that fails terminally (a `400` content-policy rejection, say) fails over to `chat`,
and the response's `provider` field names the provider that *actually served* the request.

A failure is only retried when retrying could help. A `4xx` is terminal and moves straight to
the next attempt rather than burning quota to confirm a known answer.

### What the native provider does not claim

| | Why |
|---|---|
| No `svg` | The images API has no vector mode. Claiming it would hand a caller a bitmap under a document request. |
| No image-to-image | The API has no image-input parameter in this schema. Claiming it would send reference images into a field the endpoint ignores, producing a plausible success that silently discarded the caller's input. |
| No `seed`, `steps`, `guidanceScale` | No field exists for them. The matcher records them as dropped hints instead. |
| No `negativePrompt`, `style` | Folded into the prompt text instead, and disclosed. |

`/vision` therefore routes to the chat provider through **capability matching**: the native
provider declares `imageToImage: false`, fails the feature gate, and is rejected. There is no
route-level special case, so the behaviour cannot drift from the declaration.

## How a chat model is made to answer with an image

A text-only model cannot emit pixels it has not seen. Asked for a PNG it describes a
picture, invents a URL that resolves to nothing, or emits base64 that decodes to corrupt
bytes — three failures that all read as successes. So the provider asks for the one image
format a language model can genuinely *author*: vector markup. Geometry is text, so a model
composing `path` and `rect` elements is drawing rather than recalling.

The provider sends a system instruction establishing that requirement, then extracts the
drawing from whatever the model returns. Shapes are tried in order, because models differ:

1. an SVG document — bare, inside a code fence, or as a `data:image/svg+xml;base64,...` URI
2. a `content` part carrying `image_url` (the multimodal shape)
3. a `data:image/...;base64,...` URI for a raster
4. a bare image URL in the text (`.png`/`.jpg`/`.webp`)
5. a JSON object with `b64_json` / `image_base64` / `images[]`, emitted as text

SVG is checked first and short-circuits: the instruction asks for exactly one document, so
when a model supplies a drawing and also narrates a URL, the drawing is the artifact it was
told to produce. Taking the URL would hand the caller a link the engine never vetted.

### The output container

The caller's `format` decides what is delivered:

| `format` | Delivered |
|---|---|
| `png` (default) | the drawing, rasterized to PNG bytes |
| `svg` | the document itself, as `image/svg+xml` — **chat path only** |
| `jpeg`, `webp` | returned when the upstream supplies that raster directly; an SVG fallback refuses rather than mislabelling PNG bytes |

For the text-only SVG fallback specifically, use `png` (the default) or explicit `svg`.
JPEG/WebP conversion is not guessed or MIME-relabeled; if the upstream only authored SVG,
RenderMind returns a terminal `unsupported_output` for those containers.

Rasterization is what keeps the default contract intact. A caller who asks for PNG receives
PNG bytes, and never a document in the raster slot. `format: 'svg'` must be asked for
explicitly, because an SVG is a document a browser renders — handing one to a client that
expects a bitmap is a substitution, and the inverse (rasterizing) costs the caller nothing
they asked to keep.

Every delivered image also carries `svg` with the source document, so the artifact stays
reproducible and re-renderable at any resolution without asking the upstream again.

### Validation

Model-authored SVG is untrusted input that a client will hand to a browser, so every
document passes a gate before delivery — see `src/platform/svg.ts`. It is refused when it is
**fake** (not SVG at all, mislabelled bytes, no drawable geometry, truncated markup) or
**unsafe** (`<script>`, `on*=` handlers, `<foreignObject>`, DOCTYPE/entity declarations,
external or `data:` references, oversized payloads). The mime a model *wrote* is never
trusted; the payload is classified from its own bytes.

A refusal is a **terminal** `unsupported_output` (`422`) naming the specific defect. It is
never retried — a model that just emitted a script will emit one again — and nothing is
substituted to fill the gap.

Rendering is bounded: a document's declared `viewBox` is model-authored, so a
`viewBox="0 0 100000 100000"` would otherwise ask for a ~40 GB allocation from a single
prompt. Rasters are capped at 4096 px on the long edge and 4096×4096 pixels.

### Vision refinement: closing the loop on a model that cannot see

The premise of the chat path is that a text-only model *composes* geometry rather than
recalling pixels. The consequence is that it cannot check its own work: it never sees the
image it authored, so a drawing that misses the subject, loses a colour or renders
unreadable text is delivered as a success with no way to notice.

`CHAT_VISION_REFINEMENT_ROUNDS` adds a bounded, opt-in review step that does see it. It is
off at `0`, capped at `5`, and requires `CHAT_VISION_MODEL` to be explicitly configured.

**One round, in full:**

| Step | Call | Model |
|---|---|---|
| 1 | rasterize the last drawing locally at the requested size | — |
| 2 | review: the rendered **PNG** plus the original request, demanding one JSON object | `CHAT_VISION_MODEL` |
| 3 | revise: a fresh drawing carrying the previous document, the original instruction, and the critique | the drawing model |

**Why the rendered PNG, not the source.** A reviewer handed the SVG can only re-imagine the
geometry, which is the same act that produced the drawing. The raster is what a human will
actually see.

**Why a strict JSON reply.** A free-text critique cannot be handed to a second model without
smuggling one model's prose into another's context, unparsed and unbounded. The reviewer
returns `{verdict, summary, issues[], suggestions[]}`; each field is coerced, bounded
(6 items, 400 characters) and re-emitted as a numbered list attributed as *reviewer feedback*.
The live GLM route is also normalized when it returns its observed
`evaluation: {score, reason}` shape or a bounded boolean checklist. A reply that is not one
of those understood objects — prose, truncated JSON, an unknown verdict, or a `revise` with
nothing to revise — yields no critique, the pass stops, and the existing drawing is delivered.
Guessing there would mean rewriting a drawing on the strength of text the reviewer did not
commit to.

**Why the revision is a separate call.** The drawing request does not carry the image it
produced, so a model asked to critique its own output from memory is asserting things about an
artifact it can no longer see. A round costs two calls rather than one because the inspection
phase is genuinely a second upstream interaction; folding it in would have bought a cheaper
loop at the price of a review that reviews nothing.

**Failure rules.** A round is atomic — review *and* revision, or neither — so there is no
state in which a critique was accepted and the drawing was not updated. Any failure at any
step (render, review, revision, or a revision refused by the SVG gate) is logged and absorbed:
the last valid drawing is delivered, because an optional quality pass must not convert a
successful generation into a failed one. The two exceptions are deliberate and both preserve
honesty:

- **A failed initial generation still fails.** The pass runs only once a valid image exists,
  so it can never mask the one failure that is the caller's actual answer.
- **A raster returned directly is not refined.** There is no document text to hand back, and
  reconstructing one would be an invention. The pass is skipped.

**Cost.** Each round is two extra upstream calls plus a local render. Round 1 triples the call
count for a request that previously cost one. The response reports the model that produced the
delivered drawing — the drawing model, both before and after a revision, since the service did
not change.

**Never refined: the native provider.** It returns real pixels from an endpoint built to make
them, so it has neither the failure mode this pass corrects nor an SVG document to hand back.
The setting is read only by `ChatProvider`.

## Capability declaration

Each provider declares a `CapabilityDescriptor`: models, supported sizes, output formats,
and which hint fields it can honour.

**The chat provider** declares:

- `negativePrompt`, `seed`, `steps`, `guidanceScale`, `quality`, `style`, `batch`: **false**
  (folded into the instruction text, not sent as API fields — disclosed, not pretended).
- `imageToImage`: true only when `CHAT_VISION_MODEL` is explicitly configured. The chat model
  is not assumed to understand image input merely because it can answer text prompts.
- A wide size range `64..4096` (multiple of 8), because a chat model does not constrain
  output pixels; the requested size is carried in the instruction.
- Output formats: `png`, `jpeg`, `webp` and `svg`.

Because the provider cannot honour a seed, a `count > 1` request is varied by *prompt*
rather than by seed: each sub-job receives a distinct compositional direction (framing, mood
and palette, viewpoint, scale and density, style, negative space). Without this, three
sub-jobs sent one identical instruction return three copies of one drawing, and the count is
a lie. The fan-out is disclosed in `AppliedAdaptations`, including the fact that a pinned
seed was varied because the upstream cannot accept one.

**The native provider** declares:

- `batch`: **true** by default — one upstream call carrying `n`, so `count > 1` is *not* a
  fan-out. Set `IMAGE_SUPPORTS_BATCH=false` for a backend that rejects `n>1`; the engine then
  fans out one `n=1` call per image and discloses that adaptation. Its prompt is never
  rewritten for variation while native batching is enabled, because the variant directions
  are written for a language model; an image model handed "Variant 1 of 3. Emphasize a
  different composition…" draws the words.
- `quality`: true (forwarded as the API field), `nativeBase64` and `nativeUrl`: true.
- `imageToImage`, `inpainting`: **false** — the images API has no image-input parameter.
- `seed`, `steps`, `guidanceScale`, `negativePrompt`, `style`: **false** — no field exists,
  so the matcher records them as dropped hints instead of the provider pretending.
- **Discrete sizes**, so an unsupported size is nearest-matched *and disclosed* via
  `sizeAdjustedFrom`. A caller who sends `1000x1000` to a set of powers-of-two sizes gets a
  1024x1024 image and is told the substitution happened.
- Output formats: `png`, `jpeg`, `webp` — **never `svg`**.

The capability matcher decides what can serve a request before dispatching, and the engine
records any adaptation in `AppliedAdaptations` rather than silently dropping it.

One consequence worth stating plainly: identical-looking requests can be served by different
providers depending on `format`. `{"format":"png"}` under `auto` goes to `native` when it is
configured; `{"format":"svg"}` goes to `chat`, because that is the only provider that can
produce the artifact asked for. That is a capability fact, not a preference.

## Adding a provider

1. Implement `ImageProvider` (`isAvailable`, `getCapabilities`, `generate`).
2. Register it in `ProviderRegistry.fromConfig`, only when it is fully configured.
3. Add its capability declaration so the matcher can rank it — and declare nothing it cannot
   honour, because the declaration *is* the routing contract.

The dependency direction is one-way: **adapters → engine → providers**. A provider knows
only the canonical request and result, which is what lets a second provider class be added
without touching routing.

## Live verification

The native path is covered against a stubbed upstream (b64 and URL results, URL inlining,
batching, discrete-size disclosure, upstream error mapping and router strategy) and against
the reference VPS. LiteLLM publishes `stable-diffusion-xl-base-v10`, and the following was
verified through the full route `RenderMind -> LiteLLM -> 9router -> SDXL`:

- the public LiteLLM model list contains the image alias;
- `POST /v1/images/generations` returns a real PNG;
- RenderMind `PROVIDER_STRATEGY=native` returns a 1024x1024 PNG;
- ten independent `count: 1` calls return ten images when `IMAGE_SUPPORTS_BATCH=false`.

The backend-specific limits remain real: it only accepts 1024x1024 and rejects `n>1`. A
different image model can keep the default native batching or set the flag to false, according
to its own API contract.
