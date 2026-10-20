<div align="center">

# RenderMind

**Give a text-only model the ability to generate images**

RenderMind is an engine that turns a chat-completions model into an image generator.
Ask it for an image; it instructs the model, extracts the result, and hands it back —
with an honest error if the model cannot actually produce pixels.

[![CI](https://github.com/quangminh1212/RenderMind/actions/workflows/ci.yml/badge.svg)](https://github.com/quangminh1212/RenderMind/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org)

</div>

---

## What is RenderMind?

Most capable models expose one endpoint: `POST /chat/completions`. They have no images
API at all. RenderMind is the layer that turns such a model into an image source — by
instructing it to answer with an image, then extracting the image from the reply.

There are two endpoints:

| Endpoint | Input | Use it when |
|---|---|---|
| `POST /chat` | a text prompt | you want an image from a description |
| `POST /vision` | a text prompt **plus** input images | you want an image derived from other images |

Both send the same request shape; `/vision` simply requires `images`.

## Why it exists

The premise is narrow and deliberate: a model that can only talk should still be able to
draw. RenderMind is the adapter that makes that work, and it is built around one rule —
**never pretend a request succeeded**.

- **Honest output.** A model that replies with prose and no image is reported as a
  terminal `422 unsupported_output`, not an empty success. The whole point is to tell you
  when the upstream cannot produce pixels.
- **Honest errors.** A caller mistake is a 4xx. An upstream failure is a 5xx. A crash is
  never dressed up as a client error, and vice versa.
- **Strict delivery.** If you asked for base64, you get base64 — never a silent
  substitution to a URL.
- **Disclosed adaptation.** When the engine alters your request (fans out a batch, drops
  an unsupported hint), it says so rather than hiding it.

## Quick start

### Docker

    git clone https://github.com/quangminh1212/RenderMind.git
    cd RenderMind
    cp .env.example .env    # set CHAT_API_KEY and CHAT_BASE_URL
    docker compose up

### Local

    pnpm install
    cp .env.example .env
    pnpm run dev

The service listens on port 3000. Verify it:

    curl http://localhost:3000/healthz   # liveness, always 200
    curl http://localhost:3000/readyz    # readiness, 200 when a provider is configured

### Generate an image

    curl -X POST http://localhost:3000/chat \
      -H 'Content-Type: application/json' \
      -d '{"prompt":"a red apple on a wooden table","size":"1024x1024"}'

With input images:

    curl -X POST http://localhost:3000/vision \
      -H 'Content-Type: application/json' \
      -d '{
        "prompt":"repaint this in watercolour",
        "images":["data:image/png;base64,<payload>"]
      }'

### Tested LiteLLM native setup

The VPS LiteLLM deployment used for the E2E test now publishes
`stable-diffusion-xl-base-v10` through `/v1/images/generations`. Its backend only accepts
1024×1024 and rejects `n>1`, so configure RenderMind like this (put the LiteLLM key in the
placeholder, never in source control):

    IMAGE_API_KEY=<LiteLLM master key>
    IMAGE_BASE_URL=http://36.50.26.247:4000/v1
    IMAGE_MODEL=stable-diffusion-xl-base-v10
    IMAGE_SUPPORTS_BATCH=false
    PROVIDER_STRATEGY=auto

With this setup, `auto` returns native raster pixels; `IMAGE_SUPPORTS_BATCH=false` makes a
`count: 10` request fan out into ten safe `n: 1` calls.

### GLM-only chat + vision setup

To use only the LiteLLM `glm-5.3` chat route, including GLM reviewing the SVG it just
created, pin the chat strategy and name the same model explicitly for vision:

    CHAT_API_KEY=<LiteLLM master key>
    CHAT_BASE_URL=http://36.50.26.247:4000/v1
    CHAT_MODEL=glm-5.3
    CHAT_VISION_MODEL=glm-5.3
    CHAT_VISION_REFINEMENT_ROUNDS=1
    PROVIDER_STRATEGY=chat

This path intentionally does not use the native SDXL alias. It returns a detailed, safely
rasterized SVG illustration; the live GLM vision response is normalized whether it returns
the requested verdict object, a numeric `evaluation.score/reason` object, or its boolean
visual checklist.

## Configuration

There are two upstream classes. See [.env.example](.env.example) for the annotated list.
Invalid values are a startup error naming each offending variable, rather than a confusing
runtime failure.

**`native`** — a real `POST {IMAGE_BASE_URL}/images/generations` endpoint, returning actual
pixels. Enabled only when both `IMAGE_API_KEY` and `IMAGE_MODEL` are set. Preferred when
configured.

**`chat`** — a chat-completions model *instructed* to answer with vector markup, rasterized
before delivery. Enabled by `CHAT_API_KEY`. Its output is a diagram, not a photograph, but
it is the only path that produces `format: 'svg'` and the only one that serves `/vision`.

Optionally, the chat path can review itself. With `CHAT_VISION_REFINEMENT_ROUNDS` above `0`
**and** `CHAT_VISION_MODEL` set, RenderMind renders each drawing it just produced, sends that
PNG to the vision model with a strict JSON review prompt, and — only when the reviewer reports
concrete visual defects — asks the drawing model to revise the SVG using that critique. It is
off by default, bounded at `5`, and never changes an image that already passed: see
[Vision refinement](#vision-refinement-opt-in).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Listen port |
| `NODE_ENV` | development | Set to `production` for strict mode |
| `API_KEYS` | none | Required in production |
| `CORS_ORIGINS` | `*` outside production | Allowed origins |
| `IMAGE_API_KEY` | none | **Enables the native provider** (with `IMAGE_MODEL`) |
| `IMAGE_BASE_URL` | `https://api.openai.com/v1` | Any images-generations endpoint |
| `IMAGE_MODEL` | none | Model sent upstream. **No default** — a guessed id would 404 |
| `IMAGE_EXTRA_MODELS` | none | Extra model ids the endpoint accepts |
| `IMAGE_SUPPORTS_BATCH` | `true` | Set `false` when the image backend rejects `n>1`; RenderMind fans out one request per image |
| `CHAT_API_KEY` | none | **Enables the chat provider** — no key, no provider |
| `CHAT_BASE_URL` | `https://api.openai.com/v1` | Any chat-completions endpoint |
| `CHAT_MODEL` | `gpt-4o` | Model used for text-only generation |
| `CHAT_MAX_TOKENS` | `8192` | Completion budget for the SVG drawing/revision turn (max `16384`) |
| `CHAT_VISION_MODEL` | unset | Explicit model used when input images are present; required to advertise vision support |
| `CHAT_VISION_REFINEMENT_ROUNDS` | `0` | Opt-in vision review + revision passes on the chat path (max `5`); each round adds two upstream calls |
| `CHAT_EXTRA_MODELS` | none | Extra model ids the endpoint accepts |
| `CHAT_SYSTEM_PROMPT` | built-in | Replaces the "answer with an image" instruction |
| `PROVIDER_STRATEGY` | `auto` | `auto` prefers native; `chat` pins the chat path; `native` is native-only |
| `REDIS_URL` | redis://localhost:6379 | Optional cache |
| `MAX_GENERATION_CONCURRENCY` | 10 | Global cap on concurrent upstream calls |

### Routing

`auto` (the default) prefers the native endpoint and keeps chat as a real failover attempt.
`chat` pins the previous behaviour exactly — same descriptor set, same responses — even when
a native endpoint is configured. `native` serves only from the native endpoint, under which
`format: 'svg'` and `/vision` have no provider and return `400` with a capability error.

`format: 'svg'` always routes to chat, because the images API has no vector mode. `/vision`
always routes to chat, because the images API has no image-input parameter. Neither is a
special case in the router: both providers declare what they can do, and the capability
matcher reads the declaration.

## How a model is made to answer with an image

The provider sends a **system instruction** that establishes the standing requirement:

> You are an image generation backend. When asked for an image, respond with the image
> itself... Return the image as a markdown image whose URL is a data URI... If you cannot
> produce an image, reply with exactly: NO_IMAGE

It then accepts whichever of these the model actually produces, tried in order, because
models differ:

1. a `content` part carrying `image_url` (the multimodal shape)
2. a `data:image/...;base64,...` URI anywhere in the text
3. a bare image URL in the text
4. a JSON object with `b64_json` / `image_base64` / `images[]`, emitted as text

Anything else — prose, an apology, a description — is a terminal failure. `NO_IMAGE` is
never silently swapped for a placeholder.

When a native images endpoint is configured, this path becomes the fallback rather than the
default. The two are not interchangeable, and the difference is declared rather than
inferred from configuration:

| | `native` | `chat` |
|---|---|---|
| Output | real raster pixels | vector markup, rasterized |
| `format: 'svg'` | no — has no vector mode | **yes** |
| `/vision` | no — has no image input | **yes** |
| `count > 1` | one call with `n` | a fan-out with varied prompts |
| Upstream error | preserved status and code | preserved status and code |

### Vision refinement (opt-in)

A text-only model asked to draw cannot tell whether it drew the right thing — it never sees
its own output. `CHAT_VISION_REFINEMENT_ROUNDS` closes that loop, and only for the chat path;
the native provider returns real pixels from an endpoint built to make them, and is never
refined.

It requires **both** settings. A round count above `0` does nothing unless
`CHAT_VISION_MODEL` is explicitly configured, because sending pixels to a model whose image
support was never verified is the same guess the capability descriptor already refuses to
make.

Each round is exactly this, and nothing else:

1. The drawing produced by the last turn is rasterized locally at the requested size.
2. That **rendered PNG** — not the source document — is sent to the vision model with a
   prompt demanding one JSON object: a `verdict` of `accept` or `revise`, a one-sentence
   `summary`, and bounded `issues`/`suggestions` lists.
3. `accept` ends the pass; the drawing is delivered untouched. `revise` — or a reply we
   cannot parse, see below — determines whether step 4 happens.
4. The drawing model is asked for a **fresh** drawing, carrying the previous document, the
   instruction it was originally given, and the reviewer's critique attributed as reviewer
   feedback.

Round 4 is a separate call rather than a continuation of the original conversation because
the drawing request does not carry the image it produced: a model asked to critique its own
output from memory is asserting things about an artifact it can no longer see.

The failure rules are the point of the feature:

- **A failed review or revision is absorbed, and the last valid drawing is delivered.** An
  optional quality pass must not turn a successful generation into a failed one. Every round
  is atomic — review *and* revision, or neither — so there is no state where a critique was
  accepted but the drawing was not updated.
- **A revision only replaces a drawing if it passes the same gate.** A revision that returns
  prose, a placeholder, a script-bearing document or a truncated one is refused by the SVG
  validator and discarded; the drawing under review is delivered instead.
- **A failed initial generation still fails.** The pass runs only once a valid image exists,
  so it can never mask the one failure that is genuinely the caller's answer.
- **A raster the model returned directly is not refined**, because there is no document text
  to hand back. The pass is skipped rather than reconstructing one.
- **A critique we cannot read is not acted on.** Malformed JSON, a missing or unknown
  verdict, or a bare `revise` with nothing to revise all stop the pass. Guessing there would
  mean rewriting a drawing on the strength of text the reviewer did not commit to.

Cost and honesty, stated plainly: a round is two extra upstream calls plus a local render, so
round 1 triples the call count for a request that previously cost one call. The model reported
in the response is the model that produced the delivered drawing, which after a revision is
the drawing model — the same id as before, because nothing about the *service* changed.

## Architecture

    adapters/chat/       protocol in:  validate and translate the wire body
    engine/              the canonical core
      capability.matcher   decides what can serve a request, and how
      generation.service   plan-driven dispatch, concurrency, failover
      errors               typed errors preserving upstream detail
    providers/           protocol out: talk to the upstream
      image.provider       native images endpoint — real pixels
      chat.provider        instructs a model to answer with an image
      prompt.builder       folds intent into the instruction text
    platform/            artifact store, HTTP resilience, metrics

The dependency direction is one-way: **adapters → engine → providers**. Adapters never
import providers, and providers never import adapters. A provider knows only the canonical
request and result, which is what lets a second provider class be added without touching
routing.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/chat` | Image from a text prompt |
| POST | `/vision` | Image from a prompt plus input images |
| GET | `/healthz` `/readyz` `/health` | Liveness, readiness, alias |
| GET | `/metrics` | Prometheus metrics |
| GET | `/docs` | OpenAPI documentation (non-production) |

## Authentication

Set `API_KEYS` to a comma-separated list. Every endpoint except the health probes and
`/docs` then requires a key, presented as `x-api-key` or `Authorization: Bearer`.

Comparison is constant-time. An invalid key returns 401. **In production the server
refuses to start without `API_KEYS`** unless you set `ALLOW_UNAUTHENTICATED=true` — an
unset variable silently producing an open proxy that spends your provider credits is the
failure mode this prevents.

## Development

    pnpm run dev            # watch mode
    pnpm test               # unit and integration tests
    pnpm run test:coverage  # with coverage thresholds
    pnpm run typecheck
    pnpm run lint
    pnpm run verify         # typecheck + lint + test

## Known limitations

These are stated plainly because a proxy that overstates its capability is worse than one
that documents its gaps.

- **The reference LiteLLM route is live-tested, but backend limits still apply.** The VPS
  publishes `stable-diffusion-xl-base-v10`; RenderMind produced 10/10 real 1024x1024 PNGs
  through `native` after configuring `IMAGE_SUPPORTS_BATCH=false`. The backend rejects
  512x512 and `n>1`, so other image models may need different size/batch settings.
- **Image quality depends entirely on the upstream model.** A text-only model told to draw
  may return a placeholder, a stock image, or refuse, and its vector output is a diagram
  rather than a picture. RenderMind reports what it received; it cannot make a model better
  at drawing. Configure a native endpoint when you need real images.
- **`IMAGE_MODEL` has no default.** A guessed model id would 404 on every request, so a
  half-configured native backend is reported as unconfigured rather than silently preferred.
- **Input images must be base64 data URIs.** Remote URLs are rejected with a 400 rather
  than fetched, so a bad URL is a clear client error, not an upstream failure inside the
  model call.
- **Reference images require a vision model.** Set `CHAT_VISION_MODEL` for `/vision` to
  reach a model that can see them.
- **Vision refinement is off by default and costs extra calls.** With
  `CHAT_VISION_REFINEMENT_ROUNDS` at its default of `0`, the chat path makes exactly the one
  upstream call it always has. Each configured round adds two more (one review, one revision)
  plus a local render.
- **Seed, steps and guidance scale are not sent** unless the endpoint accepts them; those
  hints are carried in the instruction text, not as API fields.

## License

MIT. See [LICENSE](LICENSE).
