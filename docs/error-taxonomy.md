# Error taxonomy

RenderMind exposes one public surface, so there is exactly one error envelope. A client
that parses a failure once parses it everywhere.

## The envelope

    {
      "error": {
        "message": "human readable detail",
        "type": "invalid_request_error",
        "param": "size",
        "code": "invalid_request_error"
      }
    }

- `message` — human readable, safe to log, never leaks an upstream body verbatim.
- `type` — the class of failure (see below).
- `param` — the offending request field, when there is one; otherwise `null`.
- `code` — a stable machine-readable code, e.g. `unsupported_output`.

## Types

| `type` | Meaning | HTTP statuses |
|---|---|---|
| `invalid_request_error` | The caller's request is wrong | 400, 404 |
| `unsupported_capability` | What is configured cannot serve this request | 400, 422 |
| `rate_limit_error` | Too many requests | 429 |
| `server_error` | The upstream or the service failed | 500, 502, 503, 504 |

## Status decisions

The engine was built to stop one class of bug: collapsing every failure into a generic
error. The mapping is explicit rather than a range check.

| Cause | Status | Code |
|---|---|---|
| Missing/invalid request field | 400 | `invalid_request_error` |
| Unknown endpoint | 404 | `not_found` |
| Model answered with text, no image | 422 | `unsupported_output` |
| Upstream rejected the request (4xx) | 400 | upstream code, if present |
| Upstream rate limited | 429 | `rate_limit_exceeded` |
| Upstream failed (5xx) | 502 | `server_error` |
| Upstream timed out | 504 | `server_error` |
| No provider configured | 503 | `no_provider_configured` |
| All providers tripped | 503 | `all_providers_unavailable` |
| Unexpected error | 500 | `server_error` |

A 4xx from a provider is the caller's mistake and is surfaced as a 4xx. An unreachable
upstream is a 502. Every provider tripped is a transient 503. Conflating these was the
error the engine was built to avoid.

## Rate limiting

A 429 carries `Retry-After` and the envelope above with `code: rate_limit_exceeded`.
Health and readiness probes are never rate limited, so a liveness probe cannot be 429'd
into a restart loop.
