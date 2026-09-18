<div align="center">

# RenderMind

**An image generation engine for AI coding tools**

Give any AI coding agent, SDK, or chat client the ability to generate images.

[![CI](https://github.com/quangminh1212/RenderMind/actions/workflows/ci.yml/badge.svg)](https://github.com/quangminh1212/RenderMind/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org)

</div>

---

## What is RenderMind?

Claude Code, Cursor, Continue, LiteLLM and Open WebUI can all call an API to generate
images. RenderMind is the service on the other end of that call.

It speaks two protocols that AI tooling already uses, and routes the request to whichever
image provider you have configured:

| Surface | Speaks | Use it when |
|---|---|---|
| `POST /v1/images/generations` | openclaw Images API | Your tool already calls the openclaw image API |
| `POST /v1/messages` | Anthropic Messages API | Your tool calls Claude and needs image output |
| `POST /api/v1/generate` | RenderMind native | You want the full feature set directly |

Point a client at RenderMind instead of the upstream, and it works without code changes.

## Why it exists

A coding agent that needs an image has no standard way to ask for one. RenderMind closes
that gap by acting as the translation layer between the protocols agents speak and the
providers that actually make images.

Three properties matter more than feature count here:

- **Capability negotiation.** Providers declare what they can do. The engine decides
  before dispatching, and reports any adaptation it makes rather than hiding it.
- **Honest errors.** A client mistake is a 4xx. An upstream failure is a 5xx. A requested
  response format is never silently substituted for a different one.
- **Protocol fidelity.** Each surface returns that protocol's own error envelope, so real
  SDKs parse failures instead of throwing on an unrecognised shape.

## Supported providers

| Provider | Service | Credential |
|---|---|---|
| openclaw | Any openclaw-compatible image API (api.openai.com, Azure, LM Studio, LocalAI) | `OPENAI_API_KEY` |
| stability | Stability AI (Stable Diffusion) | `STABILITY_API_KEY` |
| replicate | Replicate (Flux) | `REPLICATE_API_TOKEN` |
| custom | Your own HTTP endpoint | `CUSTOM_BACKENDS` |

"openclaw" names the protocol this provider speaks, not a vendor. See
[docs/providers.md](docs/providers.md).

## Quick start

### Docker

    git clone https://github.com/quangminh1212/RenderMind.git
    cd RenderMind
    cp .env.example .env    # then add at least one provider key
    docker compose up

### Local

    npm install
    cp .env.example .env
    npm run dev

The service listens on port 3000. Verify it:

    curl http://localhost:3000/healthz   # liveness, always 200
    curl http://localhost:3000/readyz    # readiness, 200 when a provider is configured

### Generate an image

openclaw-compatible:

    curl -X POST http://localhost:3000/v1/images/generations \
      -H 'Content-Type: application/json' \
      -H 'Authorization: Bearer <your RenderMind key>' \
      -d '{"prompt":"a red apple on a wooden table","size":"1024x1024"}'

Anthropic-compatible:

    curl -X POST http://localhost:3000/v1/messages \
      -H 'Content-Type: application/json' \
      -H 'x-api-key: <your RenderMind key>' \
      -d '{
        "model":"claude-3-5-sonnet",
        "max_tokens":1024,
        "messages":[{"role":"user","content":"Generate an image of a mountain lake at dawn"}]
      }'

Native:

    curl -X POST http://localhost:3000/api/v1/generate \
      -H 'Content-Type: application/json' \
      -d '{"prompt":"a red apple","count":2,"response_format":"url"}'

## Using it from a coding agent

Any client that supports a custom base URL works:

    import Anthropic from '@anthropic-ai/sdk';

    const client = new Anthropic({
      baseURL: 'http://localhost:3000',
      apiKey: process.env.RENDERMIND_KEY,
    });

    const message = await client.messages.create({
      model: 'claude-3-5-sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Draw a mountain lake at dawn' }],
    });

    // The image arrives as a tool_use block for the generate_image tool.
    const toolUse = message.content.find((b) => b.type === 'tool_use');
    console.log(toolUse.input.images[0].url);

The `generate_image` tool contract is discoverable at `GET /v1/messages/tools`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/images/generations` | openclaw-compatible image generation |
| GET | `/v1/models` | Model discovery for LiteLLM, Open WebUI, Continue |
| POST | `/v1/messages` | Anthropic-compatible image generation |
| POST | `/v1/messages/count_tokens` | Token estimate (called by Claude Code) |
| GET | `/v1/messages/tools` | The `generate_image` tool declaration |
| POST | `/api/v1/generate` | Native generation |
| POST | `/api/v1/batch` | Native batch generation |
| GET | `/api/v1/status/:id` | Generation status and result |
| GET | `/api/v1/backends` | Provider capabilities |
| GET | `/healthz` `/readyz` `/health` | Liveness, readiness, alias |
| GET | `/metrics` | Prometheus metrics |
| GET | `/docs` | OpenAPI documentation (non-production) |

## Authentication

Set `API_KEYS` to a comma-separated list. Every endpoint except the health probes, `/docs`
and `/api/v1/backends` then requires a key.

The key may be presented in any of these forms:

    x-api-key: <key>
    Authorization: Bearer <key>

Comparison is constant-time. An invalid key returns 401.

**In production the server refuses to start without `API_KEYS`** unless you set
`ALLOW_UNAUTHENTICATED=true`. An unset variable silently producing an open proxy that
spends your provider credits is the failure mode this prevents.

## Configuration

All configuration is environment variables; see [.env.example](.env.example) for the
annotated list. Invalid values are a startup error naming each offending variable, rather
than a confusing runtime failure.

Key variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Listen port |
| `NODE_ENV` | development | Set to `production` for strict mode |
| `API_KEYS` | none | Required in production |
| `CORS_ORIGINS` | `*` outside production | Allowed origins |
| `REDIS_URL` | redis://localhost:6379 | Optional cache and record store |
| `MAX_GENERATION_CONCURRENCY` | 10 | Global cap on concurrent upstream calls |
| `OPENAI_API_KEY` | none | Enables the openclaw provider |
| `OPENAI_BASE_URL` | api.openai.com/v1 | Point at any compatible endpoint |
| `STABILITY_API_KEY` | none | Enables Stability |
| `REPLICATE_API_TOKEN` | none | Enables Replicate |
| `CUSTOM_BACKENDS` | none | JSON array of custom HTTP providers |
| `ANTHROPIC_IMAGE_BLOCK_MODE` | off | Set to `extension` for an image content block |

## Architecture

    adapters/          protocol in:  translate a wire format into the canonical model
      openai/          openclaw Images API surface
      anthropic/       Anthropic Messages surface, including SSE
    engine/            the canonical core
      capability.matcher    decides what can serve a request, and how
      generation.service    plan-driven dispatch, concurrency, failover
      generation.repository generation state machine and records
      errors                typed errors preserving upstream detail
    providers/         protocol out: talk to one image service
    platform/          artifact store, HTTP resilience, metrics

The dependency direction is one-way: **adapters -> engine -> providers**. Adapters never
import providers and providers never import adapters. A provider knows only the canonical
request and result, which is what lets "Anthropic in, ComfyUI out" work without
cross-contamination.

`docs/providers.md` explains capability negotiation in detail. `docs/caching.md` covers the
cache key and the generation state machine.

## Development

    npm run dev            # watch mode
    npm test               # unit and integration tests
    npm run test:coverage  # with coverage thresholds
    npm run test:e2e       # end-to-end against a running server
    npm run typecheck
    npm run lint
    npm run verify         # typecheck + lint + test

201 tests cover the engine, the providers, both protocol bridges and the HTTP surface,
including contract tests that drive the real openclaw and Anthropic SDKs against the
bridges.

## Documentation

| Document | Contents |
|---|---|
| [docs/providers.md](docs/providers.md) | Capability negotiation, ranking, adding a provider |
| [docs/protocols/openai-images.md](docs/protocols/openai-images.md) | openclaw bridge: fields, guarantees, divergences |
| [docs/protocols/anthropic-messages.md](docs/protocols/anthropic-messages.md) | Anthropic bridge: the tool_use contract, SSE, divergences |
| [docs/error-taxonomy.md](docs/error-taxonomy.md) | Every error envelope and status decision |
| [docs/caching.md](docs/caching.md) | Cache key design, three-state reads, state machine |
| [SECURITY.md](SECURITY.md) | Threat model, controls, honest limitations |

## Known limitations

These are stated plainly because a proxy that overstates its compatibility is worse than
one that documents its gaps.

- **`/v1/images/edits` and `/v1/images/variations` are not implemented.** They return a
  404 in the protocol envelope, so a client fails predictably rather than silently.
- **Anthropic image output is a `tool_use` block, not an image block.** The Anthropic
  response ContentBlock union has no `image` member, so an image block would break strict
  clients. `ANTHROPIC_IMAGE_BLOCK_MODE=extension` opts in for custom clients.
- **Anthropic `usage` figures are estimates** from character counts, not metered tokens.
- **The SSRF filter does not resolve DNS.** A hostname resolving to a link-local address
  passes it. Treat webhook URLs as trusted input.
- **Provider behaviour is verified against stubbed responses, not live paid APIs.** The
  Replicate model-reference path in particular was corrected against the documented API
  shape but not confirmed with a live token.

## License

MIT. See [LICENSE](LICENSE).
