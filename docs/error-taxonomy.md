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
| Model returned SVG that failed validation | 422 | `unsupported_output` |
| Upstream rejected the request (4xx) | 400 | upstream code, if present |
| Upstream rate limited | 429 | `rate_limit_exceeded` |
| Upstream failed (5xx) | 502 | `server_error` |
| Upstream timed out | 504 | `server_error` |
| No provider configured | 503 | `no_provider_configured` |
| No provider permitted by `PROVIDER_STRATEGY` | 503 | `no_provider_configured` |
| `format: 'svg'` under `PROVIDER_STRATEGY=native` | 400 | `unsupported_capability` |
| `/vision` under `PROVIDER_STRATEGY=native` | 400 | `unsupported_capability` |
| Native endpoint returned no image data | 422 | `unsupported_output` |
| Native endpoint returned a non-JSON success body | 422 | `unsupported_output` |
| All providers tripped | 503 | `all_providers_unavailable` |
| Blocked SSRF URL | 502 | `artifact_fetch_blocked` |
| Image too large | 502 | `artifact_too_large` |
| Image missing payload | 502 | `artifact_missing_payload` |
| Unexpected error | 500 | `server_error` |

### SVG refusals

A model-authored SVG that fails validation is reported as `422 unsupported_output`, the same
verdict a prose reply gets — to a caller the two are one fact: the upstream produced no
usable image. The `message` names the specific defect, so an operator can tell an unsafe
model from a merely inept one:

| Defect | Reason in the message |
|---|---|
| Payload is not decodable base64 | `svg_not_decodable` |
| Bytes are a raster, not a vector | `svg_wrong_type` |
| Over the payload byte limit | `svg_too_large` |
| Not well-formed, or truncated | `svg_malformed` |
| Root element is not `<svg>` | `svg_wrong_root` |
| Missing the SVG namespace | `svg_missing_namespace` |
| `<script>`, `<foreignObject>`, `<iframe>` | `svg_unsafe_element` |
| An `on*=` event handler | `svg_unsafe_attribute` |
| DOCTYPE or entity declaration | `svg_unsafe_doctype` |
| External or `data:` reference | `svg_unsafe_reference` |
| No drawable geometry | `svg_no_geometry` |
| Validated but could not be drawn | `svg_rasterize_failed` |

All of these are **terminal**: `retryable` is `false`, so the engine fails over or reports
rather than burning upstream quota to confirm a known answer.

A 4xx from a provider is the caller's mistake and is surfaced as a 4xx. An unreachable
upstream is a 502. Every provider tripped is a transient 503. Conflating these was the
error the engine was built to avoid.

### Native endpoint failures

The images endpoint produces no new error *shapes* — a failure is still a `ProviderError`
carrying the upstream status, code and `Retry-After` — but two cases are worth naming because
they are the ones a caller is most likely to meet:

- **A success body with no image data.** HTTP 200 and `{"data": []}`, or records carrying
  neither `b64_json` nor `url`. Reported as `422 unsupported_output`, never as an empty
  success: a caller who asked for one image and received none has not been served.
- **A success body that is not JSON.** Reported the same way, terminally, rather than being
  retried — the same bytes will fail the same way.

A `no_provider_configured` 503 now also covers a deployment whose only available provider is
forbidden by `PROVIDER_STRATEGY`. That is deliberate: readiness and generation answer the
same question ("who will this deployment actually route to?"), so `/readyz` cannot report
ready while every request would fail.

## Rate limiting

A 429 carries `Retry-After` and the envelope above with `code: rate_limit_exceeded`.
Health and readiness probes are never rate limited, so a liveness probe cannot be 429'd
into a restart loop.
