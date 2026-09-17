# RenderMind

**AI Text-to-Image API Proxy** — Convert any text-only AI API into a powerful image generation endpoint.

---

## What is RenderMind?

RenderMind acts as a smart middleware layer that takes text prompts from your application and transforms them into stunning images by orchestrating multiple image generation backends. Instead of integrating with one specific image API, RenderMind provides a **unified interface** that abstracts away the complexity.

## Features

- **Unified API** — Single RESTful endpoint for text-to-image generation
- **Multi-Backend Support** — Connect to Stable Diffusion, DALL-E, Flux, ComfyUI, and more
- **Smart Routing** — Automatically select the best backend based on prompt type
- **Batch Processing** — Generate multiple images in parallel
- **Caching** — Avoid redundant generations with intelligent prompt caching
- **Queue System** — Handle high-throughput with built-in job queuing
- **Webhook Callbacks** — Get notified when async generations complete
- **Rate Limiting** — Protect your upstream APIs from overload

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Your App   │────▶│  RenderMind  │────▶│  Image Backends │
│  (Client)   │◀────│  (Proxy)     │◀────│  (SD/DALL-E/...)│
└─────────────┘     └──────────────┘     └─────────────────┘
```

## Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/RenderMind.git
cd RenderMind

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys

# Start the server
npm run dev
```

## API Reference

### Generate Image

```http
POST /api/v1/generate
Content-Type: application/json

{
  "prompt": "A futuristic city at sunset, cyberpunk style",
  "negative_prompt": "blurry, low quality",
  "width": 1024,
  "height": 1024,
  "backend": "auto",
  "steps": 30,
  "cfg_scale": 7.5
}
```

**Response:**

```json
{
  "id": "gen_abc123",
  "status": "completed",
  "image_url": "https://...",
  "metadata": {
    "backend": "stable-diffusion",
    "model": "sd-xl-1.0",
    "generation_time_ms": 3200
  }
}
```

### Batch Generate

```http
POST /api/v1/batch
Content-Type: application/json

{
  "prompts": [
    "A serene mountain landscape",
    "An underwater coral reef with fish",
    "A cozy cabin in winter snow"
  ],
  "options": {
    "width": 1024,
    "height": 1024,
    "parallel": 3
  }
}
```

### Get Generation Status

```http
GET /api/v1/status/:id
```

## Supported Backends

| Backend | Status | Notes |
|---------|--------|-------|
| Stable Diffusion (local) | Ready | Via API or ComfyUI |
| DALL-E 3 | Ready | openclaw API |
| Flux | Ready | Replicate / local |
| Midjourney | Planned | Via proxy |
| Custom | Ready | Any HTTP endpoint |

## Configuration

```env
# Server
PORT=3000
HOST=0.0.0.0

# Backends
STABILITY_API_KEY=sk-...
OPENAI_API_KEY=sk-...
REPLICATE_API_TOKEN=r8_...

# Cache
REDIS_URL=redis://localhost:6379
CACHE_TTL=3600

# Queue
BULL_CONCURRENCY=5
```

## Roadmap

- [x] Core API proxy
- [x] Multi-backend routing
- [ ] Web UI for prompt testing
- [ ] Style presets library
- [ ] Image-to-image support
- [ ] Inpainting endpoint
- [ ] Admin dashboard
- [ ] Docker deployment

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Express / Fastify
- **Queue:** Bull (Redis)
- **Cache:** Redis
- **Docs:** OpenAPI / Swagger

## License

MIT © 2025

---

> Built with care by the community. Star this repo if you find it useful!
