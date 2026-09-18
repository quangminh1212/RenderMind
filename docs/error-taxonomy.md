# Error taxonomy

Each surface speaks its own error envelope. A bridge that returns the native envelope is
unusable by the SDKs it claims to support, so the shape is chosen by path, never by
convenience.

## Native (/api/v1/*)

    {
      "error": "VALIDATION_ERROR",
      "message": "Invalid request body",
      "statusCode": 400,
      "requestId": "req_...",
      "details": [{ "field": "prompt", "message": "Required" }]
    }

`error` is a stable machine-readable code. Codes in use: `INVALID_REQUEST_ERROR`,
`NOT_FOUND`, `RATE_LIMITED`, `UNSUPPORTED_CAPABILITY`, `NO_PROVIDER_CONFIGURED`,
`ALL_PROVIDERS_UNAVAILABLE`, `INTERNAL_ERROR`.

## openclaw (/v1/images/*, /v1/models)

    {
      "error": {
        "message": "human readable detail",
        "type": "invalid_request_error",
        "param": "size",
        "code": "invalid_request_error"
      }
    }

`type` is one of `invalid_request_error`, `authentication_error`, `permission_error`,
`not_found_error`, `rate_limit_error`, `server_error`.

## Anthropic (/v1/messages)

    {
      "type": "error",
      "error": { "type": "invalid_request_error", "message": "..." },
      "request_id": "req_..."
    }

The full type set, including `billing_error` (402), `conflict_error` (409),
`timeout_error` (504) and `overloaded_error` (529), is documented in
docs/protocols/anthropic-messages.md.

## Status decision table

| Condition | Status | Rationale |
|---|---|---|
| Request failed validation | 400 | The caller can fix it. |
| Unknown or unconfigured provider | 400 | A typo in the provider field is not an outage. |
| Capability gap | 400 | Nothing configured can serve what was asked. |
| Panel of providers cannot honour a feature | 400 | Same as above. |
| Missing or invalid API key | 401 | Anthropic and openclaw both use 401 here. |
| Rate limited | 429 | With Retry-After. |
| Requested response_format undeliverable | 502 | The provider failed us, not the caller. |
| Upstream rejected the request | 400 | The upstream's own 4xx is passed through. |
| Upstream server error | 502 | |
| Upstream timeout | 504 | |
| Every provider tripped | 503 (529 for Anthropic) | Transient. Includes Retry-After. |
| Nothing configured | 500 | A deployment problem. |

## Why 400 and 502 must not be conflated

The previous implementation returned every failure as 502 `server_error`. A typo in the
`backend` field therefore looked exactly like a provider outage, and an operator would
debug the wrong layer. The rule now: if the caller could have avoided it, it is a 4xx; if
the upstream let us down, it is a 5xx.

## Retryability

The engine retries only `408`, `425`, `429`, `500`, `502`, `503`, `504`, `529` and
transport failures. Everything else is terminal and fails over to the next provider
immediately.

`ProviderError.isRetryableStatus` is the single source of that decision, so a new provider
cannot accidentally introduce a different policy.
