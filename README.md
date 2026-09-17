<div align="center">

# RenderMind

**AI Text-to-Image API Proxy**

A unified REST API that orchestrates multiple image generation backends (Stable Diffusion, DALL-E 3, Flux) behind a single, consistent interface.

[![CI](https://github.com/quangminh1212/RenderMind/actions/workflows/ci.yml/badge.svg)](https://github.com/quangminh1212/RenderMind/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Getting Started](#-quick-start) · [API Reference](#-api-reference) · [Backends](#-supported-backends) · [Contributing](#-contributing)

</div>

---

## What is RenderMind?

RenderMind acts as a smart middleware layer that takes text prompts from your application and transforms them into stunning images by orchestrating multiple image generation backends. Instead of integrating with one specific image API, RenderMind provides a **unified interface** that abstracts away the complexity.

### Why RenderMind?

- **One API, many backends** — Switch between Stable Diffusion, DALL-E 3, and Flux without changing your client code
- **Smart routing** — Automatically selects the best backend based on prompt type and availability
- **Production-ready** — Rate limiting, caching, queue system, webhook callbacks, and monitoring out of the box
- **Type-safe** — Built with TypeScript and Zod validation for reliable request/response contracts

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Your App   │────▶│   RenderMind     │────▶│  Image Backends │
│  (Client)   │◀────│   (Proxy)        │◀────│  (SD/DALL-E/…)  │
└─────────────┘     │                  │     └─────────────────┘
                    │  ┌────────────┐  │
                    │  │   Redis    │  │
                    │  │ (Cache/Q)  │  │
                    │  └────────────┘  │
                    └──────────────────┘
```

## Features

| Feature | Description |
|---------|-------------|
| **Unified API** | Single RESTful endpoint for text-to-image generation |
| **Multi-Backend** | Connect to Stable Diffusion, DALL-E 3, Flux, or custom HTTP endpoints |
| **Smart Routing** | Auto-select the best backend based on prompt type and availability |
| **Batch Processing** | Generate up to 20 images in parallel with configurable concurrency |
| **Caching** | Avoid redundant generations with Redis-backed prompt caching |
| **Queue System** | Handle high-throughput with BullMQ job queuing |
| **Webhook Callbacks** | Get notified when async generations complete (with HMAC signatures) |
| **Rate Limiting** | Protect upstream APIs with configurable rate limits |
| **API Documentation** | Interactive Swagger UI at `/docs` |
| **Docker Ready** | Multi-stage Dockerfile with Redis in docker-compose |

## Quick Start

### Prerequisites

- **Node.js** >= 20.0.0
- **npm** >= 10.0.0
- **Redis** (optional, for caching and queue)

### Installation

```bash
# Clone the repository
git clone https://github.com/quangminh1212/RenderMind.git
cd RenderMind

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your API keys (at least one backend)

# Start development server
npm run dev
```

The server starts at `http://localhost:3000`. API documentation is available at `http://localhost:3000/docs`.

### Using Docker

```bash
# Build and start with Redis
docker-compose up -d

# Check logs
docker-compose logs -f rendermind
```

## API Reference

### Generate Image

```http
POST /api/v1/generate
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | string | ✅ | — | Text prompt (1-4000 chars) |
| `negative_prompt` | string | ❌ | — | Things to avoid (max 4000 chars) |
| `width` | integer | ❌ | `1024` | Image width (64-4096) |
| `height` | integer | ❌ | `1024` | Image height (64-4096) |
| `backend` | string | ❌ | `"auto"` | `"auto"`, `"stability"`, `"openclaw"`, `"replicate"` |
| `steps` | integer | ❌ | `30` | Inference steps (1-150) |
| `cfg_scale` | number | ❌ | `7.5` | Guidance scale (1-30) |
| `seed` | integer | ❌ | — | Random seed for reproducibility |
| `model` | string | ❌ | — | Specific model within the backend |
| `webhook_url` | string | ❌ | — | URL for completion webhook |

**Example:**

```bash
curl -X POST http://localhost:3000/api/v1/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A futuristic city at sunset, cyberpunk style",
    "negative_prompt": "blurry, low quality",
    "width": 1024,
    "height": 1024,
    "backend": "auto"
  }'
```

**Response:**

```json
{
  "id": "gen_a1b2c3d4e5f6",
  "status": "completed",
  "image_url": "https://...",
  "metadata": {
    "backend": "stability",
    "model": "stable-diffusion-xl-1024-v1-0",
    "generation_time_ms": 3200,
    "cached": false
  },
  "created_at": "2025-01-01T00:00:00.000Z"
}
```

### Batch Generate

```http
POST /api/v1/batch
Content-Type: application/json
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompts` | string[] | ✅ | Array of prompts (1-20) |
| `options.width` | integer | ❌ | Image width (default: 1024) |
| `options.height` | integer | ❌ | Image height (default: 1024) |
| `options.backend` | string | ❌ | Backend to use (default: "auto") |
| `options.parallel` | integer | ❌ | Max parallel (1-10, default: 3) |

### Get Status

```http
GET /api/v1/status/:id
```

### List Backends

```http
GET /api/v1/backends
```

### Health Check

```http
GET /health
```

## Supported Backends

| Backend | Status | Models | Configuration |
|---------|--------|--------|---------------|
| **Stable Diffusion** | ✅ Ready | SD XL 1.0, SD 1.6, SD Ultra | `STABILITY_API_KEY` |
| **DALL-E 3** | ✅ Ready | dall-e-3 | `OPENAI_API_KEY` |
| **Flux** | ✅ Ready | flux-1.1-pro, flux-schnell | `REPLICATE_API_TOKEN` |
| **Custom HTTP** | ✅ Ready | Any | `CUSTOM_BACKENDS` env |

## Configuration

All configuration is done via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server host |
| `NODE_ENV` | `development` | Environment mode |
| `STABILITY_API_KEY` | — | Stability AI API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `REPLICATE_API_TOKEN` | — | Replicate API token |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `CACHE_TTL` | `3600` | Cache TTL in seconds |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | Max requests per window |
| `QUEUE_CONCURRENCY` | `5` | Queue worker concurrency |
| `WEBHOOK_SECRET` | — | HMAC secret for webhook signatures |

## Tech Stack

- **Runtime:** [Node.js](https://nodejs.org) 20+
- **Language:** [TypeScript](https://www.typescriptlang.org) 5.x (strict mode)
- **Framework:** [Express](https://expressjs.com) 4.x
- **Validation:** [Zod](https://zod.dev)
- **Cache:** [ioredis](https://github.com/redis/ioredis) (Redis)
- **Queue:** [BullMQ](https://docs.bullmq.io)
- **Docs:** [Swagger UI](https://swagger.io/tools/swagger-ui) (OpenAPI 3.0)
- **Testing:** [Vitest](https://vitest.dev)
- **Linting:** [ESLint](https://eslint.org) + [Prettier](https://prettier.io)

## Development

```bash
npm run dev          # Start with hot reload
npm test             # Run tests
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run with coverage report
npm run lint         # Lint source files
npm run lint:fix     # Auto-fix lint issues
npm run typecheck    # Type check without emitting
npm run build        # Build for production
```

## Project Structure

```
src/
├── index.ts                 # Entry point & server startup
├── app.ts                   # Express app configuration
├── config/                  # Environment & backend config
├── middleware/               # Error handling, validation, rate limiting
├── routes/                  # API route handlers
│   └── v1/                  # Versioned API endpoints
├── services/                # Business logic & backend orchestrator
│   └── backends/            # Backend implementations
├── types/                   # TypeScript type definitions
└── utils/                   # Logger, ID generator, helpers
```

## Roadmap

- [x] Core API proxy
- [x] Multi-backend routing
- [x] Request validation & error handling
- [x] Redis caching
- [x] Rate limiting
- [x] Webhook callbacks
- [x] OpenAPI documentation
- [x] Docker deployment
- [x] CI/CD pipeline
- [ ] Web UI for prompt testing
- [ ] Style presets library
- [ ] Image-to-image support
- [ ] Inpainting endpoint
- [ ] Admin dashboard
- [ ] Image storage (S3/GCS)
- [ ] Authentication & API keys
- [ ] Usage analytics

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) © 2025 RenderMind Contributors

---

<div align="center">

**Built with care by the community.**

Star this repo if you find it useful!

</div>
