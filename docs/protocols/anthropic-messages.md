# Anthropic Messages API bridge

RenderMind accepts Anthropic Messages API requests and returns a generated image. This
lets a Claude client or coding agent use RenderMind as if it were the Messages API.

The wire-format reference this implementation follows is
`docs/anthropic-messages-api-reference.md`, which is source-cited against the official
docs and the `@anthropic-ai/sdk` v0.127.0 type definitions.

## The central constraint

**Claude cannot emit images, and the Anthropic response ContentBlock union has no `image`
member.** That union is:

    TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock
    | ServerToolUseBlock | WebSearchToolResultBlock | WebFetchToolResultBlock
    | CodeExecutionToolResultBlock | BashCodeExecutionToolResultBlock
    | TextEditorCodeExecutionToolResultBlock | ToolSearchToolResultBlock
    | ContainerUploadBlock

`image` exists only on the request side. A proxy that returns an assistant image block is
not Anthropic-compatible, and a client validating that union will reject it.

That is why the previous implementation's response was wrong, and why the default here is
a `tool_use` block instead.

## POST /v1/messages

### Request

| Field | Required | Notes |
|---|---|---|
| model | Yes | Anthropic requires it. Omitting it is a 400. |
| messages | Yes | At least one message. role must be user or assistant. |
| max_tokens | Yes | Anthropic requires it. Accepting a request without it taught callers a contract that is not honoured. |
| system | No | Folded into the prompt when the final user turn carries no text. |
| stream | No | If true, a real SSE stream is returned. |
| tools | No | The generate_image tool may be declared here. |
| temperature, top_p, top_k, metadata | No | Accepted and ignored; generation has no sampling knobs. |

`stream: true` used to be accepted, logged, and then answered with a plain JSON body.
Every Anthropic SDK requests streaming by default, so clients received a body they never
asked for and could not parse. It now produces a real event stream.

### Prompt extraction

- The **last** user turn supplies the prompt. Earlier turns are ignored, because an image
  request is a single instruction rather than a conversation.
- If the final user turn contains no text, the `system` field is used instead. A
  system-only request is valid on the real API and must not become a 400.
- A leading directive such as `/imagine` or `/draw` is stripped.
- A prompt that is only a directive, or only whitespace, is a 400. It is never sent
  upstream.
- Non-text blocks (tool_result, image, document) are not silently discarded. If a request
  contains only those and no usable text, the 400 explains which block types were present.

### Response (default: tool_use)

    {
      "id": "msg_...",
      "type": "message",
      "role": "assistant",
      "model": "claude-3-5-sonnet",
      "content": [
        { "type": "text", "text": "Generated 1 image for: a red apple" },
        {
          "type": "tool_use",
          "id": "toolu_...",
          "name": "generate_image",
          "input": {
            "prompt": "a red apple",
            "image_count": 1,
            "images": [{ "index": 0, "url": "https://...", "mime": "image/png" }],
            "provider": "stability",
            "model": "stable-diffusion-xl-1024-v1-0"
          }
        }
      ],
      "stop_reason": "tool_use",
      "stop_sequence": null,
      "usage": { "input_tokens": 12, "output_tokens": 48 }
    }

Every content block here is a member of the real response union, so a strict client
validates it successfully.

The generate_image tool contract is discoverable via GET /v1/messages/tools, so a client
can declare it in tools[].

### Response (extension: image block)

Set ANTHROPIC_IMAGE_BLOCK_MODE=extension to receive the image itself as a base64 content
block instead:

    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }

This is not part of the Anthropic response contract. It exists for custom clients that opt
in. A strict SDK type check will reject it, which is why it is off by default.

### Usage

input_tokens and output_tokens are estimates derived from character counts at roughly four
characters per token. They are not metered values, and they are not billing data. The
previous implementation reported a hardcoded `{ input_tokens: 0, output_tokens: 1 }`,
which billing and telemetry clients read literally.

## Streaming

When `stream: true`, the response is a real event stream:

    event: message_start
    data: {"type":"message_start","message":{"id":"msg_...","content":[],"stop_reason":null,...}}

    event: content_block_start
    data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

    event: content_block_delta
    data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}

    event: content_block_stop
    data: {"type":"content_block_stop","index":0}

    event: message_delta
    data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":48}}

    event: message_stop
    data: {"type":"message_stop"}

Implemented rules:

- Event names are named events, and the `event:` name always matches `data.type`.
- `message_start` carries a full message with `content: []` and `stop_reason: null`.
- `message_delta.usage` is **cumulative** output tokens, per the specification.
- `data: [DONE]` is **never** emitted. That is an openclaw convention, not Anthropic's.
- Numeric `index` values map to each block's position in the final `content` array.
- An `input_json_delta` carries a partial JSON string, accumulated by the client and
  parsed at `content_block_stop`.

Generation is not incremental, so the image is produced before the stream opens. The
client still receives a well-formed event sequence. If generation fails before any bytes
are written, the response is a normal error; if it fails afterwards, the stream ends.

## Errors

    {
      "type": "error",
      "error": { "type": "invalid_request_error", "message": "..." },
      "request_id": "req_..."
    }

`request-id` is sent as a response header on every response, and mirrored as a top-level
`request_id` in error bodies. In-stream error events carry no request_id, per the spec.

### Full taxonomy

| Status | error.type |
|---|---|
| 400 | invalid_request_error |
| 401 | authentication_error |
| 402 | billing_error |
| 403 | permission_error |
| 404 | not_found_error |
| 409 | conflict_error |
| 413 | request_too_large |
| 429 | rate_limit_error |
| 504 | timeout_error |
| 529 | overloaded_error |
| other 5xx | api_error |

An invalid API key returns **401**, not 403. Anthropic has no 403 for that case.

**529 is Anthropic-specific and is not a standard HTTP status.** It is used when every
provider is tripped by a circuit breaker. The previous implementation collapsed every
status at or above 500 into api_error and had no way to express 529 at all.

## Other endpoints

| Method | Path | Behaviour |
|---|---|---|
| POST | /v1/messages/count_tokens | Available. Returns an estimated input_tokens. Claude Code calls this. |
| GET | /v1/messages/tools | Returns the generate_image tool declaration. |

count_tokens is an estimate, not a real tokenizer, but it satisfies clients that only need
a number to decide whether a request fits.

## Authentication and version headers

    x-api-key: <key>
    Authorization: Bearer <key>
    anthropic-version: 2023-06-01

x-api-key is Anthropic's own header; Bearer is accepted as an alias. anthropic-version and
anthropic-beta are permitted by CORS so cross-origin browser clients complete preflight.

## Known divergences

| Area | Divergence |
|---|---|
| Image delivery | Returns a tool_use block by default because the response union has no image member. Set ANTHROPIC_IMAGE_BLOCK_MODE=extension for an image block. |
| Streaming | Events are emitted after generation completes, not during, because image generation is not incremental. |
| usage | input_tokens and output_tokens are character-based estimates, not metered values. |
| Sampling | temperature, top_p and top_k are accepted and ignored. |
| system | Used as a fallback prompt when the final user turn carries no text. |
| Multi-image | One image per response. Use the native /api/v1/generate endpoint for n > 1. |

## Client configuration

Point any Anthropic client at the RenderMind base URL:

    from anthropic import Anthropic

    client = Anthropic(base_url="http://localhost:3000", api_key="<your RenderMind key>")

    message = client.messages.create(
        model="claude-3-5-sonnet",
        max_tokens=1024,
        messages=[{"role": "user", "content": "Generate an image of a lake at dawn"}],
    )

    # Streaming
    with client.messages.stream(model="claude-3-5-sonnet", max_tokens=1024, messages=[...]) as s:
        for event in s:
            print(event.type)
