# openclaw Images API bridge

RenderMind implements the openclaw Images API surface, so any client or SDK that speaks
it can point at RenderMind and have the request routed to whatever image provider is
configured.

This document states exactly what is implemented, what is not, and where behaviour
deliberately differs.

## Naming

This project calls the provider it proxies `openclaw`, because it speaks the same
protocol that openclaw's image API exposes. The environment variables are `OPENAI_*`.
The name refers to the protocol, not to a specific vendor: the same provider is used for
api.openai.com, Azure openclaw, LM Studio, LocalAI, or a self-hosted image service. See
docs/providers.md.

## Endpoints

| Method | Path | Status |
|---|---|---|
| POST | /v1/images/generations | Implemented |
| GET | /v1/models | Implemented |
| POST | /v1/images/edits | Not implemented |
| POST | /v1/images/variations | Not implemented |

A request to an unimplemented path returns the standard protocol error envelope with a 404
`not_found_error`, never the native shape, so a client fails predictably.

## POST /v1/images/generations

### Accepted fields

| Field | Type | Notes |
|---|---|---|
| prompt | string | Required, 1 to 32000 characters. |
| model | string | Optional. Routes through capability matching. |
| size | string | WIDTHxHEIGHT, e.g. 1024x1024. Strictly validated. |
| width / height | integer | 64 to 4096. Alternative to size. |
| n | integer | 1 to 10. Dispatched concurrently, with distinct seeds. |
| response_format | string | b64_json (default) or url. Honoured strictly. |
| quality | string | standard, hd, high, medium, low, draft, auto. |
| style | string | Forwarded when the provider supports it. |
| output_format | string | png, jpeg, webp. |
| negative_prompt | string | RenderMind extension, forwarded where supported. |
| seed | integer | RenderMind extension. |
| user | string | Recorded for abuse tracing. |

RenderMind extensions beyond the openclaw surface: backend, steps, cfg_scale,
webhook_url, aspect_ratio.

### Response

    {
      "created": 1700000000,
      "data": [{ "b64_json": "..." }]
    }

created is a single timestamp for the whole response, not one per image.

The non-standard _rendermind metadata object is omitted by default, because strict
response-schema validators reject unknown fields. Enable it with
OPENAI_RESPONSE_METADATA=true.

### Guarantees

- **n images, or an error.** A partial failure is never reported as success. Each of the
  n sub-jobs must succeed for a 200, and the response always contains exactly n items.
- **b64_json never degrades to url.** If the provider returns only a URL, RenderMind
  fetches and inlines it as base64. If that is impossible the request fails with 502,
  rather than returning a response of the wrong shape. A caller doing
  Buffer.from(data[0].b64_json, 'base64') must never receive undefined.
- **No silent size substitution.** A size the selected provider cannot produce is
  replaced by the nearest supported one, and the substitution is reported in the
  response metadata (see OPENAI_RESPONSE_METADATA).
- **Distinct images for n > 1.** When the caller does not pin a seed, each sub-job
  receives a distinct seed, so n images are n different images.

### Model-specific constraints

- dall-e-3 accepts only n: 1. Requesting n > 1 with that model returns 400 with
  param: "n". It accepts only three discrete sizes: 1024x1024, 1024x1792, 1792x1024.
- dall-e-2 and gpt-image-1 accept n > 1.
- Unknown models on a compatible endpoint are assumed to accept arbitrary sizes in
  multiples of 8, rather than being constrained to DALL-E's buckets.

## Error responses

All errors use the protocol envelope:

    {
      "error": {
        "message": "human readable detail",
        "type": "invalid_request_error",
        "param": "size",
        "code": "invalid_request_error"
      }
    }

type is one of: invalid_request_error, authentication_error, permission_error,
not_found_error, rate_limit_error, server_error.

param names the offending field when the failure is attributable to one.

### Status mapping

| Condition | Status | type |
|---|---|---|
| Validation failure | 400 | invalid_request_error |
| Unknown or unconfigured provider | 400 | invalid_request_error |
| Capability gap (nothing configured can serve it) | 400 | invalid_request_error |
| Missing or invalid API key | 401 | authentication_error |
| Requested response_format undeliverable | 502 | server_error |
| Upstream rejected the request | 400 | invalid_request_error |
| Upstream rate limited | 429 | rate_limit_error |
| Upstream server error | 502 | server_error |
| All providers tripped (circuit breakers open) | 503 | server_error |
| No provider configured at all | 500 | server_error |

The distinction between 400 and 502 matters. An unconfigured provider is the caller's
problem to fix; an exhausted upstream is not. The previous implementation collapsed both
into 502 server_error, so a typo in the backend field was indistinguishable from an
outage.

## Authentication

Accepted on the wire in any of these forms:

    x-api-key: <key>
    Authorization: Bearer <key>
    <API_KEY_HEADER>: <key>

Comparison is constant-time. An invalid key returns 401, not 403.

## GET /v1/models

Returns discoverable models in the standard shape:

    {
      "object": "list",
      "data": [
        { "id": "dall-e-3", "object": "model", "created": 0, "owned_by": "openclaw" }
      ]
    }

This endpoint exists because LiteLLM, Open WebUI and Continue probe it for discovery. In
its absence those clients received the native 404 body and enumerated nothing.

## Known divergences

- /v1/images/edits and /v1/images/variations are not implemented. They return a 404 in
  the protocol envelope rather than silently degrading, so a client can detect the gap.
- /v1/images/generations accepts RenderMind extension fields (backend, steps, cfg_scale,
  webhook_url, aspect_ratio) that the real API ignores. They are ignored by clients that
  do not send them.
- A base64 payload from a URL-only provider is fetched at request time and is not stored,
  so `response_format: url` for such a provider returns a data URI rather than a hosted
  URL. Operating a real artifact store is future work.

## Client configuration

Point any openclaw-compatible client at the RenderMind base URL:

    openai = Openclaw(base_url="http://localhost:3000/v1", api_key="<your RenderMind key>")
    image = openclaw.images.generate(prompt="a red apple", size="1024x1024")
