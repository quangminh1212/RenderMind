# Changelog

All notable changes are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0]

A ground-up rebuild of the request path, plus the correctness and protocol fixes found by
an audit of 1.0.0. This is a major release because several client-visible behaviours
changed deliberately.

### Added

- Canonical generation model: caller intent, independent of any vendor or protocol.
- Capability negotiation: providers declare what they can do, and the engine decides
  before dispatching. Pure and synchronous, so every negotiation is unit-testable.
- Plan-driven dispatch with bounded concurrency, per-provider circuit breakers and
  explicit failover.
- `GET /v1/models`, for clients that probe it for discovery.
- `POST /v1/messages/count_tokens`, which Claude Code calls.
- Real SSE streaming on `/v1/messages`.
- Prometheus `/metrics`.
- Split liveness (`/healthz`) and readiness (`/readyz`).
- Structured logging with request-id correlation and secret redaction.
- Configuration validated at boot, reporting every invalid variable at once.
- Custom HTTP providers, now wired from `CUSTOM_BACKENDS`.
- Documentation set under `docs/`, plus `SECURITY.md`.

### Fixed

- **Cache collisions.** The cache key omitted negative_prompt, steps and cfg_scale, so
  requests differing only in those fields collided and the second caller received the
  first caller's image. The key is now a hash of the whole normalized request.
- **n greater than 1 produced one image repeated.** Sub-jobs now run concurrently with
  distinct seeds, and a partial failure is reported rather than silently returning fewer
  images than were requested.
- **b64_json could return a url.** The requested format is honoured strictly now, with
  provider URLs inlined when base64 is required.
- **Sizes were silently rewritten.** DALL-E 3's discrete sizes forced a substitution the
  caller could not see. It is now computed from declared capabilities and reported back.
- **Every failure was a 502.** Client errors are now 4xx and upstream failures 5xx, so a
  typo in the provider field no longer looks like an outage.
- **Terminal errors were retried.** A 4xx is no longer retried before failing over.
- **A keyless provider advertised as available**, was auto-selected, then failed upstream
  with a 401. Availability now requires the credential.
- **Anthropic bridge violations:** stream was accepted then silently ignored; max_tokens
  was optional though the real API requires it; the response used an image block that is
  not a member of the response union; errors used the wrong envelope; a bad key returned
  403 instead of 401; usage was hardcoded to zeros.
- **openclaw bridge violations:** errors used the native envelope; quality and style were
  validated then dropped; size was parsed leniently.
- **openclaw SDK clients received 401** because only x-api-key was read, never
  Authorization: Bearer.
- **Readiness failed without Redis**, an optional dependency, so a healthy container was
  marked unhealthy by its own healthcheck.
- **Per-key rate limiting silently degraded to per-IP** because the limiter was mounted
  before the middleware that set its key.
- **Status lookups 404'd for ids the server had just issued** when Redis was absent.
- **Batch status could not express partial success**, reporting a 19-of-20 success as a
  total failure.
- **Webhook failures were silently discarded**, with no retry and no delivery record.
- **Deep health checks reported a hardcoded version** because npm_package_version is
  unset when running the compiled output.

### Changed (breaking)

- POST /v1/messages now requires model and max_tokens, per the Anthropic specification.
- POST /v1/messages returns a tool_use block by default instead of an image block. Set
  ANTHROPIC_IMAGE_BLOCK_MODE=extension to restore the previous behaviour.
- The _rendermind metadata object is omitted from openclaw responses by default. Set
  OPENAI_RESPONSE_METADATA=true to include it.
- Cache keys changed format. Old entries are not read, so the first request after
  upgrading is a cache miss. This is intentional: entries written under the old scheme may
  be poisoned by the collision bug.
- /health now reports liveness semantics and returns 200 even when optional dependencies
  are down. Use /readyz for readiness.
- An invalid API key returns 401 rather than 403, matching Anthropic.

### Removed

- The dead config/backends.ts module, which had no importers.
- The unused BullMQ queue service. It was constructed at startup and never consumed a job,
  while /health gated readiness on it.
- src/services/backends/*, replaced by src/providers/*.

### Security

- API keys are compared in constant time and hashed before use in rate-limit buckets.
- Production refuses to start without API_KEYS unless ALLOW_UNAUTHENTICATED=true.
- Log redaction for credentials, and truncation of base64 payloads.
- Dependency audit is clean; the dev toolchain moved to vitest 5 to clear five advisories.

### Testing

- 39 tests to 201, including contract tests that drive the real openclaw and Anthropic
  SDKs against the bridges, and 82 provider tests covering wire payloads and error
  classification.
