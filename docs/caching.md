# Caching and generation records

## The cache key

A cache key is a SHA-256 over the **entire normalized canonical request**, serialized as
JSON, prefixed with `v2:`.

    v2:img:<32 hex characters>

### Why it is built that way

The previous implementation derived the key from a hand-picked argument list:
`prompt|width|height|backend|seed|model`. It omitted `negative_prompt`, `steps` and
`cfg_scale`. Two requests differing only in those fields produced the same key, so the
second caller was served the first caller's image. That is a correctness bug, not a
performance one, and it had no test.

The fix is structural rather than additive. Hashing the whole request means any field
added in future is covered by construction, so this class of bug cannot return.

The `v2:` prefix guarantees that a key written by the old scheme is never read back after
an upgrade, without needing to flush Redis on deploy.

### Deliberate exclusions

Two fields are excluded because they cannot change the produced pixels:

- `metadata` — caller bookkeeping such as user id and trace id.
- `callbackUrl` — where the result is delivered, not what is generated.
- `output.delivery` — base64 versus url is transport, not content.

`output.format` is included: a PNG and a JPEG of the same scene are different bytes.

Reference images participate. An image-to-image call is not the same as a text-to-image
call, so their keys differ.

## Three-state reads

A cache cannot distinguish "unavailable" from "miss" if both are reported as null, and
that ambiguity caused a real bug: a Redis blip produced a `200 completed` whose record was
never persisted, so `GET /api/v1/status/:id` then 404'd for an id the server had just
handed out.

Reads now return one of three outcomes:

- `hit` — the value was found.
- `miss` — the key is genuinely absent.
- `error` — the cache layer failed. Callers can treat this differently from a miss.

## In-memory fallback

Redis is **optional**. When it is absent or unreachable, writes go to an in-process map
with TTL eviction, and reads fall back to it. This is what makes generation records
retrievable without Redis.

The consequences are bounded deliberately: the fallback is per-process, so it does not
survive a restart and is not shared between replicas. It exists so that the documented
flow (generate, then poll status) works on a single-instance deployment without Redis. It
is not a durability guarantee. Run Redis if you need one.

## Generation records

A record moves through an explicit state machine:

    queued -> running -> succeeded
                      -> partial    (some of n sub-jobs failed)
                      -> failed
                      -> cancelled

`partial` exists because the previous status vocabulary could not express it. A batch in
which 19 of 20 prompts succeeded was reported as `failed`, hiding the 19 images that were
actually produced.

Each record also carries a monotonically increasing `version`, so a concurrent update
cannot silently clobber another, and a client can tell whether the state it read is still
current. It also records which provider was chosen, what adaptations were applied, and the
webhook delivery outcome.
