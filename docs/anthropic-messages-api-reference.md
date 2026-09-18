# Anthropic Claude Messages API — Drop-in Proxy Reference

**Compiled:** 2026-09-18
**Primary sources (authoritative):**
- Error taxonomy, request-id, size limits: `https://platform.claude.com/docs/en/api/errors`
- Rate limit headers: `https://platform.claude.com/docs/en/api/rate-limits`
- Streaming SSE events: `https://platform.claude.com/docs/en/build-with-claude/streaming`
- Vision / image blocks: `https://platform.claude.com/docs/en/build-with-claude/vision`
- PDF / document blocks: `https://platform.claude.com/docs/en/build-with-claude/pdf-support`
- Versioning: `https://platform.claude.com/docs/en/api/versioning`
- Machine-readable schema: `anthropic-sdk-typescript` `src/resources/messages/messages.ts`, `src/resources/shared.ts`, `src/client.ts` (SDK v0.127.0)

**Source-access note:** `docs.anthropic.com/*` now 301-redirects to `platform.claude.com/docs/*`. The API-reference HTML pages (`/en/api/messages`, `/en/api/messages/create`) are **server-truncated before their Response section**, so response-shape facts below are quoted from the generated SDK type definitions instead of the HTML page. Every such substitution is marked `[FROM SDK TYPES]`.

---

## 1. `POST /v1/messages` — request schema

**Required fields: exactly three — `model`, `messages`, `max_tokens`.** `max_tokens` IS required.

`[FROM SDK TYPES]` — the interface declares these three without `?`:

```ts
export interface MessageCreateParamsBase {
  max_tokens: number;              // required
  messages: Array<MessageParam>;   // required
  model: Model;                    // required
  cache_control?: CacheControlEphemeral | null;
  container?: MessageCreateParamsContainer | null;
  inference_geo?: string | null;
  metadata?: Metadata;
  output_config?: OutputConfig;
  service_tier?: 'auto' | 'standard_only';
  stop_sequences?: Array<string>;
  stream?: boolean;
  system?: string | Array<TextBlockParam>;
  temperature?: number;
  thinking?: ThinkingConfigParam;
  tool_choice?: ToolChoice;
  tools?: Array<ToolUnion>;
  top_k?: number;
  top_p?: number;
  user_profile_id?: string;
  workspace_id?: string;
}
```

### Field-by-field

| Field | Type | Req? | Default | Constraints |
|---|---|---|---|---|
| `model` | string (enum of IDs, or arbitrary string) | **YES** | — | e.g. `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-opus-4-5`, `claude-sonnet-4-5` |
| `messages` | array of `MessageParam` | **YES** | — | **max 100,000 messages** per request |
| `max_tokens` | number | **YES** | — | `minimum: 0`. **No documented global maximum** — "Different models have different maximum values." `0` = populate prompt cache without generating a response. |
| `system` | string **or** array of `TextBlockParam` | no | — | Array form: each block `{type:"text", text, cache_control?, citations?}` |
| `temperature` | number | no | `1.0` | Range `0.0`–`1.0`. **Deprecated** — models after Claude Opus 4.6 reject non-`1.0` with 400. |
| `top_p` | number | no | — | **Deprecated** — models after Opus 4.6: only `>= 0.99` accepted, else 400. `[FROM SDK TYPES]` |
| `top_k` | number | no | — | **Deprecated** — models after Opus 4.6 reject **any** value with 400. `[FROM SDK TYPES]` |
| `stop_sequences` | array of string | no | — | Match ⇒ `stop_reason: "stop_sequence"`, matched value in `stop_sequence` |
| `stream` | boolean | no | `false` | Enables SSE |
| `metadata` | object | no | — | Only field is `user_id?: string \| null`, **`maxLength: 512`**. Opaque uuid/hash; no PII. |
| `tools` | array of `ToolUnion` (client + server tools) | no | — | Client tool `name`: `maxLength: 128, minLength: 1, pattern: ^[a-zA-Z0-9_-]{1,128}$` |
| `tool_choice` | `ToolChoice` | no | `{"type":"auto"}` | See below |
| `service_tier` | `'auto' \| 'standard_only'` | no | — | `[FROM SDK TYPES]` |
| `inference_geo` | string \| null | no | workspace default | `[FROM SDK TYPES]` |
| `cache_control` | `{type:"ephemeral", ttl?:"5m"\|"1h"}` | no | `ttl` = `5m` | Top-level; marks last cacheable block. `[FROM SDK TYPES]` |
| `thinking` | `ThinkingConfigParam` | no | — | `enabled` requires `budget_tokens` **min 1024** and `< max_tokens`; also `disabled`, `adaptive` |

### `messages` — `MessageParam`

```json
{ "role": "user", "content": "Hello, Claude" }
{ "role": "assistant", "content": [ { "type": "text", "text": "Hi!" } ] }
```

- `role`: **`"user"` or `"assistant"`** (the docs HTML lists `"system"` in a type union, but **there is no `system` role for input messages** — use the top-level `system` parameter).
- `content`: a single `string` **or** an array of `ContentBlockParam`.
- Consecutive same-role turns are combined by the API.
- A trailing `assistant` message is a *prefill*; **Claude 4.6+ and Mythos Preview reject prefill** with 400 `invalid_request_error`: `"This model does not support assistant message prefill. The conversation must end with a user message."`

### `tool_choice` variants

```json
{ "type": "auto", "disable_parallel_tool_use": false }
{ "type": "any",  "disable_parallel_tool_use": false }
{ "type": "tool", "name": "get_weather", "disable_parallel_tool_use": false }
{ "type": "none" }
```

- `disable_parallel_tool_use` defaults `false`.
- For `"any"`/`"tool"`: if `true`, **exactly one** tool use is output. For `"auto"`: if `true`, **at most one**.

### Request size limits

| Endpoint | Max request size |
|---|---|
| Messages API | **32 MB** |
| Token Counting API | 32 MB |
| Batch API | 256 MB |
| Files API | 500 MB |

Exceeding ⇒ HTTP **413 `request_too_large`** (on the direct API, Cloudflare returns this before it reaches Anthropic).

---

## 2. Message content block types

### 2.1 `text`

```json
{ "type": "text", "text": "Hello, Claude" }
```
Request `TextBlockParam`: `text` (**minLength: 1**), optional `cache_control`, optional `citations`.
`[FROM SDK TYPES]` Response `TextBlock` adds **`citations: Array<TextCitation> | null`**.

### 2.2 `image`

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/jpeg",
    "data": "<base64 string>"
  }
}
```

**Three source variants** `[FROM SDK TYPES]`:

```ts
export interface Base64ImageSource {
  data: string;
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  type: 'base64';
}
export interface URLImageSource { type: 'url'; url: string; }
export interface FileImageSource { file_id: string; type: 'file'; }
```

```json
{ "type": "image", "source": { "type": "url",  "url": "https://example.com/a.jpg" } }
{ "type": "image", "source": { "type": "file", "file_id": "file_011CN..." } }
```

`ImageBlockParam` also accepts optional `cache_control` and optional `transformations` (`[FROM SDK TYPES]`).

### 2.3 `tool_use`

```json
{
  "type": "tool_use",
  "id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
  "name": "get_stock_price",
  "input": { "ticker": "^GSPC" }
}
```

- Request `ToolUseBlockParam` `[FROM SDK TYPES]`: `id` (`pattern: ^[a-zA-Z0-9_-]+$`), `name` (**maxLength: 200, minLength: 1**), `input: map[unknown]`, optional `cache_control`, `caller`, `toolset_name`.
- Response `ToolUseBlock` `[FROM SDK TYPES]`: `id`, `name`, `input: unknown`, `type: "tool_use"`, **required** `caller`, optional `toolset_name`.
- `id` prefix in practice: `toolu_...`.

### 2.4 `tool_result`

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
  "content": "259.75 USD"
}
```

`[FROM SDK TYPES]` `ToolResultBlockParam`:

- `tool_use_id: string` (`pattern: ^[a-zA-Z0-9_-]+$`) — **required**
- `content?`: `string` **or** array of `TextBlockParam | ImageBlockParam | SearchResultBlockParam | DocumentBlockParam | ToolReferenceBlockParam | BrowserStateBlockParam`
- `is_error?: boolean`
- `cache_control?`, `toolset_name?`

> Note: `image` blocks nested inside `tool_result.content` **count toward** the many-image request threshold.

### 2.5 `document`

```json
{
  "type": "document",
  "source": {
    "type": "url",
    "url": "https://assets.anthropic.com/m/1cd9d098ac3e6467/original/Claude-3-Model-Card-October-Addendum.pdf"
  }
}
```

`DocumentBlockParam` `[FROM SDK TYPES]`:

```ts
export interface DocumentBlockParam {
  source: Base64PDFSource | PlainTextSource | ContentBlockSource
        | URLPDFSource | FileDocumentSource;
  type: 'document';
  cache_control?: CacheControlEphemeral | null;
  citations?: CitationsConfigParam | null;
  context?: string | null;
  title?: string | null;
}
```

The five source variants `[FROM SDK TYPES]`:

```ts
export interface Base64PDFSource   { data: string; media_type: 'application/pdf'; type: 'base64'; }
export interface PlainTextSource   { data: string; media_type: 'text/plain';      type: 'text';   }
export interface URLPDFSource      { type: 'url';    url: string; }
export interface FileDocumentSource{ type: 'file';   file_id: string; }
export interface ContentBlockSource{
  content: string | Array<ContentBlockSourceContent>;
  type: 'content';
}
```

PDF limits: **32 MB request**, **600 pages** per request (**100** when context window < 1M tokens), standard non-encrypted PDFs only.

### Other request block types
`search_result`, `thinking`, `redacted_thinking`, `server_tool_use`, `web_search_tool_result`, `web_fetch_tool_result`, `code_execution_tool_result`, `bash_code_execution_tool_result`, `text_editor_code_execution_tool_result`, `tool_search_tool_result`, `container_upload`.

### Response `ContentBlock` union `[FROM SDK TYPES]`

```ts
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | WebFetchToolResultBlock
  | CodeExecutionToolResultBlock
  | BashCodeExecutionToolResultBlock
  | TextEditorCodeExecutionToolResultBlock
  | ToolSearchToolResultBlock
  | ContainerUploadBlock;
```

**There is NO `image` member in the response `ContentBlock` union** — see item 8.

---

## 3. Success response shape

`[FROM SDK TYPES]`

```ts
export interface Message {
  id: string;                    // "msg_..."
  type: 'message';
  role: 'assistant';
  model: Model;
  content: Array<ContentBlock>;
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  usage: Usage;
  stop_details: RefusalStopDetails | null;
  container: Container | null;   // (present in Message; omitted here for brevity)
}
```

### `stop_reason` — complete enum `[FROM SDK TYPES]`

```ts
export type StopReason =
  | 'end_turn'                        // natural stopping point
  | 'max_tokens'                      // exceeded max_tokens or model max
  | 'stop_sequence'                   // a custom stop_sequence was generated
  | 'tool_use'                        // model invoked one or more tools
  | 'pause_turn'                      // long-running turn paused; resend to continue
  | 'refusal'                         // streaming classifier intervened
  | 'model_context_window_exceeded';  // exceeded the model's context window
```

> Docs language: "In non-streaming mode this value is always non-null. In streaming mode, it is **null in the `message_start` event** and non-null otherwise."
> The versioning policy allows **new enum values to be added** — handle unknown values gracefully.

### `usage` `[FROM SDK TYPES]`

```ts
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation: CacheCreation | null;
  inference_geo: string | null;
  output_tokens_details: OutputTokensDetails | null;
  server_tool_use: ServerToolUsage | null;
  service_tier: 'standard' | 'priority' | 'batch' | null;
}

export interface CacheCreation {
  ephemeral_1h_input_tokens: number;
  ephemeral_5m_input_tokens: number;
}
```

**Critical semantics for a proxy:** `input_tokens` counts **only tokens after the last cache breakpoint**. Total input is:

```
total_input_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

`output_tokens` is **non-zero even for an empty-string response**.

### Example non-streaming response

```json
{
  "id": "msg_013Zva2CMHLNnXjNJJKqJ2EF",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-5",
  "content": [{ "type": "text", "text": "Hi! My name is Claude.", "citations": null }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 2095,
    "output_tokens": 503,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "service_tier": "standard"
  }
}
```

---

## 4. Error response shape

Every error is JSON with a top-level `error` object containing **`type`** and **`message`**, plus a top-level **`request_id`**:

```json
{
  "type": "error",
  "error": {
    "type": "not_found_error",
    "message": "The requested resource could not be found."
  },
  "request_id": "req_011CSHoEeqs5C35K2UUqR7Fy"
}
```

### Complete error taxonomy (verified against the errors doc)

| HTTP | `error.type` | Meaning |
|---|---|---|
| **400** | `invalid_request_error` | Format/content issue. Also used for **other 4XX not listed**. Also returned when a **user-set spend limit** is hit. |
| **401** | `authentication_error` | API key malformed, revoked, or expired. |
| **402** | `billing_error` | Billing/payment issue. |
| **403** | `permission_error` | Key lacks permission for the resource. |
| **404** | `not_found_error` | Resource not found — check path and IDs. |
| **409** | `conflict_error` | Request conflicts with resource state (concurrent modification / unique constraint). |
| **413** | `request_too_large` | Exceeds max request bytes. |
| **429** | `rate_limit_error` | Rate limit, tier spend cap, or Claude Code workspace spend limit. |
| **500** | `api_error` | Unexpected internal error. Retry w/ exponential backoff. |
| **504** | `timeout_error` | Timed out while processing. Use streaming for long requests. |
| **529** | `overloaded_error` | API temporarily overloaded. |

> 529 is **Anthropic-specific** and not a standard HTTP status.

**Beyond the eight you listed, the real API also returns `billing_error` (402), `conflict_error` (409), and `timeout_error` (504).**

The SDK's `ErrorType` union `[FROM SDK TYPES]` — note it is a *subset* of the above, and omits `request_too_large` / `conflict_error`:

```ts
export type ErrorType =
  | 'invalid_request_error' | 'authentication_error' | 'permission_error'
  | 'not_found_error'       | 'rate_limit_error'     | 'timeout_error'
  | 'overloaded_error'      | 'api_error'            | 'billing_error';
```

The docs state plainly: **"the values within these objects may expand, and it is possible that the `type` values will grow over time."**

### Spend-cap 429 has a distinguishing marker

```json
{
  "type": "error",
  "error": {
    "type": "rate_limit_error",
    "message": "You have reached your API usage limits: ... You will regain access on 2026-09-01 at 00:00 UTC.",
    "details": { "error_code": "enforced_spend_limit_reached" }
  },
  "request_id": "req_018EeWyXxfu5pfWkrYcMdjWG"
}
```
A spend-cap 429 has **no `retry-after` header** and keeps failing until access resumes.

### Request ID — YES, there are headers

- **Every** API response includes a **`request-id`** response header, value like `req_018EeWyXxfu5pfWkrYcMdjWG`.
- The same value appears as the **`request_id` field in error bodies**.
- SDK: `this.requestID = headers?.get('request-id')` `[FROM SDK TYPES]`
- The SDK also reads **`anthropic-workspace-id`** and **`anthropic-organization-id`** response headers.
- On Claude Platform on AWS there are two: `x-amzn-requestid` (primary, CloudTrail) and `request-id` (secondary).

---

## 5. Rate limit response headers

Exact header names, verbatim from the rate-limits doc:

| Header | Description |
|---|---|
| `retry-after` | **Seconds** to wait before retrying. Not sent with the spend-cap 429. |
| `anthropic-ratelimit-requests-limit` | Max requests allowed within any rate limit period. |
| `anthropic-ratelimit-requests-remaining` | Requests remaining before being rate limited. |
| `anthropic-ratelimit-requests-reset` | Time when the request limit fully replenishes, **RFC 3339**. |
| `anthropic-ratelimit-tokens-limit` | Max tokens allowed within any rate limit period. |
| `anthropic-ratelimit-tokens-remaining` | Tokens remaining (**rounded to the nearest thousand**). |
| `anthropic-ratelimit-tokens-reset` | Time when the token limit fully replenishes, RFC 3339. |
| `anthropic-ratelimit-input-tokens-limit` | Max input tokens allowed. |
| `anthropic-ratelimit-input-tokens-remaining` | Input tokens remaining (rounded to nearest thousand). |
| `anthropic-ratelimit-input-tokens-reset` | Input token limit reset time, RFC 3339. |
| `anthropic-ratelimit-output-tokens-limit` | Max output tokens allowed. |
| `anthropic-ratelimit-output-tokens-remaining` | Output tokens remaining (rounded to nearest thousand). |
| `anthropic-ratelimit-output-tokens-reset` | Output token limit reset time, RFC 3339. |
| `anthropic-priority-input-tokens-limit` / `-remaining` / `-reset` | Priority Tier only. |
| `anthropic-priority-output-tokens-limit` / `-remaining` / `-reset` | Priority Tier only. |

> The `anthropic-ratelimit-tokens-*` headers show **the most restrictive limit currently in effect**. Fast mode (research preview) additionally returns `anthropic-fast-*` headers.
> Rate limits exist in three dimensions: **RPM, ITPM, OTPM**, applied **per model**.

---

## 6. Streaming SSE event shapes

Set `"stream": true`. Each event has an SSE `event:` name that **matches the `type` field inside its `data:` payload**.

**Event order:** `message_start` → (per content block: `content_block_start`, N × `content_block_delta`, `content_block_stop`) → 1+ × `message_delta` → `message_stop`. `ping` events may appear anywhere.

### `message_start`

```
event: message_start
data: {"type": "message_start", "message": {"id": "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY", "type": "message", "role": "assistant", "content": [], "model": "claude-opus-5", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 25, "output_tokens": 1}}}
```
Carries a full `Message` with **`content: []`** and **`stop_reason: null`**.

### `content_block_start`

```
event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}
```
`index` maps to the block's position in the final `content` array. For `tool_use` the `content_block` is `{"type":"tool_use","id":"toolu_...","name":"...","input":{}}`.

### `ping`

```
event: ping
data: {"type": "ping"}
```
Any number may appear, anywhere.

### `content_block_delta`

```
event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}
```

All five delta variants `[FROM SDK TYPES]`:

```
{"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"location\": \"San Fra"}}
{"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta",    "thinking": "I need to find the GCD..."}}
{"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta",   "signature": "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds..."}}
{"type": "content_block_delta", "index": 0, "delta": {"type": "citations_delta",   "citation": {"type": "char_location", ...}}}
```

- `text_delta` → `text` (string)
- `input_json_delta` → `partial_json` — a **partial JSON string**; the final `tool_use.input` is an **object**. Accumulate then parse at `content_block_stop`.
- `thinking_delta` → `thinking`
- `signature_delta` → `signature` — sent **just before `content_block_stop`**; opaque integrity value.
- `citations_delta` → `citation` (union of `CitationCharLocation | CitationPageLocation | CitationContentBlockLocation | CitationsWebSearchResultLocation | CitationsSearchResultLocation`)

### `content_block_stop`

```
event: content_block_stop
data: {"type": "content_block_stop", "index": 0}
```

### `message_delta`

```
event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": null}, "usage": {"output_tokens": 15}}
```

> **The token counts in `message_delta.usage` are CUMULATIVE**, not per-event.
> **`message_delta.usage` is a different type from `message_start.usage`** — it uses `MessageDeltaUsage` `[FROM SDK TYPES]`:

```ts
export interface MessageDeltaUsage {
  output_tokens: number;                          // required
  input_tokens: number | null;                    // cumulative
  cache_creation_input_tokens: number | null;     // cumulative
  cache_read_input_tokens: number | null;         // cumulative
  output_tokens_details: OutputTokensDetails | null;
  server_tool_use: ServerToolUsage | null;
}
```
Note `MessageDeltaUsage` has **no** `service_tier`, `cache_creation`, or `inference_geo`.

### `message_stop`

```
event: message_stop
data: {"type": "message_stop"}
```

### `error`

Errors may arrive **after a 200 response** has already started. Shape:

```
event: error
data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
```
In this in-stream case there is **no `request_id`** and no HTTP status — the normal error handling does not apply.

### Full reference stream (verbatim from docs)

```
event: message_start
data: {"type": "message_start", "message": {"id": "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY", "type": "message", "role": "assistant", "content": [], "model": "claude-opus-5", "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 25, "output_tokens": 1}}}

event: content_block_start
data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}

event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "!"}}

event: content_block_stop
data: {"type": "content_block_stop", "index": 0}

event: message_delta
data: {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence":null}, "usage": {"output_tokens": 15}}

event: message_stop
data: {"type": "message_stop"}
```

**Versioning note:** since `2023-06-01`, all events are **named events** (with an `event:` line), completions are **incremental**, and there is **no `data: [DONE]`** sentinel. New event types may be added — **handle unknown events gracefully.**

---

## 7. Auth & version headers

| Header | Value |
|---|---|
| `x-api-key` | Your API key. The **SDK sends `X-Api-Key`** (HTTP header names are case-insensitive). `[FROM SDK TYPES]` |
| `anthropic-version` | **`2023-06-01`** — the **current and only required** value. |
| `anthropic-beta` | Optional. Comma-separated beta feature flags (e.g. `thinking-binding-controls-2026-08-01`). |
| `content-type` | `application/json` |

Verification of the version header:
- Docs `/en/api/versioning`: *"When making API requests, you must send an `anthropic-version` request header. For example, `anthropic-version: 2023-06-01`."*
- Version history lists only **two** versions: `2023-06-01` (current — new named SSE format, removed `exception`/`truncated`) and `2023-01-01` (initial release, deprecated).
- SDK default headers `[FROM SDK TYPES]`: `'anthropic-version': '2023-06-01'` — hardcoded.

The SDK also sets, by default: `Accept: application/json`, `User-Agent`, `X-Stainless-Retry-Count`, and optionally `X-Stainless-Timeout`, `anthropic-dangerous-direct-browser-access`.

Canonical cURL:

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-5","max_tokens":1024,"messages":[{"role":"user","content":"Hello, Claude"}]}'
```

---

## 8. Images in assistant messages — **NO**

**Anthropic's API does NOT support returning images in an assistant message content block.**

Direct evidence from the official vision FAQ:

> **"Can Claude generate or edit images?"**
> **"No, Claude is an image understanding model only. It can interpret and analyze images, but it cannot generate, produce, edit, manipulate, or create images."**

Corroborating evidence from the type system: the response `ContentBlock` union `[FROM SDK TYPES]` contains **no `image` member** — `image` appears only in the *request* side (`ImageBlockParam`, inside `ContentBlockParam`). Claude's models are **text-out only** with respect to images.

> ⚠️ **UNVERIFIED:** There is an `ImageBlockParam` in the request union and docs list `ImageBlockParam` among `ToolResultBlockParam.content` members — but no documented mechanism places an image block in an *assistant* turn. Any such support would be undocumented. A render/proxy that returns images in an assistant message will **not** be anthropic-compatible.

### Allowed image media types (image *input*)

Exactly four `[FROM SDK TYPES]`, quoted verbatim from `Base64ImageSource.media_type`:

```
'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
```

Docs confirm: *"Claude supports JPEG, PNG, GIF, and WebP images (`image/jpeg`, `image/png`, `image/gif`, `image/webp`). Animations are unsupported, and only the first frame is used."*

### Image size & count limits (image *input*)

| Limit | Value |
|---|---|
| Max size per image | **10 MB** (base64-encoded) on the Claude API direct; 5 MB on Bedrock/Google Cloud |
| Max dimensions per image | **8000 × 8000 px** |
| Max images per request | **100** for models with a 200k-token context window; **600** for all other models |
| Max images per message on claude.ai | 20 |
| Stricter dimension limit | When a request contains **> 20 images**, a stricter per-image dimension limit applies. To stay safe on all platforms: **resize so neither dimension exceeds 2000 px**, or keep to ≤ 20 image+document blocks. |

Counting rules: **all** `image` blocks count toward the threshold, including images resent from earlier turns and images nested inside `tool_result` content. On Bedrock/Google Cloud, document blocks (e.g. PDFs) also count.

Resolution/token cost: images are processed as 28×28 px **patches** (visual tokens): `⌈width / 28⌉ × ⌈height / 28⌉`.
- **High-resolution tier** (Claude 4.7+): max long edge **2576 px**, max **4784** visual tokens.
- **Standard tier** (all other models): max long edge **1568 px**, max **1568** visual tokens.

### `max_tokens` max values
**UNVERIFIED** — the docs state only *"Different models have different maximum values for this parameter"* and give no table. `max_tokens` accepts down to `0`.

---

## 9. Proxy implementation checklist

1. **Require `model`, `messages`, `max_tokens`**; return 400 `invalid_request_error` if any is missing.
2. **Emit `request-id`** on every response; echo it as top-level `request_id` in error bodies.
3. **Always wrap errors** as `{"type":"error","error":{"type":...,"message":...}}`, never a bare message.
4. **Use `anthropic-ratelimit-*` headers** with RFC 3339 `*-reset` values and `retry-after` in **seconds**.
5. **Never emit `data: [DONE]`**; use named SSE events whose `event:` name matches `data.type`.
6. **`message_start`** must have empty `content: []` and `stop_reason: null`.
7. **`message_delta.usage`** must be cumulative and use `MessageDeltaUsage` (no `service_tier`).
8. **Follow the real `stop_reason` enum** — including `pause_turn`, `refusal`, `model_context_window_exceeded`.
9. **Respond 529 `overloaded_error`** on overload — not 503.
10. **Never return an `image` block in assistant content**; Claude is understanding-only.
11. **Compute `input_tokens` post-cache-breakpoint**; sum cache fields for true total.
12. **Accept `anthropic-version: 2023-06-01`** and reject or tolerate others; clients hardcode it.
