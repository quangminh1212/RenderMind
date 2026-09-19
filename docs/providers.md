# Providers

A **provider** is an outbound adapter that talks to one image-generation service. The
engine routes to providers through capability negotiation, so nothing in the request path
hardcodes which service is used.

## The one provider

| Name | Service | Required env |
|---|---|---|
| chat | Any chat-completions endpoint | `CHAT_API_KEY` |

RenderMind has a single upstream class by design: a model that speaks
`POST {CHAT_BASE_URL}/chat/completions` and is *instructed* to answer with an image. This
is the premise the engine is built on — most capable models have no image endpoint at all,
so the adapter is what makes them a source of images.

Point `CHAT_BASE_URL` at api.openai.com, Azure, LM Studio, LocalAI, OpenRouter, or any
compatible endpoint.

The provider registers only when `CHAT_API_KEY` is present. A base URL without a key does
**not** register, because advertising a provider that cannot be called means it gets
selected and then fails upstream on every request.

## How a chat model is made to answer with an image

The provider sends a system instruction that establishes a standing requirement, then
extracts the image from whatever the model actually returns. Four shapes are accepted,
tried in order, because models differ:

1. a `content` part carrying `image_url` (the multimodal shape)
2. a `data:image/...;base64,...` URI anywhere in the text
3. a bare image URL in the text (`.png`/`.jpg`/`.webp`, or a known CDN host)
4. a JSON object with `b64_json` / `image_base64` / `images[]`, emitted as text

A model that answers with prose and no image is a **terminal** failure
(`unsupported_output`, HTTP 422), never a silent empty success. The engine reports
honestly when the upstream cannot produce pixels; that is the point of the whole project.

## Capability declaration

Each provider declares a `CapabilityDescriptor`: models, supported sizes, output formats,
and which hint fields it can honour. The chat provider declares:

- `negativePrompt`, `seed`, `steps`, `guidanceScale`, `quality`, `style`, `batch`: **false**
  (folded into the instruction text, not sent as API fields — disclosed, not pretended).
- `imageToImage`: true when a vision model is configured.
- A wide size range `64..4096` (multiple of 8), because a chat model does not constrain
  output pixels; the requested size is carried in the instruction.

The capability matcher decides what can serve a request before dispatching, and the engine
records any adaptation in `AppliedAdaptations` rather than silently dropping it.

## Adding a provider

1. Implement `ImageProvider` (`isAvailable`, `getCapabilities`, `generate`).
2. Register it in `ProviderRegistry.fromConfig`.
3. Add its capability declaration so the matcher can rank it.

The dependency direction is one-way: **adapters → engine → providers**. A provider knows
only the canonical request and result, which is what lets a second provider class be added
without touching routing.
