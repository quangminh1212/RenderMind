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

    npm install
    cp .env.example .env
    npm run dev

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

## Configuration

Every upstream is one chat-completions endpoint. See [.env.example](.env.example) for the
annotated list. Invalid values are a startup error naming each offending variable, rather
than a confusing runtime failure.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Listen port |
| `NODE_ENV` | development | Set to `production` for strict mode |
| `API_KEYS` | none | Required in production |
| `CORS_ORIGINS` | `*` outside production | Allowed origins |
| `CHAT_API_KEY` | none | **Enables the provider** — no key, no provider |
| `CHAT_BASE_URL` | `https://api.openai.com/v1` | Any chat-completions endpoint |
| `CHAT_MODEL` | `gpt-4o` | Model used for text-only generation |
| `CHAT_VISION_MODEL` | falls back to `CHAT_MODEL` | Model used when input images are present |
| `CHAT_EXTRA_MODELS` | none | Extra model ids the endpoint accepts |
| `CHAT_SYSTEM_PROMPT` | built-in | Replaces the "answer with an image" instruction |
| `REDIS_URL` | redis://localhost:6379 | Optional cache |
| `MAX_GENERATION_CONCURRENCY` | 10 | Global cap on concurrent upstream calls |

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

## Architecture

    adapters/chat/       protocol in:  validate and translate the wire body
    engine/              the canonical core
      capability.matcher   decides what can serve a request, and how
      generation.service   plan-driven dispatch, concurrency, failover
      errors               typed errors preserving upstream detail
    providers/           protocol out: talk to the chat model
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

    npm run dev            # watch mode
    npm test               # unit and integration tests
    npm run test:coverage  # with coverage thresholds
    npm run typecheck
    npm run lint
    npm run verify         # typecheck + lint + test

## Known limitations

These are stated plainly because a proxy that overstates its capability is worse than one
that documents its gaps.

- **Image quality depends entirely on the upstream model.** A text-only model told to draw
  may return a placeholder, a stock image, or refuse. RenderMind reports what it received;
  it cannot make a model better at drawing.
- **Input images must be base64 data URIs.** Remote URLs are rejected with a 400 rather
  than fetched, so a bad URL is a clear client error, not an upstream failure inside the
  model call.
- **Reference images require a vision model.** Set `CHAT_VISION_MODEL` for `/vision` to
  reach a model that can see them.
- **Seed, steps and guidance scale are not sent** unless the endpoint accepts them; those
  hints are carried in the instruction text, not as API fields.

## License

MIT. See [LICENSE](LICENSE).
