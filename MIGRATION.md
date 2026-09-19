# Migrating from 2.x to 3.x

3.0 changes what RenderMind *is*. In 2.x it proxied requests to native image providers
(openclaw Images, Stability, Replicate) and bridged several protocols on top. In 3.0 it is
an engine that turns a **text-only chat model** into an image generator.

If you pointed a protocol SDK at 2.x, this is a breaking release. There is no compatibility
shim, because the providers and protocols those endpoints translated to no longer exist.

## The new surface

| 2.x endpoint | 3.x replacement |
|---|---|
| `POST /v1/images/generations` | `POST /chat` |
| `POST /api/v1/generate` | `POST /chat` |
| `POST /v1/messages` | `POST /chat` (no Anthropic envelope) |
| `POST /api/v1/batch` | `POST /chat` with `count` |
| `GET /api/v1/status/:id` | — (synchronous only) |
| `GET /api/v1/backends` | — (one provider) |
| `GET /v1/models` | — |

Two endpoints remain:

    POST /chat     { "prompt": "...", "size": "1024x1024", "count": 1 }
    POST /vision   { "prompt": "...", "images": ["data:image/png;base64,..."] }

## Configuration changes

| Before | After |
|---|---|
| `OPENAI_API_KEY` + `OPENAI_BASE_URL` | `CHAT_API_KEY` + `CHAT_BASE_URL` |
| `OPENAI_IMAGE_MODEL` | `CHAT_MODEL` |
| `STABILITY_API_KEY` | — removed |
| `REPLICATE_API_TOKEN` | — removed |
| `CUSTOM_BACKENDS` | — removed |
| `ANTHROPIC_IMAGE_BLOCK_MODE` | — removed |

## Error envelope

One envelope for the whole surface, unchanged in shape from the openclaw envelope:

    {
      "error": {
        "message": "human readable detail",
        "type": "invalid_request_error",
        "param": "size",
        "code": "invalid_request_error"
      }
    }

A new status appears: **422 `unsupported_output`** when the model answered with text and
no image. This is a terminal failure — retrying will not help — and is reported distinctly
rather than as a generic 502.

## Behavioural notes

- **Anthropic clients are no longer supported.** The `/v1/messages` bridge is gone. Point
  the Anthropic SDK elsewhere; this service speaks one HTTP shape now.
- **Input images must be base64 data URIs.** Remote URLs are rejected with a 400 rather
  than fetched.
- **`GET /api/v1/backends` is gone.** With a single provider, the capability descriptor is
  static; see `docs/providers.md`.
- **Generation is synchronous.** The status/batch endpoints were part of the queue design
  that was removed.

## Upgrading checklist

1. Set `CHAT_API_KEY` and `CHAT_BASE_URL`.
2. Repoint clients at `POST /chat` (or `/vision` for image input).
3. Drop any dependency on the removed endpoints or the Anthropic error envelope.
4. Update error handling for the new `422 unsupported_output` case.
