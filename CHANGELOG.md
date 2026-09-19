# Changelog

All notable changes are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0]

RenderMind is now an engine that turns a **text-only chat model** into an image generator.
This is a major release because the whole upstream model changed: the native image
providers (openclaw Images, Stability, Replicate) and the protocol bridges built on top of
them were removed, because they had nothing left to translate to.

### Added

- `POST /chat` — a text prompt becomes an image.
- `POST /vision` — a text prompt plus input images becomes an image.
- `ChatProvider`: instructs a chat-completions model to answer with an image, then
  extracts the payload from the reply. Four accepted response shapes, tried in order
  (`image_url` part, inline data URI, bare image URL, embedded JSON), because models differ.
- A terminal `unsupported_output` failure (HTTP 422) when a model answers with prose and no
  image, rather than a silent empty success.
- `CHAT_SYSTEM_PROMPT` to replace the built-in "answer with an image" instruction.

### Changed (breaking)

- The public surface is now `/chat` and `/vision`. The previous endpoints
  (`/v1/images/generations`, `/v1/messages`, `/api/v1/generate`, `/api/v1/batch`,
  `/api/v1/status/:id`, `/api/v1/backends`, `/v1/models`) were removed. They existed only to
  bridge protocols to native image providers; with those providers gone, keeping them would
  have advertised compatibility the engine can no longer honour.
- Upstream configuration is now `CHAT_API_KEY`, `CHAT_BASE_URL`, `CHAT_MODEL`,
  `CHAT_VISION_MODEL`, `CHAT_EXTRA_MODELS`. `OPENAI_*`, `STABILITY_API_KEY`,
  `REPLICATE_API_TOKEN` and `CUSTOM_BACKENDS` are gone.
- There is one error envelope for the whole surface. The per-path protocol envelopes were
  removed with the protocols that needed them.

### Removed

- `src/adapters/openai/**` and `src/adapters/anthropic/**` (protocol bridges).
- `src/providers/{openclaw,stability,replicate,custom}.provider.ts`.
- `src/routes/v1/**` (the native `/api/v1/*` family).
- The openclaw/Anthropic response and error builders in `formatAdapters.ts`.
- Unused dependencies: `openai`, `@anthropic-ai/sdk`, `bullmq`, `multer`.

### Fixed

- `images` narrowing in the inbound schema no longer degrades to `{}` under the passthrough
  union, which had produced three type errors at the surface boundary.
- Authentication failure responses use the one envelope, so a client cannot be handed a
  shape it cannot parse.

### Testing

- Integration coverage for both endpoints: validation, canonical translation, delivery
  strictness (`base64` vs `url`), `count` fan-out, and the status each failure class maps
  to (400 client error, 422 unsupported output, 502 upstream, 503 no provider).

## [2.0.0]

A ground-up rebuild of the request path, plus correctness and protocol fixes found by an
audit of 1.0.0.

### Added

- Canonical generation model: caller intent, independent of any vendor or protocol.
- Capability negotiation: providers declare what they can do, and the engine decides
  before dispatching.
- Plan-driven dispatch with bounded concurrency, per-provider circuit breakers and
  explicit failover.
- Prometheus `/metrics`.
- Split liveness (`/healthz`) and readiness (`/readyz`).
- Structured logging with request-id correlation and secret redaction.
- Configuration validated at boot, reporting every invalid variable at once.

### Fixed

- **Cache collisions.** The cache key omitted negative_prompt, steps and cfg_scale, so
  requests differing only in those fields collided. The key is now a hash of the whole
  normalized request.
- **n greater than 1 produced one image repeated.** Sub-jobs now run concurrently with
  distinct seeds, and a partial failure is reported rather than silently returning fewer
  images than were requested.
- **b64_json could return a url.** The requested format is honoured strictly now.
- **Sizes were silently rewritten.** Reported back as a disclosed adaptation.
- **Every failure was a 502.** Client errors are now 4xx and upstream failures 5xx.
- **Terminal errors were retried.** A 4xx is no longer retried before failing over.
- **A keyless provider advertised as available.** Availability now requires the credential.
- **openclaw SDK clients received 401** because only x-api-key was read, never
  Authorization: Bearer.
- **Readiness failed without Redis**, an optional dependency, so a healthy container was
  marked unhealthy by its own healthcheck.

### Security

- API keys are compared in constant time and hashed before use in rate-limit buckets.
- Production refuses to start without API_KEYS unless ALLOW_UNAUTHENTICATED=true.
- Log redaction for credentials, and truncation of base64 payloads.
