# Migrating from 1.x to 2.x

2.0 rebuilds the request path and fixes several behaviours that were wrong. Most changes
are invisible if you used the native API; the exceptions are listed here.

## Client-visible breaking changes

### 1. Anthropic bridge requires model and max_tokens

The real Messages API requires both. 1.x accepted requests without them, so a client that
worked here could fail against Anthropic itself.

Before (accepted):

    { "messages": [{ "role": "user", "content": "a cat" }] }

Now (400 invalid_request_error):

    { "model": "claude-3-5-sonnet", "max_tokens": 1024,
      "messages": [{ "role": "user", "content": "a cat" }] }

### 2. Anthropic bridge returns a tool_use block by default

The Anthropic response ContentBlock union has no image member, so the 1.x image block was
invalid against the real specification and would fail strict client validation.

    { "content": [
        { "type": "text", "text": "Generated 1 image for: ..." },
        { "type": "tool_use", "id": "toolu_...", "name": "generate_image",
          "input": { "images": [{ "url": "https://..." }] } }
    ], "stop_reason": "tool_use" }

To keep the previous behaviour, set ANTHROPIC_IMAGE_BLOCK_MODE=extension. It remains
non-spec, so strict clients will still reject it.

### 3. openclaw responses omit _rendermind

The non-standard block broke strict response-schema validators. Set
OPENAI_RESPONSE_METADATA=true to restore it.

### 4. An invalid API key returns 401, not 403

Anthropic uses 401 for an invalid credential. A client branching on 403 should branch on
401 instead.

### 5. The cache is cold once

Cache keys changed format so entries written under the old scheme, which may be poisoned
by the collision bug, are never read again. Expect a 100% miss rate until it refills.

### 6. Health endpoint semantics

/health now reports liveness and returns 200 even when Redis is down. If you used it as a
readiness probe, switch to /readyz. This is a fix, not a regression: 1.x marked a fully
functional Redis-less deployment as unhealthy, and an orchestrator would restart it in a
loop.

## Configuration changes

| Before | After |
|---|---|
| No validation | Invalid values are a startup error naming each variable |
| Redis implicitly required | REDIS_URL is optional; readiness no longer requires it |
| Queue concurrency unused | MAX_GENERATION_CONCURRENCY caps global upstream calls |
| Open in production | ALLOW_UNAUTHENTICATED must be true to run without keys |
| Backends configured in code | CUSTOM_BACKENDS is read from the environment |

## Behavioural changes that are pure fixes

If you depended on any of these, the previous behaviour was wrong:

- A request differing only in negative_prompt, steps or cfg_scale no longer returns a
  cached image belonging to a different request.
- A request for n images returns n distinct images, not the same image n times.
- A b64_json request no longer receives a url in its place.
- An unknown provider is a 400, not a 502.
- A 4xx from upstream is not retried.
- A provider without an API key is not selected and then failed.
- Batch responses can report partial success.

## Upgrading checklist

1. Set API_KEYS if you have not, or explicitly set ALLOW_UNAUTHENTICATED=true.
2. If you parse the Anthropic bridge response, read the tool_use block rather than an
   image block.
3. If you branch on a 403 from auth, branch on 401.
4. Point readiness probes at /readyz.
5. Add OPENAI_RESPONSE_METADATA=true if anything depended on _rendermind.
